# TERMINAL — a Bloomberg-Terminal-style market workstation

A self-contained, dependency-free financial terminal in the spirit of the
Bloomberg Terminal: command-driven, multi-panel, dark/amber UI with live
charts, quotes, news and fundamentals.

> **Honesty note.** This is *not* the real Bloomberg Terminal (a ~$24k/yr
> product on proprietary data feeds). It reproduces the *look, feel and
> workflow* and wires in **real, free, key-less market data** (Yahoo Finance)
> so the experience is genuine — but data is delayed (~15 min) and limited to
> what public endpoints expose.

## Run it

No installation, no `pip`, no Node — just Python 3 (already on macOS):

```bash
cd bloomberg-terminal
python3 server.py            # then open http://127.0.0.1:8765
```

Or simply double-click **`start.command`** (it boots the server and opens your
browser). Change the port with `python3 server.py --port 9000`.

## Share it

**1) Send the folder (simplest).** Zip the project and send it. The recipient
unzips it and runs `python3 server.py` (Python 3 ships with macOS/Linux; on
Windows install it from python.org). No build step, no dependencies. It works
**without any API key** — quotes, charts, fundamentals and news come from
key-less sources (CNBC, Yahoo, Google News). A free Twelve Data key (in
`config.json`) only adds analyst forecasts/earnings and guarantees the security
chart. **Do not include your `config.json`** in what you share — it holds your
private key (`.gitignore` already excludes it).

**2) Share on your local network.** Run it bound to all interfaces and give
others on the same Wi-Fi your machine's IP:

```bash
python3 server.py --host 0.0.0.0 --port 8765
# others open http://<your-LAN-IP>:8765   (find it with: ipconfig getifaddr en0)
```

**3) Put it online (public link).** Because of the data proxy it needs a
Python host (not a static site). Free options that work as-is:

- **Render.com (one-click):** this repo ships a `render.yaml` blueprint. In
  Render: **New + → Blueprint → connect this repo → Apply**. It runs
  `python3 server.py --host 0.0.0.0` and sets `$PORT` automatically. You get a
  public `https://<name>.onrender.com` URL.
- **Railway.app:** new project from the repo, start command
  `python3 server.py --host 0.0.0.0`.
- **Replit / PythonAnywhere:** upload the folder, run `python3 server.py`.

> **Netlify / Vercel won't work as-is** — they host static sites + JS/Go
> serverless functions, not a persistent Python server. Use a Python host
> (above), or the backend would need rewriting as Node serverless functions.

Add a `TWELVEDATA_API_KEY` environment variable on the host (instead of
`config.json`) if you want analyst/earnings data in the deployed version.

## What's inside

```
bloomberg-terminal/
├── server.py        # Python stdlib backend: same-origin proxy + cache + fallback
├── start.command    # one-click launcher (macOS)
└── public/
    ├── index.html   # layout
    ├── styles.css   # the dark/amber terminal aesthetic
    ├── chart.js     # dependency-free canvas chart engine (candles/line/area)
    └── app.js       # command parser, monitor, watchlist, news, security view
```

## Using it (command line / "yellow keys")

Type into the command bar at the top (press **`/`** anywhere to focus it):

| Command | Action |
|---|---|
| `AAPL` | Load a security (any Yahoo symbol) |
| `AAPL US Equity` | Bloomberg-style suffix accepted and stripped |
| `^GSPC`, `BTC-USD`, `EURUSD=X`, `GC=F`, `AIR.PA` | Indices, crypto, FX, futures, intl. equities |
| `SPX`, `GOLD`, `OIL`, `DAX`, `10Y` … | Friendly aliases mapped to the right symbol |
| `HOME` / `MON` | Market monitor |
| `HEAT` / `IMAP` | Market heat map — % change by sector (click a tile to open it) |
| `EQS` / `SCREEN` | Equity screener — filter/sort a stock universe by %chg, price, 52W range, volume |
| `COMP AAPL MSFT NVDA` | Compare normalized % performance of several symbols on one chart |
| `ALRT` | Price alerts — desktop notification when a symbol crosses your level (🔔 top bar) |
| `TOP` / `N` | Top market news |
| `/tesla` or `SE tesla` | Search companies / symbols |
| `HELP` | Command reference overlay |

In the **security view** you get: a full quote header (last, change, day &
52-week ranges, volume), a candlestick / line / area chart with timeframes
(1D→MAX) and a crosshair tooltip, plus a full **technical-analysis** toolkit
you toggle from the chart header:

- **MA20 / MA50 / MA200** — simple moving averages
- **BB** — Bollinger Bands (20, 2σ)
- **EMA** — exponential moving averages (12 & 26)
- **RSI** — Relative Strength Index (14) in its own sub-panel with 30/70 guides
- **MACD** — MACD (12, 26, 9) sub-panel with signal line and histogram
- a **volume** sub-panel

…alongside key statistics (valuation, margins, dividend, beta), a **recent
earnings** table (estimate vs actual with surprise %), a company profile and
security-specific news. Header buttons let you **set a price alert**, add to
your **watchlist**, **export** the OHLCV + stats to **CSV** (opens in Excel),
or **print / save as PDF**.

**Price alerts** (`ALRT` or the 🔔): set an *above/below* level for any symbol;
a background check (~20s) fires a desktop notification and an in-app toast when
the **live** price crosses it (alerts only trigger on real, non-simulated
prices). Alerts persist in your browser.

The **heat map** (`HEAT` / `IMAP`) shows the large-cap universe grouped by
sector, each tile shaded green→red by its % change — click any tile to drill in.

The **compare view** (`COMP`) overlays the normalized % performance of up to 8
symbols on a single chart with a color-matched legend and crosshair — add or
remove tickers live.

## Real-time data (optional API key)

Out of the box the app uses Yahoo Finance (delayed, key-less). For **true
real-time data**, drop in a free [Twelve Data](https://twelvedata.com) key:

```bash
cp config.example.json config.json   # then paste your key into "twelvedata_key"
# or:  export TWELVEDATA_API_KEY=xxxx
python3 server.py
```

When a key is set, the **focused security view** fetches live data from the
provider first — real-time price/candles **and real fundamentals + company
profile** (market cap, P/E, margins, ROE, dividend, beta, sector, employees,
description) — falling back to Yahoo → simulated on any error. To respect the
free tier (~8 req/min) the provider is used **only for the security view**;
the bulk monitor, heat map and compare views stay on Yahoo/simulated so they
never drain your quota. A short auto cooldown kicks in if the limit is hit.
The provider also covers FX (e.g. EUR/USD), crypto (BTC/USD) and metals
(gold/silver); indices and oil are not on the free tier and use Yahoo.

The **home monitor** streams world indices, FX majors, commodities, rates,
crypto, your editable watchlist (saved in your browser) and a news feed.
Everything auto-refreshes every 15 seconds.

## Data sources & resilience

- **Quotes (all bulk views):** CNBC quote service — key-less, batchable,
  real-time across stocks, indices, FX, crypto and commodities (plus 52-week
  range), with a Yahoo→simulated fallback. This is what makes the monitor,
  heat map, screener, watchlist and compare show real, moving prices.
- **Charts (security view):** Twelve Data (if a key is set) then the Yahoo
  `chart` endpoint, for intraday/historical candles, then simulated fallback.
- **News:** Google News RSS (key-less, independent of Yahoo, per-query) with a
  Yahoo `search` fallback.
- **Search:** Yahoo Finance `search` endpoint (with a built-in symbol fallback).
- **Fundamentals:** Yahoo `quoteSummary` (needs a session "crumb"; the server
  fetches and caches one, and degrades gracefully if it can't).
- **Caching:** in-memory TTL cache (20–300 s) keeps request volume low.
- **Fallback:** if the live feed is briefly unreachable or rate-limited, the
  server serves clearly-labelled **simulated** data (status badge turns
  `● SIM` and a banner appears) so the UI never breaks — and it
  **auto-switches back to live** the moment the feed returns.

### "It says ● SIM / SIMULATED DATA"

Yahoo rate-limits by IP. If you hammer it (e.g. rapid testing) it will return
HTTP 429 for a while (typically 15–60 min). During that window the app shows
simulated data. Just leave it open — it retries every 15 s and flips back to
`● LIVE` automatically. To upgrade to true real-time / institutional data,
plug an API key (Finnhub, Polygon, Alpha Vantage, Twelve Data, …) into the
fetchers in `server.py`.

## Terminal Interflon (interflon-tools/)

A second, independent app lives in [`interflon-tools/`](interflon-tools/README.md): a
French-language sales toolkit for Interflon field reps, with plant prospecting by NAF
sector and territory (free *API Recherche d'entreprises*), a follow-up pipeline, and a
lubricant product selector. Same zero-dependency approach (`python3 server.py`), and a
second service in `render.yaml`.

## Disclaimer

For educational/personal use. Market data is delayed and provided "as is" with
no warranty. Not affiliated with or endorsed by Bloomberg L.P. Not investment
advice.
