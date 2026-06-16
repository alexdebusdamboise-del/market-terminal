#!/usr/bin/env python3
"""
TERMINAL — a Bloomberg-Terminal-style market workstation.

Pure Python standard library (no pip installs). Acts as a same-origin proxy
to free, key-less financial data sources so the browser frontend gets real
market data without CORS or API-key friction.

Primary data source: Yahoo Finance public endpoints.
  - /v8/finance/chart/{symbol}   -> OHLCV time series + rich meta (no auth)
  - /v1/finance/search?q=         -> symbol search + news (no auth)
  - /v10/finance/quoteSummary/    -> fundamentals (needs a "crumb"; graceful)
  - /v7/finance/quote             -> batch quotes (needs a "crumb"; graceful)

Run:  python3 server.py [--port 8765]
Then open http://127.0.0.1:8765
"""

import argparse
import gzip
import hashlib
import io
import json
import math
import os
import random
import re
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
import http.cookiejar
import email.utils
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# ---------------------------------------------------------------------------
# Tiny TTL cache
# ---------------------------------------------------------------------------
class TTLCache:
    def __init__(self):
        self._d = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            v = self._d.get(key)
            if not v:
                return None
            exp, data = v
            if time.time() > exp:
                self._d.pop(key, None)
                return None
            return data

    def set(self, key, data, ttl):
        with self._lock:
            self._d[key] = (time.time() + ttl, data)

CACHE = TTLCache()

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def _http_get(url, jar=None, timeout=20):
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "en-US,en;q=0.9",
    }
    req = urllib.request.Request(url, headers=headers)
    if jar is not None:
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        resp = opener.open(req, timeout=timeout)
    else:
        resp = urllib.request.urlopen(req, timeout=timeout)
    with resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", "replace"), resp.status


def _json_get(url, jar=None, timeout=20):
    text, _ = _http_get(url, jar=jar, timeout=timeout)
    return json.loads(text)


YAHOO_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")

# When Yahoo rate-limits us (HTTP 429), arm a short cooldown during which we
# serve the labelled simulated fallback instantly instead of waiting on long
# backoffs for every symbol — and we stop hammering the upstream. Live data
# resumes automatically once the cooldown lapses and a probe succeeds.
YAHOO_CD = {"until": 0.0}
YAHOO_CD_SECS = 120


def _yahoo_json(path_and_query, jar=None, retries=3):
    """GET a Yahoo Finance JSON path, rotating hosts. Fails fast (and arms a
    global cooldown) on 429 so the app stays snappy; retries transient 5xx."""
    if YAHOO_CD["until"] > time.time():
        raise RuntimeError("yahoo cooldown active")
    last_exc = None
    delay = 0.4
    for attempt in range(retries):
        host = YAHOO_HOSTS[attempt % len(YAHOO_HOSTS)]
        url = f"https://{host}{path_and_query}"
        try:
            data = _json_get(url, jar=jar)
            YAHOO_CD["until"] = 0.0  # healthy again
            return data
        except urllib.error.HTTPError as e:
            last_exc = e
            if e.code == 429:
                YAHOO_CD["until"] = time.time() + YAHOO_CD_SECS
                raise
            if e.code in (500, 502, 503, 504):
                time.sleep(delay); delay *= 2
                continue
            raise
        except Exception as e:  # network blip
            last_exc = e
            time.sleep(delay); delay *= 2
    if last_exc:
        raise last_exc
    raise RuntimeError("yahoo request failed")


# ---------------------------------------------------------------------------
# Crumb / auth manager (for fundamentals + batch quotes). Graceful: if it
# cannot get a crumb (rate limited, etc.) callers fall back to chart-derived
# data and the UI degrades cleanly.
# ---------------------------------------------------------------------------
class Crumb:
    def __init__(self):
        self._lock = threading.Lock()
        self.jar = None
        self.crumb = None
        self.blocked_until = 0

    def _refresh(self):
        jar = http.cookiejar.CookieJar()
        # seed consent cookies
        try:
            _http_get("https://finance.yahoo.com/quote/AAPL/", jar=jar, timeout=15)
        except Exception:
            pass
        crumb = None
        for host in ("query2", "query1"):
            try:
                text, status = _http_get(
                    f"https://{host}.finance.yahoo.com/v1/test/getcrumb",
                    jar=jar, timeout=15)
                if status == 200 and text and "<" not in text and len(text) < 40:
                    crumb = text.strip()
                    break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    # backed off — try again later
                    self.blocked_until = time.time() + 600
            except Exception:
                pass
        if crumb:
            self.jar, self.crumb = jar, crumb
        return crumb

    def get(self, force=False):
        with self._lock:
            if self.blocked_until > time.time() and not force:
                return None, None
            if self.crumb and not force:
                return self.crumb, self.jar
            c = self._refresh()
            return c, self.jar

CRUMB = Crumb()

# ---------------------------------------------------------------------------
# Optional real-time data provider (Twelve Data). Plug a free API key via the
# TWELVEDATA_API_KEY env var or a config.json next to this file:
#     {"twelvedata_key": "xxxx"}
# When a key is set, chart/quote requests try the provider FIRST (true,
# un-delayed data, not subject to Yahoo's IP rate limits) and fall back to
# Yahoo -> simulated on any error. Free tier is ~8 req/min, so bulk monitor
# panels may fall back to Yahoo — the focused security view is the sweet spot.
# ---------------------------------------------------------------------------
def _load_keys():
    td = os.environ.get("TWELVEDATA_API_KEY", "").strip()
    fh = os.environ.get("FINNHUB_API_KEY", "").strip()
    cfg = os.path.join(ROOT, "config.json")
    if os.path.exists(cfg):
        try:
            with open(cfg) as f:
                j = json.load(f)
            td = td or (j.get("twelvedata_key") or "").strip()
            fh = fh or (j.get("finnhub_key") or "").strip()
        except Exception:
            pass
    return td, fh

TD_KEY, FH_KEY = _load_keys()

TD_MAP = {  # yahoo range -> (td interval, outputsize, intraday)
    "1d": ("5min", 78, True), "5d": ("30min", 170, True), "1mo": ("1day", 23, False),
    "6mo": ("1day", 130, False), "ytd": ("1day", 180, False), "1y": ("1day", 260, False),
    "5y": ("1week", 260, False), "max": ("1month", 400, False),
}


TD_FUTURES = {"GC=F": "XAU/USD", "SI=F": "XAG/USD"}  # metals available on free tier


def _td_symbol(sym):
    """Map a Yahoo-style symbol to a Twelve Data symbol, or None if unsupported."""
    if sym in TD_FUTURES:
        return TD_FUTURES[sym]
    if sym.endswith("=X"):
        base = sym[:-2]
        return base[:3] + "/" + base[3:6] if len(base) >= 6 else None
    if sym.endswith("-USD"):
        return sym[:-4] + "/USD"
    if re.fullmatch(r"[A-Z]{1,6}", sym):
        return sym
    return None


def _td_summary(symbol):
    """Real fundamentals + profile from Twelve Data (available on free tier)."""
    st = _td_get(f"https://api.twelvedata.com/statistics?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(TD_KEY)}")
    if not isinstance(st, dict) or "statistics" not in st:
        return None
    s = st["statistics"]
    vm = s.get("valuations_metrics", {}) or {}
    fin = s.get("financials", {}) or {}
    inc = fin.get("income_statement", {}) or {}
    bs = fin.get("balance_sheet", {}) or {}
    sp = s.get("stock_price_summary", {}) or {}
    dv = s.get("dividends_and_splits", {}) or {}
    ss = s.get("stock_statistics", {}) or {}
    stats = {
        "marketCap": vm.get("market_capitalization"), "enterpriseValue": vm.get("enterprise_value"),
        "trailingPE": vm.get("trailing_pe"), "forwardPE": vm.get("forward_pe"), "peg": vm.get("peg_ratio"),
        "priceToSales": vm.get("price_to_sales_ttm"), "priceToBook": vm.get("price_to_book_mrq"),
        "revenue": inc.get("revenue_ttm"), "ebitda": inc.get("ebitda"), "eps": inc.get("diluted_eps_ttm"),
        "grossMargin": fin.get("gross_margin"), "operatingMargin": fin.get("operating_margin"),
        "profitMargin": fin.get("profit_margin"), "roe": fin.get("return_on_equity_ttm"),
        "totalCash": bs.get("total_cash_mrq"), "totalDebt": bs.get("total_debt_mrq"),
        "dividendYield": dv.get("forward_annual_dividend_yield"), "payoutRatio": dv.get("payout_ratio"),
        "beta": sp.get("beta"), "sharesOut": ss.get("shares_outstanding"),
        "fiftyTwoWeekChange": sp.get("fifty_two_week_change"), "targetMean": None, "recommendation": None,
    }
    profile = {}
    pr = _td_get(f"https://api.twelvedata.com/profile?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(TD_KEY)}")
    if isinstance(pr, dict) and pr.get("status") != "error":
        profile = {
            "sector": pr.get("sector"), "industry": pr.get("industry"),
            "employees": pr.get("employees"), "website": pr.get("website"),
            "hq": ", ".join([x for x in [pr.get("city"), pr.get("state"), pr.get("country")] if x]),
            "description": pr.get("description"),
        }
    earnings = []
    ed = _td_get(f"https://api.twelvedata.com/earnings?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(TD_KEY)}")
    if isinstance(ed, dict) and isinstance(ed.get("earnings"), list):
        for e in ed["earnings"][:8]:
            earnings.append({"date": e.get("date"), "epsEstimate": e.get("eps_estimate"),
                             "epsActual": e.get("eps_actual"), "surprisePct": e.get("surprise_prc")})
    return {"available": True, "source": "twelvedata", "stats": stats,
            "profile": profile, "earnings": earnings}


# Twelve Data free tier is ~8 req/min; when we exceed it (HTTP 429 or an
# error body about credits) back off for ~65s and use Yahoo/sim instead.
TD_CD = {"until": 0.0}


def _td_get(url):
    if TD_CD["until"] > time.time():
        return None
    try:
        data = _json_get(url)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            TD_CD["until"] = time.time() + 65
        return None
    except Exception:
        return None
    if isinstance(data, dict) and data.get("status") == "error":
        if data.get("code") == 429 or "credit" in str(data.get("message", "")).lower():
            TD_CD["until"] = time.time() + 65
        return None
    return data


YINT_TO_TD = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h",
              "1d": "1day", "1wk": "1week", "1mo": "1month"}


def _twelvedata_chart(symbol, tsym, td_int, outsize):
    url = ("https://api.twelvedata.com/time_series?symbol=" + urllib.parse.quote(tsym)
           + f"&interval={td_int}&outputsize={outsize}&order=ASC&apikey={urllib.parse.quote(TD_KEY)}")
    data = _td_get(url)
    if not isinstance(data, dict) or "values" not in data:
        return None
    candles = []
    for v in data["values"]:
        try:
            dt = v["datetime"]
            fmt = "%Y-%m-%d %H:%M:%S" if " " in dt else "%Y-%m-%d"
            ts = int(time.mktime(time.strptime(dt, fmt)))
            c = float(v["close"])
            candles.append({"t": ts, "o": float(v.get("open", c)), "h": float(v.get("high", c)),
                            "l": float(v.get("low", c)), "c": c, "v": int(float(v.get("volume", 0) or 0))})
        except Exception:
            continue
    if not candles:
        return None
    last, prev = candles[-1]["c"], (candles[-2]["c"] if len(candles) > 1 else candles[-1]["c"])
    hi52 = max(c["h"] for c in candles)
    lo52 = min(c["l"] for c in candles)
    return {
        "symbol": symbol, "currency": (data.get("meta") or {}).get("currency", "USD"),
        "exchangeName": (data.get("meta") or {}).get("exchange", "Twelve Data"),
        "instrumentType": (data.get("meta") or {}).get("type"), "shortName": None, "longName": None,
        "regularMarketPrice": last, "previousClose": prev,
        "regularMarketDayHigh": candles[-1]["h"], "regularMarketDayLow": candles[-1]["l"],
        "regularMarketVolume": candles[-1]["v"], "fiftyTwoWeekHigh": hi52, "fiftyTwoWeekLow": lo52,
        "regularMarketTime": candles[-1]["t"], "candles": candles, "source": "live",
    }


# ---------------------------------------------------------------------------
# Simulated fallback (only used when the live upstream is unreachable / rate
# limited). Always clearly labelled with source="sim" so the UI can warn the
# user and auto-switch back to live data the moment it returns.
# ---------------------------------------------------------------------------
SIM_ANCHORS = {
    "^GSPC": 5950, "^DJI": 43200, "^IXIC": 19400, "^RUT": 2280, "^VIX": 14.5,
    "^FTSE": 8240, "^GDAXI": 19800, "^FCHI": 7550, "^STOXX50E": 4980,
    "^N225": 38500, "^HSI": 19600,
    "EURUSD=X": 1.082, "GBPUSD=X": 1.272, "USDJPY=X": 156.4, "USDCHF=X": 0.895,
    "AUDUSD=X": 0.662, "USDCAD=X": 1.368, "USDCNY=X": 7.24,
    "GC=F": 2630, "SI=F": 30.8, "CL=F": 71.4, "BZ=F": 75.1, "NG=F": 3.05,
    "HG=F": 4.15, "ZC=F": 432,
    "^IRX": 4.42, "^FVX": 4.18, "^TNX": 4.34, "^TYX": 4.51,
    "BTC-USD": 67500, "ETH-USD": 3480, "SOL-USD": 178, "XRP-USD": 0.61,
    "BNB-USD": 605, "DOGE-USD": 0.158, "ADA-USD": 0.44,
    "AAPL": 232, "MSFT": 428, "NVDA": 138, "AMZN": 205, "GOOGL": 178,
    "META": 585, "TSLA": 248, "BRK-B": 462, "JPM": 242, "V": 308,
}
SIM_STEP = {  # (num_points, step_seconds, intraday)
    "1d": (78, 300, True), "5d": (65, 1800, True), "1mo": (22, 86400, False),
    "6mo": (126, 86400, False), "ytd": (115, 86400, False), "1y": (252, 86400, False),
    "5y": (260, 604800, False), "max": (240, 2592000, False),
}


def _synth_chart(symbol, rng="6mo", interval="1d"):
    seed = int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)
    rnd = random.Random(seed)
    npts, step, intraday = SIM_STEP.get(rng, SIM_STEP["6mo"])
    base = SIM_ANCHORS.get(symbol)
    if base is None:
        base = round(20 + (seed % 38000) / 100.0, 2)
    vol = 0.012 if base > 5 else 0.006
    now = int(time.time())
    start = now - npts * step
    price = base * (1 - rnd.uniform(-0.08, 0.18))
    candles = []
    for i in range(npts):
        drift = (base - price) * 0.015
        chg = rnd.gauss(0, 1) * vol * price + drift
        o = price
        c = max(0.0001, price + chg)
        hi = max(o, c) * (1 + abs(rnd.gauss(0, 1)) * vol * 0.6)
        lo = min(o, c) * (1 - abs(rnd.gauss(0, 1)) * vol * 0.6)
        v = int(abs(rnd.gauss(1, 0.4)) * (5_000_000 if base > 5 else 50_000_000))
        candles.append({"t": start + i * step, "o": round(o, 4), "h": round(hi, 4),
                        "l": round(lo, 4), "c": round(c, 4), "v": v})
        price = c
    last = candles[-1]["c"] if candles else base
    prev = candles[-2]["c"] if len(candles) > 1 else base
    hi52 = max(c["h"] for c in candles) if candles else base
    lo52 = min(c["l"] for c in candles) if candles else base
    return {
        "symbol": symbol, "currency": "USD", "exchangeName": "SIMULATED",
        "instrumentType": None, "shortName": None, "longName": None,
        "regularMarketPrice": round(last, 4), "previousClose": round(prev, 4),
        "regularMarketDayHigh": round(max(last, prev) * 1.004, 4),
        "regularMarketDayLow": round(min(last, prev) * 0.996, 4),
        "regularMarketVolume": candles[-1]["v"] if candles else 0,
        "fiftyTwoWeekHigh": round(hi52, 4), "fiftyTwoWeekLow": round(lo52, 4),
        "regularMarketTime": now, "candles": candles, "source": "sim",
    }


# ---------------------------------------------------------------------------
# Data fetchers
# ---------------------------------------------------------------------------
def fetch_chart(symbol, rng="6mo", interval="1d", use_provider=False, full=False):
    key = f"chart:{symbol}:{'full-' + interval if full else rng + ':' + interval}"
    cached = CACHE.get(key)
    if cached:
        return cached
    # 0) crypto -> CoinGecko OHLC (accurate; full -> entire daily history)
    if _is_crypto(symbol):
        cg = _coingecko_chart(symbol, rng, interval, full)
        if cg:
            CACHE.set(key, cg, 60 if rng in ("1d", "5d") else 180)
            return cg
    # 1) real-time provider first — only for the focused security view, to stay
    #    within the free-tier rate limit (bulk monitor/heatmap use Yahoo/sim).
    if use_provider and TD_KEY:
        tsym = _td_symbol(symbol)
        if tsym:
            if full:  # load deep history at the chosen granularity (up to 5000 pts)
                td_int, outsize = YINT_TO_TD.get(interval, "1day"), 5000
            else:
                td_int, outsize, _ = TD_MAP.get(rng, TD_MAP["6mo"])
            td = _twelvedata_chart(symbol, tsym, td_int, outsize)
            if td:
                CACHE.set(key, td, 20 if rng in ("1d", "5d") else 120)
                return td
    # Yahoo: full mode -> max history (daily) or 60d (intraday)
    yrng = rng
    if full:
        yrng = "max" if interval in ("1d", "1wk", "1mo") else "60d"
    sym = urllib.parse.quote(symbol)
    pathq = (f"/v8/finance/chart/{sym}"
             f"?range={yrng}&interval={interval}&includePrePost=false&events=div,split")
    try:
        data = _yahoo_json(pathq)
        result = data["chart"]["result"][0]
    except Exception:
        # live feed unreachable / rate limited -> labelled simulated fallback
        out = _synth_chart(symbol, rng, interval)
        CACHE.set(key, out, 15)
        return out
    meta = result.get("meta", {})
    ts = result.get("timestamp", []) or []
    q = (result.get("indicators", {}).get("quote", [{}]) or [{}])[0]
    opens = q.get("open", []) or []
    highs = q.get("high", []) or []
    lows = q.get("low", []) or []
    closes = q.get("close", []) or []
    vols = q.get("volume", []) or []
    candles = []
    for i in range(len(ts)):
        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        l = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        v = vols[i] if i < len(vols) else None
        if c is None:
            continue
        candles.append({
            "t": ts[i],
            "o": o if o is not None else c,
            "h": h if h is not None else c,
            "l": l if l is not None else c,
            "c": c,
            "v": v if v is not None else 0,
        })
    out = {
        "symbol": meta.get("symbol", symbol),
        "currency": meta.get("currency"),
        "exchangeName": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "instrumentType": meta.get("instrumentType"),
        "timezone": meta.get("timezone"),
        "gmtoffset": meta.get("gmtoffset"),
        "shortName": meta.get("shortName"),
        "longName": meta.get("longName"),
        "regularMarketPrice": meta.get("regularMarketPrice"),
        "previousClose": meta.get("chartPreviousClose") or meta.get("previousClose"),
        "regularMarketDayHigh": meta.get("regularMarketDayHigh"),
        "regularMarketDayLow": meta.get("regularMarketDayLow"),
        "regularMarketVolume": meta.get("regularMarketVolume"),
        "fiftyTwoWeekHigh": meta.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow": meta.get("fiftyTwoWeekLow"),
        "regularMarketTime": meta.get("regularMarketTime"),
        "candles": candles,
        "source": "live",
    }
    ttl = 20 if interval in ("1m", "2m", "5m") else 120
    CACHE.set(key, out, ttl)
    return out


def _quote_from_chart(symbol):
    """Light quote derived from the chart endpoint (no auth required)."""
    try:
        d = fetch_chart(symbol, rng="1d", interval="1d")
    except Exception:
        try:
            d = fetch_chart(symbol, rng="5d", interval="1d")
        except Exception:
            return {"symbol": symbol, "error": True}
    price = d.get("regularMarketPrice")
    prev = d.get("previousClose")
    # if intraday/regular price missing, use last candle close
    if price is None and d.get("candles"):
        price = d["candles"][-1]["c"]
    chg = pct = None
    if price is not None and prev:
        chg = price - prev
        pct = (chg / prev * 100) if prev else None
    return {
        "symbol": d.get("symbol", symbol),
        "shortName": d.get("shortName") or d.get("longName"),
        "price": price,
        "previousClose": prev,
        "change": chg,
        "changePct": pct,
        "currency": d.get("currency"),
        "exchange": d.get("exchangeName"),
        "dayHigh": d.get("regularMarketDayHigh"),
        "dayLow": d.get("regularMarketDayLow"),
        "volume": d.get("regularMarketVolume"),
        "fiftyTwoWeekHigh": d.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow": d.get("fiftyTwoWeekLow"),
        "marketTime": d.get("regularMarketTime"),
        "source": d.get("source", "live"),
    }


# ---------------------------------------------------------------------------
# CNBC quote service — key-less, batchable, real-time quotes for stocks,
# indices, FX, crypto and commodities (plus 52-week range & fundamentals).
# This powers all the bulk views (monitor, heatmap, screener, watchlist,
# compare) with REAL prices that move on each refresh — no API key, no quota.
# ---------------------------------------------------------------------------
CNBC_MAP = {
    # US & world indices
    "^GSPC": ".SPX", "^DJI": ".DJI", "^IXIC": ".IXIC", "^RUT": ".RUT", "^VIX": ".VIX",
    "^NDX": ".NDX", "^SOX": ".SOX", "^NYA": ".NYA", "^OEX": ".OEX", "^DJT": ".DJT", "^DJU": ".DJU",
    "^FTSE": ".FTSE", "^GDAXI": ".GDAXI", "^FCHI": ".FCHI", "^STOXX50E": ".STOXX50E",
    "^SSMI": ".SSMI", "^IBEX": ".IBEX", "^AEX": ".AEX", "^OMX": ".OMXS30",
    "^N225": ".N225", "^HSI": ".HSI", "^KS11": ".KS11", "^TWII": ".TWII", "^AXJO": ".AXJO",
    "^NSEI": ".NSEI", "^BVSP": ".BVSP", "^GSPTSE": ".GSPTSE", "^MXX": ".MXX", "^STI": ".STI",
    # rates / yields
    "^TNX": "US10Y", "^TYX": "US30Y", "^FVX": "US5Y", "^IRX": "US3M",
    "US2Y": "US2Y", "US1Y": "US1Y", "US6M": "US6M",
    "DE10Y": "DE10Y", "GB10Y": "GB10Y", "JP10Y": "JP10Y",
    # commodities (front-month futures)
    "GC=F": "@GC.1", "SI=F": "@SI.1", "CL=F": "@CL.1", "BZ=F": "@LCO.1",
    "NG=F": "@NG.1", "HG=F": "@HG.1", "ZC=F": "@C.1",
    "PL=F": "@PL.1", "PA=F": "@PA.1", "HO=F": "@HO.1", "RB=F": "@RB.1",
    "ZW=F": "@W.1", "ZS=F": "@S.1", "KC=F": "@KC.1", "SB=F": "@SB.1", "CT=F": "@CT.1",
    # FX crosses (vs-USD pairs are handled generically)
    "EURGBP=X": "EURGBP=", "EURJPY=X": "EURJPY=", "GBPJPY=X": "GBPJPY=",
    # share classes
    "BRK-B": "BRK.B", "BF-B": "BF.B",
}


def _cnbc_symbol(y):
    if y in CNBC_MAP:
        return CNBC_MAP[y]
    if y.endswith("=X"):
        base = y[:-2]
        if len(base) >= 6:
            a, b = base[:3], base[3:6]
            return (b if a == "USD" else a) + "="
        return None
    if y.endswith("-USD"):
        return y[:-4] + ".CC="  # CoinDesk crypto feed (covers BTC/ETH/SOL/XRP/DOGE/ADA/BNB…)
    if re.fullmatch(r"[A-Z]{1,6}", y):
        return y
    return None


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _cnbc_get(symstr):
    url = ("https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols="
           + urllib.parse.quote(symstr) + "&requestMethod=quick&fund=1&exthrs=1&output=json")
    headers = {"User-Agent": UA, "Accept": "application/json,*/*", "Referer": "https://www.cnbc.com/"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", "replace"))


def _cnbc_norm(y, q):
    last = _f(q.get("last"))
    if last is None:
        return None
    prev = _f(q.get("previous_day_closing")) or _f(q.get("prev_prev_closing"))
    chg = _f(q.get("change"))
    pct = _f(q.get("change_pct"))
    if prev is None and chg is not None:
        prev = last - chg
    fd = q.get("FundamentalData", {}) or {}
    return {
        "symbol": y, "shortName": q.get("name") or q.get("shortName"),
        "price": last, "previousClose": prev, "change": chg, "changePct": pct,
        "currency": q.get("currencyCode"), "exchange": q.get("exchange"),
        "dayHigh": _f(q.get("high")), "dayLow": _f(q.get("low")),
        "volume": _f(q.get("volume")) or _f(q.get("fullVolume")),
        "fiftyTwoWeekHigh": _f(fd.get("yrhiprice")), "fiftyTwoWeekLow": _f(fd.get("yrloprice")),
        "source": "live",
    }


def _cnbc_quotes(symbols):
    pairs = [(y, _cnbc_symbol(y)) for y in symbols]
    pairs = [(y, c) for (y, c) in pairs if c]
    out = {}
    for i in range(0, len(pairs), 40):
        chunk = pairs[i:i + 40]
        symstr = "|".join(c for _, c in chunk)
        try:
            data = _cnbc_get(symstr)
        except Exception:
            continue
        qq = (data.get("QuickQuoteResult", {}) or {}).get("QuickQuote", [])
        if isinstance(qq, dict):
            qq = [qq]
        by = {}
        for q in qq:
            by[q.get("symbol")] = q
        for y, c in chunk:
            q = by.get(c)
            if q:
                n = _cnbc_norm(y, q)
                if n:
                    out[y] = n
    return out


def _cnbc_summary(symbol):
    """Fundamentals from CNBC FundamentalData — key-less, no quota, reliable.
    Powers KEY STATISTICS for any stock/ADR."""
    csym = _cnbc_symbol(symbol)
    if not csym:
        return None
    try:
        data = _cnbc_get(csym)
    except Exception:
        return None
    qq = (data.get("QuickQuoteResult", {}) or {}).get("QuickQuote", [])
    if isinstance(qq, dict):
        qq = [qq]
    if not qq:
        return None
    fd = qq[0].get("FundamentalData", {}) or {}
    if not fd:
        return None

    def frac(k):  # CNBC gives margins/ROE as percent values -> fraction
        v = _f(fd.get(k))
        return v / 100.0 if v is not None else None
    ebitda = _f(fd.get("TTMEBITD"))
    stats = {
        "marketCap": _f(fd.get("mktcap")), "enterpriseValue": None,
        "trailingPE": _f(fd.get("pe")), "forwardPE": _f(fd.get("fpe")), "peg": None,
        "priceToSales": _f(fd.get("psales")), "priceToBook": None,
        "revenue": _f(fd.get("revenuettm")), "ebitda": (ebitda * 1e6 if ebitda is not None else None),
        "grossMargin": frac("GROSMGNTTM"), "operatingMargin": None, "profitMargin": frac("NETPROFTTM"),
        "roe": frac("ROETTM"), "eps": _f(fd.get("eps")), "totalCash": None, "totalDebt": None,
        "dividendYield": _f(fd.get("dividendyield")), "payoutRatio": None,
        "beta": _f(fd.get("beta")), "sharesOut": _f(fd.get("sharesout")),
        "fiftyTwoWeekChange": _f(fd.get("yragopricechangepct")),
        "targetMean": None, "recommendation": None,
    }
    if all(v is None for v in stats.values()):
        return None
    q0 = qq[0]
    profile = {
        "name": q0.get("name"), "exchange": q0.get("exchange"),
        "country": q0.get("countryCode"), "currency": q0.get("currencyCode"),
        "assetType": (q0.get("assetSubType") or q0.get("assetType")),
    }
    return {"available": True, "source": "cnbc", "stats": stats, "profile": profile, "earnings": []}


def _td_profile_earnings(symbol):
    """Company profile + recent earnings from Twelve Data (2 light calls)."""
    profile, earnings = {}, []
    pr = _td_get(f"https://api.twelvedata.com/profile?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(TD_KEY)}")
    if isinstance(pr, dict) and pr.get("status") != "error":
        profile = {
            "sector": pr.get("sector"), "industry": pr.get("industry"),
            "employees": pr.get("employees"), "website": pr.get("website"),
            "hq": ", ".join([x for x in [pr.get("city"), pr.get("state"), pr.get("country")] if x]),
            "description": pr.get("description"),
        }
    ed = _td_get(f"https://api.twelvedata.com/earnings?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(TD_KEY)}")
    if isinstance(ed, dict) and isinstance(ed.get("earnings"), list):
        for e in ed["earnings"][:8]:
            earnings.append({"date": e.get("date"), "epsEstimate": e.get("eps_estimate"),
                             "epsActual": e.get("eps_actual"), "surprisePct": e.get("surprise_prc")})
    return profile, earnings


def _td_analyst(symbol):
    """Analyst price targets + recommendation distribution from Twelve Data."""
    out = {}
    pt = _td_get(f"https://api.twelvedata.com/price_target?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(TD_KEY)}")
    if isinstance(pt, dict) and isinstance(pt.get("price_target"), dict):
        p = pt["price_target"]
        out.update({"targetMean": _f(p.get("average")), "targetHigh": _f(p.get("high")),
                    "targetLow": _f(p.get("low")), "targetMedian": _f(p.get("median")),
                    "current": _f(p.get("current"))})
    rc = _td_get(f"https://api.twelvedata.com/recommendations?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(TD_KEY)}")
    if isinstance(rc, dict):
        tr = (rc.get("trends") or {}).get("current_month") or {}
        if tr:
            out["dist"] = {"strongBuy": tr.get("strong_buy", 0) or 0, "buy": tr.get("buy", 0) or 0,
                           "hold": tr.get("hold", 0) or 0, "sell": tr.get("sell", 0) or 0,
                           "strongSell": tr.get("strong_sell", 0) or 0}
        if rc.get("rating") is not None:
            out["rating"] = rc.get("rating")
    return out or None


# ---------------------------------------------------------------------------
# CoinGecko — accurate, key-less crypto data: real-time price + 24h change,
# market cap / supply / ATH, and OHLC history out to 5 years. Powers crypto
# quotes, charts and the "analysis" panel.
# ---------------------------------------------------------------------------
CG_IDS = {
    "BTC-USD": "bitcoin", "ETH-USD": "ethereum", "BNB-USD": "binancecoin", "SOL-USD": "solana",
    "XRP-USD": "ripple", "ADA-USD": "cardano", "DOGE-USD": "dogecoin", "AVAX-USD": "avalanche-2",
    "LINK-USD": "chainlink", "DOT-USD": "polkadot", "LTC-USD": "litecoin", "BCH-USD": "bitcoin-cash",
    "TRX-USD": "tron", "XLM-USD": "stellar", "UNI-USD": "uniswap", "SHIB-USD": "shiba-inu",
}
CG_DAYS = {"1d": 1, "5d": 7, "1mo": 30, "6mo": 180, "ytd": 365, "1y": 365, "5y": 1825, "max": "max"}


def _is_crypto(sym):
    return sym in CG_IDS


def _cg_get(path):
    return _json_get("https://api.coingecko.com/api/v3" + path)


def _coingecko_quotes(symbols):
    ids = [CG_IDS[s] for s in symbols if s in CG_IDS]
    if not ids:
        return {}
    try:
        d = _cg_get("/simple/price?ids=" + ",".join(ids)
                    + "&vs_currencies=usd&include_market_cap=true&include_24hr_change=true&include_24hr_vol=true")
    except Exception:
        return {}
    id2sym = {CG_IDS[s]: s for s in symbols if s in CG_IDS}
    out = {}
    for cid, info in (d or {}).items():
        sym = id2sym.get(cid)
        if not sym:
            continue
        price, chg = info.get("usd"), info.get("usd_24h_change")
        prev = (price / (1 + chg / 100)) if (price is not None and chg is not None) else None
        out[sym] = {
            "symbol": sym, "shortName": sym.replace("-USD", ""), "price": price,
            "previousClose": prev, "change": (price - prev) if (price is not None and prev is not None) else None,
            "changePct": chg, "currency": "USD", "exchange": "Crypto",
            "marketCap": info.get("usd_market_cap"), "volume": info.get("usd_24h_vol"),
            "fiftyTwoWeekHigh": None, "fiftyTwoWeekLow": None, "source": "live",
        }
    return out


_CG_LAST_GOOD = {}   # symbol -> last successful crypto quote (kept if CoinGecko 429s)


def _downsample(arr, target=48):
    if not arr:
        return []
    step = max(1, len(arr) // target)
    return [round(float(arr[i]), 6) for i in range(0, len(arr), step) if arr[i] is not None][-72:]


def _coingecko_markets(symbols):
    """One batched call: price, 24h % change, market cap, volume AND a real
    7-day sparkline per coin. Cached 45s so we stay well under CoinGecko's
    free rate limit (avoids 429 -> wrong CNBC/sim fallback)."""
    ids = [CG_IDS[s] for s in symbols if s in CG_IDS]
    if not ids:
        return {}
    ck = "cgmarkets:" + ",".join(sorted(ids))
    data = CACHE.get(ck)
    if data is None:
        try:
            data = _cg_get("/coins/markets?vs_currency=usd&ids=" + ",".join(ids)
                           + "&price_change_percentage=24h&sparkline=true&per_page=250&page=1")
            if isinstance(data, list):
                CACHE.set(ck, data, 45)
        except Exception:
            data = None
    if not isinstance(data, list):
        return {}
    id2sym = {CG_IDS[s]: s for s in symbols if s in CG_IDS}
    out = {}
    for it in data:
        sym = id2sym.get(it.get("id"))
        if not sym:
            continue
        price = it.get("current_price")
        chg = it.get("price_change_percentage_24h")
        chgabs = it.get("price_change_24h")
        prev = (price - chgabs) if (price is not None and chgabs is not None) else None
        spark = _downsample(((it.get("sparkline_in_7d") or {}).get("price")) or [])
        out[sym] = {
            "symbol": sym, "shortName": sym.replace("-USD", ""), "price": price,
            "previousClose": prev, "change": chgabs, "changePct": chg,
            "currency": "USD", "exchange": "Crypto",
            "marketCap": it.get("market_cap"), "volume": it.get("total_volume"),
            "fiftyTwoWeekHigh": it.get("high_24h"), "fiftyTwoWeekLow": it.get("low_24h"),
            "spark": spark, "source": "live",
        }
        _CG_LAST_GOOD[sym] = out[sym]
    return out


def _coingecko_chart(symbol, rng, interval="1d", full=False):
    cid = CG_IDS[symbol]
    days = "max" if (full and interval in ("1d", "1wk", "1mo")) else CG_DAYS.get(rng, 365)
    try:
        ohlc = _cg_get(f"/coins/{cid}/ohlc?vs_currency=usd&days={days}")
    except Exception:
        return None
    if not isinstance(ohlc, list) or not ohlc:
        return None
    candles = [{"t": int(p[0] / 1000), "o": p[1], "h": p[2], "l": p[3], "c": p[4], "v": 0}
               for p in ohlc if isinstance(p, list) and len(p) >= 5]
    if not candles:
        return None
    last = candles[-1]["c"]
    prev = candles[-2]["c"] if len(candles) > 1 else last
    mcap = None
    try:
        sp = _cg_get(f"/simple/price?ids={cid}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true")
        info = (sp or {}).get(cid, {})
        cur, chg = info.get("usd"), info.get("usd_24h_change")
        if cur is not None:
            last = cur
            candles[-1]["c"] = cur
            if chg is not None:
                prev = cur / (1 + chg / 100)
        mcap = info.get("usd_market_cap")
    except Exception:
        pass
    hi = max(c["h"] for c in candles)
    lo = min(c["l"] for c in candles)
    return {
        "symbol": symbol, "currency": "USD", "exchangeName": "CoinGecko",
        "shortName": symbol.replace("-USD", ""), "longName": None,
        "regularMarketPrice": last, "previousClose": prev,
        "regularMarketDayHigh": candles[-1]["h"], "regularMarketDayLow": candles[-1]["l"],
        "regularMarketVolume": 0, "fiftyTwoWeekHigh": hi, "fiftyTwoWeekLow": lo,
        "regularMarketTime": candles[-1]["t"], "candles": candles, "source": "live", "marketCap": mcap,
    }


def _coingecko_summary(symbol):
    cid = CG_IDS[symbol]
    try:
        d = _cg_get(f"/coins/{cid}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false")
    except Exception:
        return None
    if not isinstance(d, dict) or "market_data" not in d:
        return None
    md = d.get("market_data") or {}
    usd = lambda o: (o or {}).get("usd") if isinstance(o, dict) else None
    crypto = {
        "marketCap": usd(md.get("market_cap")), "rank": d.get("market_cap_rank"),
        "volume24h": usd(md.get("total_volume")), "circulating": md.get("circulating_supply"),
        "totalSupply": md.get("total_supply"), "maxSupply": md.get("max_supply"),
        "ath": usd(md.get("ath")), "athChangePct": usd(md.get("ath_change_percentage")),
        "high24h": usd(md.get("high_24h")), "low24h": usd(md.get("low_24h")),
        "chg24h": md.get("price_change_percentage_24h"), "chg7d": md.get("price_change_percentage_7d"),
        "chg30d": md.get("price_change_percentage_30d"), "chg1y": md.get("price_change_percentage_1y"),
    }
    desc = ((d.get("description") or {}).get("en") or "").split(". ")
    profile = {
        "name": d.get("name"), "sector": "Cryptocurrency",
        "industry": ", ".join((d.get("categories") or [])[:2]) or None,
        "website": ((d.get("links") or {}).get("homepage") or [None])[0] or None,
        "description": (". ".join(desc[:3]))[:500] or None,
    }
    return {"available": True, "source": "coingecko", "assetClass": "crypto",
            "crypto": crypto, "profile": profile, "stats": {}, "earnings": []}


def fetch_quotes(symbols):
    key = "quotes:" + ",".join(symbols)
    cached = CACHE.get(key)
    if cached:
        return cached
    out = {}
    # 1) crypto -> CoinGecko markets (accurate 24h %, market cap, real sparkline)
    crypto = [s for s in symbols if _is_crypto(s)]
    if crypto:
        cg = {}
        try:
            cg = _coingecko_markets(crypto)
        except Exception:
            cg = {}
        for s in crypto:
            if s in cg:
                out[s] = cg[s]
            elif s in _CG_LAST_GOOD:
                out[s] = dict(_CG_LAST_GOOD[s])   # CoinGecko busy -> last correct value (never wrong CNBC %)
    # 2) everything else -> CNBC real-time batch (crypto stays on CoinGecko/sim, never CNBC)
    rest = [s for s in symbols if s not in out and not _is_crypto(s)]
    if rest:
        try:
            out.update(_cnbc_quotes(rest))
        except Exception:
            pass
    # 3) fall back to Yahoo chart -> simulated for anything still missing
    missing = [s for s in symbols if s not in out]
    if missing:
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = {ex.submit(_quote_from_chart, s): s for s in missing}
            for fut in as_completed(futs):
                s = futs[fut]
                try:
                    out[s] = fut.result()
                except Exception:
                    out[s] = {"symbol": s, "error": True}
    ordered = [out[s] for s in symbols if s in out]
    CACHE.set(key, ordered, 5)
    return ordered


def fetch_spark(symbols):
    """Real recent price series per symbol for the row sparklines: crypto from
    CoinGecko's 7-day sparkline, stocks from Yahoo's batched spark endpoint."""
    out = {}
    crypto = [s for s in symbols if _is_crypto(s)]
    if crypto:
        try:
            cg = _coingecko_markets(crypto)
            for s, q in cg.items():
                if q.get("spark"):
                    out[s] = q["spark"]
        except Exception:
            pass
    stocks = [s for s in symbols if not _is_crypto(s)]
    if stocks:
        ck = "spark:" + ",".join(sorted(stocks))
        cached = CACHE.get(ck)
        if cached is not None:
            out.update(cached)
        else:
            got = {}
            try:
                pathq = ("/v7/finance/spark?symbols=" + urllib.parse.quote(",".join(stocks))
                         + "&range=5d&interval=1h")
                data = _yahoo_json(pathq)
                for r in (data.get("spark", {}).get("result", []) or []):
                    sym = r.get("symbol")
                    resp = (r.get("response") or [{}])[0]
                    closes = (((resp.get("indicators") or {}).get("quote") or [{}])[0].get("close")) or []
                    closes = [round(c, 4) for c in closes if c is not None]
                    if sym and len(closes) >= 2:
                        got[sym] = _downsample(closes, 48)
            except Exception:
                got = {}
            if got:
                CACHE.set(ck, got, 120)
                out.update(got)
    return out


SEARCH_DICT = [
    ("AAPL", "Apple Inc.", "NASDAQ"), ("MSFT", "Microsoft Corp.", "NASDAQ"),
    ("NVDA", "NVIDIA Corp.", "NASDAQ"), ("AMZN", "Amazon.com Inc.", "NASDAQ"),
    ("GOOGL", "Alphabet Inc.", "NASDAQ"), ("META", "Meta Platforms", "NASDAQ"),
    ("TSLA", "Tesla Inc.", "NASDAQ"), ("BRK-B", "Berkshire Hathaway", "NYSE"),
    ("JPM", "JPMorgan Chase", "NYSE"), ("V", "Visa Inc.", "NYSE"),
    ("WMT", "Walmart Inc.", "NYSE"), ("XOM", "Exxon Mobil", "NYSE"),
    ("JNJ", "Johnson & Johnson", "NYSE"), ("PG", "Procter & Gamble", "NYSE"),
    ("MA", "Mastercard", "NYSE"), ("HD", "Home Depot", "NYSE"),
    ("KO", "Coca-Cola", "NYSE"), ("DIS", "Walt Disney", "NYSE"),
    ("NFLX", "Netflix", "NASDAQ"), ("AMD", "Advanced Micro Devices", "NASDAQ"),
    ("INTC", "Intel Corp.", "NASDAQ"), ("BA", "Boeing", "NYSE"),
    ("^GSPC", "S&P 500 Index", "INDEX"), ("^DJI", "Dow Jones", "INDEX"),
    ("^IXIC", "Nasdaq Composite", "INDEX"), ("^FTSE", "FTSE 100", "INDEX"),
    ("^GDAXI", "DAX", "INDEX"), ("^N225", "Nikkei 225", "INDEX"),
    ("BTC-USD", "Bitcoin USD", "CRYPTO"), ("ETH-USD", "Ethereum USD", "CRYPTO"),
    ("EURUSD=X", "EUR/USD", "FX"), ("GBPUSD=X", "GBP/USD", "FX"),
    ("GC=F", "Gold Futures", "CMDTY"), ("CL=F", "Crude Oil WTI", "CMDTY"),
]


def _search_fallback(q):
    ql = q.lower().strip()
    out = []
    for sym, name, exch in SEARCH_DICT:
        if ql in sym.lower() or ql in name.lower():
            out.append({"symbol": sym, "name": name, "exchange": exch, "type": "Equity"})
    return {"quotes": out[:12], "news": []}


def fetch_search(q):
    key = f"search:{q}"
    cached = CACHE.get(key)
    if cached:
        return cached
    pathq = ("/v1/finance/search?q=" + urllib.parse.quote(q)
             + "&quotesCount=12&newsCount=8&listsCount=0")
    try:
        data = _yahoo_json(pathq)
    except Exception:
        return _search_fallback(q)
    quotes = []
    for it in data.get("quotes", []):
        if not it.get("symbol"):
            continue
        quotes.append({
            "symbol": it.get("symbol"),
            "name": it.get("longname") or it.get("shortname"),
            "exchange": it.get("exchDisp"),
            "type": it.get("typeDisp") or it.get("quoteType"),
        })
    news = []
    for it in data.get("news", []):
        news.append({
            "title": it.get("title"),
            "publisher": it.get("publisher"),
            "link": it.get("link"),
            "time": it.get("providerPublishTime"),
            "tickers": it.get("relatedTickers", []),
        })
    out = {"quotes": quotes, "news": news}
    CACHE.set(key, out, 60)
    return out


def _google_news(q):
    """Free, key-less news via Google News RSS (independent of Yahoo)."""
    url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote(q)
           + "&hl=en-US&gl=US&ceid=US:en")
    try:
        text, _ = _http_get(url, timeout=15)
        root = ET.fromstring(text)
    except Exception:
        return []
    out = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = item.findtext("pubDate")
        src_el = item.find("source")
        publisher = (src_el.text.strip() if src_el is not None and src_el.text else None)
        ts = None
        if pub:
            try:
                ts = int(email.utils.parsedate_to_datetime(pub).timestamp())
            except Exception:
                ts = None
        # Google appends " - Publisher" to titles; trim it when redundant
        if publisher and title.endswith(" - " + publisher):
            title = title[: -(len(publisher) + 3)]
        if title:
            out.append({"title": title, "publisher": publisher, "link": link,
                        "time": ts, "tickers": []})
        if len(out) >= 20:
            break
    return out


def fetch_news(q):
    cached = CACHE.get(f"news:{q}")
    if cached:
        return cached
    news = _google_news(q)
    if not news:
        try:
            news = fetch_search(q).get("news", [])
        except Exception:
            news = []
    CACHE.set(f"news:{q}", news, 90)
    return news


def _raw(o, k):
    return o[k]["raw"] if isinstance(o, dict) and isinstance(o.get(k), dict) and o[k].get("raw") is not None else None


def _yahoo_summary_normalized(symbol):
    crumb, jar = CRUMB.get()
    if not crumb:
        return {"available": False}
    modules = ("summaryDetail,defaultKeyStatistics,financialData,price,assetProfile")
    sym = urllib.parse.quote(symbol)
    def _pathq(cr):
        return f"/v10/finance/quoteSummary/{sym}?modules={modules}&crumb={urllib.parse.quote(cr)}"
    try:
        data = _yahoo_json(_pathq(crumb), jar=jar)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            crumb, jar = CRUMB.get(force=True)
            if not crumb:
                return {"available": False}
            try:
                data = _yahoo_json(_pathq(crumb), jar=jar)
            except Exception:
                return {"available": False}
        else:
            return {"available": False}
    except Exception:
        return {"available": False}
    try:
        r = data["quoteSummary"]["result"][0]
    except Exception:
        return {"available": False}
    sd, ks2, fd, pr, ap = (r.get("summaryDetail", {}), r.get("defaultKeyStatistics", {}),
                           r.get("financialData", {}), r.get("price", {}), r.get("assetProfile", {}))
    chg52 = _raw(ks2, "52WeekChange")
    stats = {
        "marketCap": _raw(pr, "marketCap") or _raw(sd, "marketCap"),
        "enterpriseValue": _raw(ks2, "enterpriseValue"),
        "trailingPE": _raw(sd, "trailingPE"), "forwardPE": _raw(sd, "forwardPE") or _raw(ks2, "forwardPE"),
        "peg": _raw(ks2, "pegRatio"), "priceToSales": _raw(sd, "priceToSalesTrailing12Months"),
        "priceToBook": _raw(ks2, "priceToBook"), "revenue": _raw(fd, "totalRevenue"),
        "ebitda": _raw(fd, "ebitda"), "eps": _raw(ks2, "trailingEps"),
        "grossMargin": _raw(fd, "grossMargins"), "operatingMargin": _raw(fd, "operatingMargins"),
        "profitMargin": _raw(fd, "profitMargins") or _raw(ks2, "profitMargins"),
        "roe": _raw(fd, "returnOnEquity"), "totalCash": _raw(fd, "totalCash"),
        "totalDebt": _raw(fd, "totalDebt"), "dividendYield": _raw(sd, "dividendYield"),
        "payoutRatio": _raw(sd, "payoutRatio"), "beta": _raw(sd, "beta") or _raw(ks2, "beta"),
        "sharesOut": _raw(ks2, "sharesOutstanding"),
        "fiftyTwoWeekChange": (chg52 * 100) if chg52 is not None else None,
        "targetMean": _raw(fd, "targetMeanPrice"), "recommendation": fd.get("recommendationKey"),
    }
    profile = {
        "sector": ap.get("sector"), "industry": ap.get("industry"),
        "employees": ap.get("fullTimeEmployees"), "website": ap.get("website"),
        "hq": ", ".join([x for x in [ap.get("city"), ap.get("state"), ap.get("country")] if x]),
        "description": ap.get("longBusinessSummary"),
    }
    return {"available": True, "source": "yahoo", "stats": stats, "profile": profile}


def fetch_summary(symbol):
    key = f"summary:{symbol}"
    cached = CACHE.get(key)
    if cached:
        return cached
    out = None
    # 0) crypto -> CoinGecko (market cap, supply, ATH, performance)
    if _is_crypto(symbol):
        cg = _coingecko_summary(symbol)
        if cg:
            CACHE.set(key, cg, 300)
            return cg
    # 1) KEY STATISTICS from CNBC (key-less, no quota -> always populated)
    cn = _cnbc_summary(symbol)
    if cn and cn.get("available"):
        out = cn
        # 2) company profile + earnings from Twelve Data (best-effort, light)
        if TD_KEY and re.fullmatch(r"[A-Z]{1,6}", symbol):
            try:
                prof, earn = _td_profile_earnings(symbol)
                if prof:  # merge TD fields onto the CNBC basic profile
                    for k, v in prof.items():
                        if v:
                            out["profile"][k] = v
                if earn:
                    out["earnings"] = earn
                an = _td_analyst(symbol)
                if an:
                    out["analyst"] = an
            except Exception:
                pass
    # 3) fallbacks: Twelve Data full, then Yahoo
    if not out or not out.get("available"):
        if TD_KEY and re.fullmatch(r"[A-Z]{1,6}", symbol):
            out = _td_summary(symbol)
        if not out or not out.get("available"):
            out = _yahoo_summary_normalized(symbol)
    if out and out.get("available"):
        CACHE.set(key, out, 300)
    return out or {"available": False}


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Terminal/1.0"

    def log_message(self, fmt, *args):
        pass  # quiet

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(path, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_error(404, "Not Found")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/"):
            return self._handle_api(path, qs)

        # static
        if path == "/" or path == "":
            path = "/index.html"
        safe = os.path.normpath(path).lstrip("/")
        full = os.path.join(PUBLIC, safe)
        if not full.startswith(PUBLIC):
            self.send_error(403, "Forbidden")
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        self._send_file(full)

    def _handle_api(self, path, qs):
        try:
            if path == "/api/chart":
                symbol = (qs.get("symbol", [""])[0]).strip()
                rng = qs.get("range", ["6mo"])[0]
                interval = qs.get("interval", ["1d"])[0]
                use_provider = qs.get("prov", ["0"])[0] == "1"
                full = qs.get("full", ["0"])[0] == "1"
                if not symbol:
                    return self._send_json({"error": "symbol required"}, 400)
                return self._send_json(fetch_chart(symbol, rng, interval, use_provider=use_provider, full=full))

            if path == "/api/quotes":
                syms = (qs.get("symbols", [""])[0]).strip()
                symbols = [s.strip() for s in syms.split(",") if s.strip()]
                if not symbols:
                    return self._send_json({"error": "symbols required"}, 400)
                return self._send_json({"quotes": fetch_quotes(symbols)})

            if path == "/api/spark":
                syms = (qs.get("symbols", [""])[0]).strip()
                symbols = [s.strip() for s in syms.split(",") if s.strip()]
                if not symbols:
                    return self._send_json({"spark": {}})
                return self._send_json({"spark": fetch_spark(symbols)})

            if path == "/api/search":
                q = (qs.get("q", [""])[0]).strip()
                if not q:
                    return self._send_json({"quotes": [], "news": []})
                return self._send_json(fetch_search(q))

            if path == "/api/news":
                q = (qs.get("q", ["stock market"])[0]).strip()
                return self._send_json({"news": fetch_news(q)})

            if path == "/api/summary":
                symbol = (qs.get("symbol", [""])[0]).strip()
                if not symbol:
                    return self._send_json({"error": "symbol required"}, 400)
                return self._send_json(fetch_summary(symbol))

            return self._send_json({"error": "unknown endpoint"}, 404)
        except urllib.error.HTTPError as e:
            return self._send_json({"error": f"upstream {e.code}"}, 502)
        except Exception as e:
            return self._send_json({"error": str(e)}, 500)


def main():
    ap = argparse.ArgumentParser()
    # PORT/HOST env vars let cloud hosts (Render, Railway, Replit…) configure it
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"TERMINAL running at http://{args.host}:{args.port}")
    if TD_KEY:
        print("Real-time provider: Twelve Data ENABLED (live data first, Yahoo fallback).")
    else:
        print("Real-time provider: none. Using Yahoo Finance (delayed) -> simulated fallback.")
        print("  Set TWELVEDATA_API_KEY or create config.json for true real-time data.")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
