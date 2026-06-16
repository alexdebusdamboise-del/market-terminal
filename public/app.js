/* TERMINAL — application logic */
(function () {
  "use strict";

  // ---------------- helpers ----------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const api = (path) => fetch(path).then((r) => r.json());
  const fmtNum = window.fmtNum, fmtVol = window.fmtVol;

  function fmtBig(n) {
    if (n == null || isNaN(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return fmtNum(n, 2);
  }
  function fmtPct(n) { return n == null || isNaN(n) ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
  function signClass(n) { return n == null ? "flat" : n > 0 ? "up" : n < 0 ? "down" : "flat"; }
  function fmtTimeAgo(ts) {
    if (!ts) return "";
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------------- symbol universe ----------------
  const GROUPS = {
    INDICES: ["^GSPC", "^DJI", "^IXIC", "^NDX", "^RUT", "^SOX", "^VIX", "^NYA", "^OEX", "^DJT", "^DJU",
      "^FTSE", "^GDAXI", "^FCHI", "^STOXX50E", "^SSMI", "^IBEX", "^AEX", "^OMX",
      "^N225", "^HSI", "^KS11", "^TWII", "^AXJO", "^NSEI", "^BVSP", "^GSPTSE", "^MXX", "^STI"],
    FX: ["EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X", "AUDUSD=X", "USDCAD=X", "NZDUSD=X", "USDCNY=X",
      "USDSEK=X", "USDNOK=X", "USDMXN=X", "USDINR=X", "USDBRL=X", "USDZAR=X", "USDHKD=X", "USDSGD=X", "USDKRW=X",
      "EURGBP=X", "EURJPY=X", "GBPJPY=X"],
    COMMODITIES: ["GC=F", "SI=F", "PL=F", "PA=F", "HG=F", "CL=F", "BZ=F", "NG=F", "HO=F", "RB=F",
      "ZC=F", "ZW=F", "ZS=F", "KC=F", "SB=F", "CT=F"],
    RATES: ["^IRX", "US6M", "US1Y", "US2Y", "^FVX", "^TNX", "^TYX", "DE10Y", "GB10Y", "JP10Y"],
    CRYPTO: ["BTC-USD", "ETH-USD", "BNB-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
      "AVAX-USD", "LINK-USD", "DOT-USD", "LTC-USD", "BCH-USD", "TRX-USD", "XLM-USD", "UNI-USD", "SHIB-USD"],
    EQUITY: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "SPCX", "AVGO", "BRK-B", "JPM", "V", "WMT",
      "LLY", "ORCL", "MA", "NFLX", "XOM", "COST", "JNJ", "HD", "PG", "AMD", "CRM", "BAC"],
    EUROPE: ["ASML", "SAP", "NVS", "NVO", "AZN", "SHEL", "HSBC", "TTE", "UL", "DEO", "RIO", "BHP",
      "SAN", "UBS", "ING", "GSK", "SNY", "SIEGY", "LVMUY", "NSRGY", "RHHBY", "MBGYY", "VWAGY",
      "ALIZY", "ARM", "SPOT", "BUD", "RELX", "STLA", "DB"],
    ASIA: ["TSM", "BABA", "TM", "SONY", "TCEHY", "SFTBY", "PDD", "JD", "BIDU", "NTES", "NIO", "LI",
      "XPEV", "SE", "HMC", "MUFG", "SMFG", "INFY", "WIT", "HDB", "IBN", "TCOM"],
  };
  const NAMES = {
    "^GSPC": "S&P 500", "^DJI": "Dow Jones", "^IXIC": "Nasdaq Comp", "^NDX": "Nasdaq 100",
    "^RUT": "Russell 2000", "^SOX": "Phlx Semis", "^VIX": "CBOE VIX", "^NYA": "NYSE Comp",
    "^OEX": "S&P 100", "^DJT": "Dow Transports", "^DJU": "Dow Utilities",
    "^FTSE": "FTSE 100", "^GDAXI": "DAX", "^FCHI": "CAC 40", "^STOXX50E": "Euro Stoxx 50",
    "^SSMI": "Swiss SMI", "^IBEX": "IBEX 35", "^AEX": "AEX (NL)", "^OMX": "OMX Sthlm 30",
    "^N225": "Nikkei 225", "^HSI": "Hang Seng", "^KS11": "KOSPI", "^TWII": "Taiwan", "^AXJO": "ASX 200",
    "^NSEI": "Nifty 50", "^BVSP": "Bovespa", "^GSPTSE": "TSX Canada", "^MXX": "IPC Mexico", "^STI": "Straits Times",
    "EURUSD=X": "EUR/USD", "GBPUSD=X": "GBP/USD", "USDJPY=X": "USD/JPY", "USDCHF=X": "USD/CHF",
    "AUDUSD=X": "AUD/USD", "USDCAD=X": "USD/CAD", "NZDUSD=X": "NZD/USD", "USDCNY=X": "USD/CNY",
    "USDSEK=X": "USD/SEK", "USDNOK=X": "USD/NOK", "USDMXN=X": "USD/MXN", "USDINR=X": "USD/INR",
    "USDBRL=X": "USD/BRL", "USDZAR=X": "USD/ZAR", "USDHKD=X": "USD/HKD", "USDSGD=X": "USD/SGD",
    "USDKRW=X": "USD/KRW", "EURGBP=X": "EUR/GBP", "EURJPY=X": "EUR/JPY", "GBPJPY=X": "GBP/JPY",
    "GC=F": "Gold", "SI=F": "Silver", "PL=F": "Platinum", "PA=F": "Palladium", "HG=F": "Copper",
    "CL=F": "WTI Crude", "BZ=F": "Brent Crude", "NG=F": "Nat Gas", "HO=F": "Heating Oil", "RB=F": "Gasoline",
    "ZC=F": "Corn", "ZW=F": "Wheat", "ZS=F": "Soybeans", "KC=F": "Coffee", "SB=F": "Sugar", "CT=F": "Cotton",
    "^IRX": "US 3M", "US6M": "US 6M", "US1Y": "US 1Y", "US2Y": "US 2Y", "^FVX": "US 5Y",
    "^TNX": "US 10Y", "^TYX": "US 30Y", "DE10Y": "Germany 10Y", "GB10Y": "UK 10Y", "JP10Y": "Japan 10Y",
    "SPCX": "SpaceX",
    "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum", "BNB-USD": "BNB", "SOL-USD": "Solana", "XRP-USD": "XRP",
    "ADA-USD": "Cardano", "DOGE-USD": "Dogecoin", "AVAX-USD": "Avalanche", "LINK-USD": "Chainlink",
    "DOT-USD": "Polkadot", "LTC-USD": "Litecoin", "BCH-USD": "Bitcoin Cash", "TRX-USD": "Tron",
    "XLM-USD": "Stellar", "UNI-USD": "Uniswap", "SHIB-USD": "Shiba Inu",
    // Europe (ADR)
    "ASML": "ASML", "SAP": "SAP", "NVS": "Novartis", "NVO": "Novo Nordisk", "AZN": "AstraZeneca",
    "SHEL": "Shell", "HSBC": "HSBC", "TTE": "TotalEnergies", "UL": "Unilever", "DEO": "Diageo",
    "RIO": "Rio Tinto", "BHP": "BHP Group", "SAN": "Santander", "UBS": "UBS Group", "ING": "ING Groep",
    "GSK": "GSK", "SNY": "Sanofi", "SIEGY": "Siemens", "LVMUY": "LVMH", "NSRGY": "Nestlé",
    "RHHBY": "Roche", "MBGYY": "Mercedes-Benz", "VWAGY": "Volkswagen", "ALIZY": "Allianz",
    "ARM": "ARM Holdings", "SPOT": "Spotify", "BUD": "AB InBev", "RELX": "RELX", "STLA": "Stellantis", "DB": "Deutsche Bank",
    // Asia (ADR)
    "TSM": "TSMC (Taiwan)", "BABA": "Alibaba", "TM": "Toyota", "SONY": "Sony", "TCEHY": "Tencent",
    "SFTBY": "SoftBank", "PDD": "PDD / Temu", "JD": "JD.com", "BIDU": "Baidu", "NTES": "NetEase",
    "NIO": "NIO", "LI": "Li Auto", "XPEV": "XPeng", "SE": "Sea Ltd", "HMC": "Honda",
    "MUFG": "Mitsubishi UFJ", "SMFG": "Sumitomo Mitsui", "INFY": "Infosys", "WIT": "Wipro",
    "HDB": "HDFC Bank", "IBN": "ICICI Bank", "TCOM": "Trip.com",
  };
  const ALIAS = {
    SPX: "^GSPC", SP500: "^GSPC", "S&P": "^GSPC", SPY: "^GSPC",
    DJIA: "^DJI", DOW: "^DJI", INDU: "^DJI",
    NDX: "^NDX", NASDAQ: "^IXIC", COMP: "^IXIC", CCMP: "^IXIC",
    RUT: "^RUT", RTY: "^RUT", VIX: "^VIX",
    FTSE: "^FTSE", UKX: "^FTSE", DAX: "^GDAXI", CAC: "^FCHI",
    SX5E: "^STOXX50E", ESTX50: "^STOXX50E", NIKKEI: "^N225", NKY: "^N225", HSI: "^HSI",
    GOLD: "GC=F", XAU: "GC=F", SILVER: "SI=F", XAG: "SI=F",
    OIL: "CL=F", WTI: "CL=F", CRUDE: "CL=F", BRENT: "BZ=F", NATGAS: "NG=F", NGAS: "NG=F", COPPER: "HG=F",
    BTC: "BTC-USD", BITCOIN: "BTC-USD", ETH: "ETH-USD", ETHEREUM: "ETH-USD", SOL: "SOL-USD", DOGE: "DOGE-USD",
    "US10Y": "^TNX", "10Y": "^TNX", UST10: "^TNX", "US30Y": "^TYX", "30Y": "^TYX", "US5Y": "^FVX", "5Y": "^FVX",
    EUR: "EURUSD=X", GBP: "GBPUSD=X", JPY: "USDJPY=X",
  };
  const YELLOW_KEYS = new Set(["EQUITY", "INDEX", "CURNCY", "CRNCY", "COMDTY", "CMDTY", "GOVT", "CORP", "GO", "MTGE", "PFD", "MUNI"]);

  function decimalsFor(sym, price) {
    if (/=X$/.test(sym)) return price > 20 ? 3 : 5;       // FX
    if (/^\^(TNX|TYX|FVX|IRX)$/.test(sym)) return 3;       // US yields (Yahoo)
    if (/^(US|DE|GB|JP)(\dM|\dY|\d{1,2}Y|3M|6M)/.test(sym)) return 3; // intl yields (CNBC)
    return undefined;
  }

  // Local symbol index (everything the app knows) — powers autocomplete even
  // when the upstream search (Yahoo) is rate-limited.
  let _localIndex = null;
  function localIndex() {
    if (_localIndex) return _localIndex;
    const m = {};
    Object.keys(NAMES).forEach((s) => { m[s] = NAMES[s]; });
    [].concat.apply([], Object.values(GROUPS)).forEach((s) => { if (!(s in m)) m[s] = s; });
    SCREENER_UNIVERSE.forEach((s) => { if (!(s in m)) m[s] = s; });
    _localIndex = Object.keys(m).map((s) => ({ symbol: s, name: m[s] }));
    return _localIndex;
  }
  function localSearch(q) {
    const ql = q.toLowerCase();
    return localIndex().filter((it) => it.symbol.toLowerCase().includes(ql) || (it.name || "").toLowerCase().includes(ql))
      .slice(0, 12).map((it) => ({ symbol: it.symbol, name: it.name, exchange: "", type: "" }));
  }
  function mergeLocal(results, q) {
    const have = new Set((results || []).map((r) => r.symbol));
    const out = (results || []).slice();
    localSearch(q).forEach((r) => { if (!have.has(r.symbol)) { out.push(r); have.add(r.symbol); } });
    return out.slice(0, 12);
  }

  // ---------------- state ----------------
  const state = {
    view: "home",
    symbol: null,
    range: "1y",
    interval: "1d",
    intraday: false,
    chartType: "candle",
    smaOn: { 20: false, 50: true, 200: true },
    ind: { bb: false, ema: false, rsi: false, macd: false, vwap: false, fib: false, stoch: false, atr: false, obv: false },
    chart: null,
    sim: false,
    reqId: 0,
  };
  // Each button loads DEEP history at its granularity (full=1) and `viewBars`
  // is just the default visible window — drag/scroll left to reach the start.
  const RANGES = [
    { k: "1D", range: "1d", interval: "5m", intraday: true, viewBars: 78 },
    { k: "5D", range: "5d", interval: "30m", intraday: true, viewBars: 65 },
    { k: "1M", range: "1mo", interval: "1d", intraday: false, viewBars: 22 },
    { k: "6M", range: "6mo", interval: "1d", intraday: false, viewBars: 126 },
    { k: "YTD", range: "ytd", interval: "1d", intraday: false, viewBars: "ytd" },
    { k: "1Y", range: "1y", interval: "1d", intraday: false, viewBars: 252 },
    { k: "5Y", range: "5y", interval: "1d", intraday: false, viewBars: 1260 },
    { k: "MAX", range: "max", interval: "1mo", intraday: false, viewBars: null },
  ];

  // ---------------- status / clock ----------------
  function setStatus(ok, msg) {
    const el = $("#status");
    el.classList.toggle("stale", !ok);
    if (!ok) { el.textContent = "● OFFLINE"; el.style.color = ""; }
    else { el.textContent = state.sim ? "● SIM" : "● LIVE"; el.style.color = state.sim ? "var(--amber)" : ""; }
    if (msg) $("#sb-left").textContent = msg;
  }
  function setSource(sim) {
    state.sim = sim;
    const el = $("#status");
    el.classList.remove("stale");
    if (sim) {
      el.textContent = "● SIM"; el.style.color = "var(--amber)";
      $("#sb-right").textContent = "⚠ SIMULATED DATA — live feed (Yahoo) temporarily rate-limited · auto-switches to live when available";
    } else {
      el.textContent = "● LIVE"; el.style.color = "";
      $("#sb-right").textContent = "● LIVE market data (CNBC · Twelve Data) · educational use only";
    }
  }
  function tickClock() {
    const d = new Date();
    const lt = d.toLocaleTimeString("en-GB", { hour12: false });
    const utc = d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
    $("#clock").textContent = lt + " · " + utc + " UTC";
  }
  setInterval(tickClock, 1000); tickClock();

  // ---------------- quote tables (monitor) ----------------
  const prevPx = {};
  const sparkBuf = {};           // per-symbol rolling buffer of live ticks
  const SPARK_MAX = 40;
  function pushSpark(sym, px) {
    if (px == null) return;
    const b = sparkBuf[sym] || (sparkBuf[sym] = []);
    b.push(px);
    if (b.length > SPARK_MAX) b.shift();
  }
  function sparkSVG(sym) {
    const b = sparkBuf[sym];
    if (!b || b.length < 2) return `<span class="spark-wait">·····</span>`;
    const w = 58, h = 18, pad = 2;
    const min = Math.min(...b), max = Math.max(...b), n = b.length;
    const flat = max === min;
    const range = flat ? 1 : max - min;
    const pts = b.map((v, i) => {
      const x = pad + (i / (n - 1)) * (w - 2 * pad);
      const y = flat ? h / 2 : h - pad - ((v - min) / range) * (h - 2 * pad);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    const col = flat ? "#6a6a6a" : (b[b.length - 1] >= b[0] ? "#26c281" : "#ff4d4d");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  }
  function flashClass(prev, cur) {
    if (prev == null || cur == null || cur === prev) return "";
    return cur > prev ? "flash-up" : "flash-down";
  }
  function quoteRow(q, opts, prev) {
    opts = opts || {};
    const sym = q.symbol;
    const dp = decimalsFor(sym, q.price);
    const name = NAMES[sym] || q.shortName || sym;
    const cls = signClass(q.change);
    const arrow = q.change > 0 ? "▲" : q.change < 0 ? "▼" : "·";
    const del = opts.del ? `<span class="q-del" data-del="${esc(sym)}" title="Remove">✕</span>` : "";
    const fl = flashClass(prev, q.price);
    const spark = opts.spark ? `<div class="q-spark">${sparkSVG(sym)}</div>` : "";
    return `<div class="qrow${opts.spark ? " qrow-spark" : ""}" data-sym="${esc(sym)}">
      <div><span class="q-sym">${esc(sym.replace(/=X$/, "").replace(/-USD$/, ""))}</span>${del}<div class="q-sub">${esc(name)}</div></div>
      <div class="q-last ${fl}">${q.price == null ? "—" : fmtNum(q.price, dp)}</div>
      <div class="q-chg ${cls}">${q.change == null ? "—" : (q.change >= 0 ? "+" : "") + fmtNum(q.change, dp)}</div>
      <div class="q-pct ${cls} ${fl}">${arrow} ${fmtPct(q.changePct)}</div>
      ${spark}
    </div>`;
  }
  function tableHead(spark) {
    return `<div class="qrow-head${spark ? " qrow-head-spark" : ""}"><span>SYMBOL</span><span>LAST</span><span>CHG</span><span>%CHG</span>${spark ? "<span>TREND</span>" : ""}</div>`;
  }
  async function loadGrid(container, symbols, opts) {
    if (!symbols.length) { container.innerHTML = `<div class="ks-note">Watchlist empty — load a security and press + ADD.</div>`; return; }
    if (!container.dataset.loaded) container.innerHTML = `<div class="loading">Loading…</div>`;
    try {
      const data = await api("/api/quotes?symbols=" + encodeURIComponent(symbols.join(",")));
      const quotes = data.quotes || [];
      const ck = container.id || container.dataset.grid || "g";
      const prev = prevPx[ck] || (prevPx[ck] = {});
      const scroll = container.scrollTop;
      quotes.forEach((q) => pushSpark(q.symbol, q.price)); // seed live sparkline buffers
      const rows = quotes.map((q) => quoteRow(q, opts, prev[q.symbol])).join("");
      container.innerHTML = tableHead(opts.spark) + rows;
      container.scrollTop = scroll;
      quotes.forEach((q) => { if (q.price != null) prev[q.symbol] = q.price; });
      container.dataset.loaded = "1";
      setStatus(true);
      setSource(quotes.some((q) => q && q.source === "sim"));
    } catch (e) {
      if (!container.dataset.loaded) container.innerHTML = `<div class="err">Data unavailable.</div>`;
      setStatus(false, "DATA ERROR");
    }
  }

  function refreshHome() {
    $$(".ptable[data-grid]").forEach((el) => loadGrid(el, GROUPS[el.dataset.grid], { spark: el.dataset.grid === "CRYPTO" }));
    loadGrid($("#watchtable"), getWatchlist(), { del: true, spark: true });
  }

  // ---------------- heatmap ----------------
  const HEAT_SECTORS = {
    "TECHNOLOGY": ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "AMD", "ADBE", "CSCO", "ACN", "INTC", "QCOM", "TXN", "IBM", "NOW", "INTU", "AMAT", "MU"],
    "COMMUNICATION": ["GOOGL", "META", "NFLX", "DIS", "TMUS", "VZ", "T", "CMCSA", "CHTR", "EA"],
    "CONSUMER DISC.": ["AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "LOW", "BKNG", "TJX", "ABNB"],
    "CONSUMER STAPLES": ["WMT", "COST", "PG", "KO", "PEP", "PM", "MO", "MDLZ", "CL", "TGT"],
    "FINANCIALS": ["BRK-B", "JPM", "BAC", "WFC", "GS", "MS", "C", "V", "MA", "AXP", "BLK", "SCHW", "SPGI"],
    "HEALTHCARE": ["UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "ABT", "DHR", "BMY", "AMGN", "GILD", "CVS"],
    "ENERGY": ["XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "OXY"],
    "INDUSTRIALS": ["CAT", "BA", "GE", "HON", "UPS", "RTX", "LMT", "DE", "UNP", "MMM"],
    "MATERIALS / RE": ["LIN", "SHW", "FCX", "NEM", "NUE", "APD", "PLD", "AMT", "EQIX", "SPG"],
    "UTILITIES": ["NEE", "DUK", "SO", "D", "AEP", "EXC"],
  };
  function heatColor(pct) {
    if (pct == null || isNaN(pct)) return "rgb(26,26,26)";
    const mag = Math.min(1, Math.abs(pct) / 3.5);
    const lerp = (a, b) => Math.round(a + (b - a) * mag);
    if (pct >= 0) return `rgb(${lerp(16, 25)},${lerp(40, 170)},${lerp(28, 90)})`;
    return `rgb(${lerp(40, 220)},${lerp(18, 60)},${lerp(18, 60)})`;
  }
  async function loadHeat() {
    const grid = $("#heatgrid");
    const all = [];
    Object.values(HEAT_SECTORS).forEach((arr) => arr.forEach((s) => all.push(s)));
    if (!grid.dataset.loaded) grid.innerHTML = `<div class="loading">Loading heat map…</div>`;
    let qmap = {};
    try {
      const data = await api("/api/quotes?symbols=" + encodeURIComponent(all.join(",")));
      (data.quotes || []).forEach((q) => { qmap[q.symbol] = q; });
      setSource((data.quotes || []).some((q) => q && q.source === "sim"));
    } catch (e) { if (!grid.dataset.loaded) grid.innerHTML = `<div class="err">Heat map unavailable.</div>`; return; }
    let html = "";
    for (const [sector, syms] of Object.entries(HEAT_SECTORS)) {
      const tiles = syms.map((s) => {
        const q = qmap[s] || {};
        const pct = q.changePct;
        return `<div class="heat-tile" data-sym="${esc(s)}" style="background:${heatColor(pct)}">
          <div class="ht-sym">${esc(s)}</div>
          <div class="ht-pct">${pct == null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%"}</div>
        </div>`;
      }).join("");
      html += `<div class="heat-sector"><div class="heat-sector-h">${sector}</div><div class="heat-tiles">${tiles}</div></div>`;
    }
    grid.innerHTML = html;
    grid.dataset.loaded = "1";
  }
  function showHeat() { showView("heat"); loadHeat(); }

  // ---------------- equity screener ----------------
  const SCREENER_UNIVERSE = [
    // Technology
    "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "AMD", "ADBE", "CSCO", "ACN", "INTC", "QCOM", "TXN",
    "IBM", "NOW", "INTU", "AMAT", "MU", "ADI", "LRCX", "KLAC", "PANW", "SNPS", "CDNS", "ANET", "MRVL", "DELL", "HPQ",
    // Communication
    "GOOGL", "META", "NFLX", "DIS", "TMUS", "VZ", "T", "CMCSA", "CHTR", "EA", "TTWO", "WBD",
    // Space / aerospace
    "SPCX", "RKLB",
    // Consumer discretionary
    "AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "LOW", "BKNG", "TJX", "ABNB", "ORLY", "CMG", "MAR", "GM", "F",
    // Consumer staples
    "WMT", "COST", "PG", "KO", "PEP", "PM", "MO", "MDLZ", "CL", "TGT", "KMB", "GIS", "KHC",
    // Financials
    "BRK-B", "JPM", "BAC", "WFC", "GS", "MS", "C", "V", "MA", "AXP", "BLK", "SCHW", "SPGI", "CB", "PGR", "MMC",
    // Healthcare
    "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "ABT", "DHR", "BMY", "AMGN", "GILD", "CVS", "ISRG", "VRTX", "REGN", "MDT",
    // Energy
    "XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "OXY", "VLO", "WMB", "KMI",
    // Industrials
    "CAT", "BA", "GE", "HON", "UPS", "RTX", "LMT", "DE", "UNP", "MMM", "GD", "NOC", "FDX", "EMR", "ETN",
    // Materials & Real Estate
    "LIN", "SHW", "FCX", "NEM", "NUE", "APD", "PLD", "AMT", "EQIX", "SPG", "O", "CCI",
    // Utilities
    "NEE", "DUK", "SO", "D", "AEP", "EXC", "SRE",
    // Europe (ADR)
    "ASML", "SAP", "NVS", "NVO", "AZN", "SHEL", "HSBC", "TTE", "UL", "DEO", "RIO", "BHP", "SAN", "UBS",
    "ING", "GSK", "SNY", "SIEGY", "LVMUY", "NSRGY", "RHHBY", "MBGYY", "VWAGY", "ALIZY", "ARM", "SPOT", "BUD", "RELX", "STLA", "DB",
    // Asia (ADR)
    "TSM", "BABA", "TM", "SONY", "TCEHY", "SFTBY", "PDD", "JD", "BIDU", "NTES", "NIO", "LI",
    "XPEV", "SE", "HMC", "MUFG", "SMFG", "INFY", "WIT", "HDB", "IBN", "TCOM",
  ];
  const scr = { preset: "all", sortKey: "changePct", sortDir: -1, rows: [], loaded: false };
  function showScreener() { showView("screen"); loadScreener(); }
  async function loadScreener() {
    const t = $("#screen-table");
    if (!scr.loaded) t.innerHTML = `<div class="loading">Screening ${SCREENER_UNIVERSE.length} stocks…</div>`;
    try {
      const data = await api("/api/quotes?symbols=" + encodeURIComponent(SCREENER_UNIVERSE.join(",")));
      scr.rows = (data.quotes || []).map((q) => {
        let rangePos = null;
        if (q.price != null && q.fiftyTwoWeekHigh != null && q.fiftyTwoWeekLow != null && q.fiftyTwoWeekHigh > q.fiftyTwoWeekLow) {
          rangePos = Math.max(0, Math.min(100, (q.price - q.fiftyTwoWeekLow) / (q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow) * 100));
        }
        return Object.assign({}, q, { rangePos });
      });
      scr.loaded = true;
      setSource((data.quotes || []).some((q) => q && q.source === "sim"));
      renderScreener();
    } catch (e) { if (!scr.loaded) t.innerHTML = `<div class="err">Screener data unavailable.</div>`; }
  }
  function setPreset(p) {
    scr.preset = p;
    if (p === "gainers") { scr.sortKey = "changePct"; scr.sortDir = -1; }
    else if (p === "losers") { scr.sortKey = "changePct"; scr.sortDir = 1; }
    else if (p === "high52") { scr.sortKey = "rangePos"; scr.sortDir = -1; }
    else if (p === "low52") { scr.sortKey = "rangePos"; scr.sortDir = 1; }
    else if (p === "active") { scr.sortKey = "volume"; scr.sortDir = -1; }
    else { scr.sortKey = "changePct"; scr.sortDir = -1; }
    $$("#screen-presets button").forEach((b) => b.classList.toggle("active", b.dataset.preset === p));
    renderScreener();
  }
  function renderScreener() {
    const t = $("#screen-table");
    const pmin = parseFloat($("#f-pmin").value), pmax = parseFloat($("#f-pmax").value);
    const prmin = parseFloat($("#f-prmin").value), prmax = parseFloat($("#f-prmax").value);
    let rows = scr.rows.filter((r) => r.price != null);
    if (scr.preset === "gainers") rows = rows.filter((r) => r.changePct > 0);
    if (scr.preset === "losers") rows = rows.filter((r) => r.changePct < 0);
    if ((scr.preset === "high52" || scr.preset === "low52")) rows = rows.filter((r) => r.rangePos != null);
    if (!isNaN(pmin)) rows = rows.filter((r) => r.changePct != null && r.changePct >= pmin);
    if (!isNaN(pmax)) rows = rows.filter((r) => r.changePct != null && r.changePct <= pmax);
    if (!isNaN(prmin)) rows = rows.filter((r) => r.price >= prmin);
    if (!isNaN(prmax)) rows = rows.filter((r) => r.price <= prmax);
    const k = scr.sortKey, dir = scr.sortDir;
    rows.sort((a, b) => {
      if (k === "symbol") return dir * a.symbol.localeCompare(b.symbol);
      const av = a[k] == null ? -Infinity : a[k], bv = b[k] == null ? -Infinity : b[k];
      return dir * (av - bv);
    });
    $("#screen-count").textContent = rows.length + " / " + scr.rows.length + " match";
    const arrow = (key) => k === key ? (dir < 0 ? " ▼" : " ▲") : "";
    const cls = (key) => k === key ? "sorted" : "";
    const head = `<div class="scr-head">
      <span class="${cls('symbol')}" data-sort="symbol">SYMBOL${arrow('symbol')}</span>
      <span class="num ${cls('price')}" data-sort="price">LAST${arrow('price')}</span>
      <span class="num ${cls('change')}" data-sort="change">CHG${arrow('change')}</span>
      <span class="num ${cls('changePct')}" data-sort="changePct">%CHG${arrow('changePct')}</span>
      <span class="${cls('rangePos')}" data-sort="rangePos">52W RANGE${arrow('rangePos')}</span>
      <span class="num ${cls('volume')}" data-sort="volume">VOL${arrow('volume')}</span></div>`;
    const prev = prevPx.SCREEN || (prevPx.SCREEN = {});
    const body = rows.map((r) => {
      const c = signClass(r.changePct);
      const rp = r.rangePos;
      const bar = rp == null ? "—" : `<div class="bar"><i style="left:${rp}%"></i></div><span class="pct">${rp.toFixed(0)}%</span>`;
      const fl = flashClass(prev[r.symbol], r.price);
      return `<div class="scr-row" data-sym="${esc(r.symbol)}">
        <div><span class="s-sym">${esc(r.symbol)}</span><div class="s-name">${esc(r.shortName || "")}</div></div>
        <div class="num ${fl}">${fmtNum(r.price)}</div>
        <div class="num ${c}">${r.change == null ? "—" : (r.change >= 0 ? "+" : "") + fmtNum(r.change)}</div>
        <div class="num ${c}">${fmtPct(r.changePct)}</div>
        <div class="s-range">${bar}</div>
        <div class="num">${fmtVol(r.volume)}</div></div>`;
    }).join("");
    const wrap = $(".screen-table-wrap");
    const sc = wrap ? wrap.scrollTop : 0;
    t.innerHTML = head + (body || `<div class="ks-note">No stocks match the current filters.</div>`);
    if (wrap) wrap.scrollTop = sc;
    rows.forEach((r) => { if (r.price != null) prev[r.symbol] = r.price; });
  }

  // ---------------- compare ----------------
  const comp = { symbols: ["AAPL", "MSFT", "GOOGL"], range: "6mo", interval: "1d", intraday: false, chart: null, reqId: 0 };
  function buildCompControls() {
    $("#compranges").innerHTML = RANGES.map((r) => `<button data-crange="${r.k}">${r.k}</button>`).join("");
    $$("#compranges button").forEach((b) => b.classList.toggle("active", b.dataset.crange === (RANGES.find((r) => r.range === comp.range) || {}).k));
    renderCompChips();
  }
  function renderCompChips() {
    $("#compchips").innerHTML = comp.symbols.map((s, i) => `<span class="comp-chip" style="border-color:${COMP_COLORS[i % COMP_COLORS.length]}"><span class="cc-dot" style="background:${COMP_COLORS[i % COMP_COLORS.length]}"></span>${esc(s)}<span class="cc-x" data-crem="${esc(s)}">✕</span></span>`).join("");
  }
  const COMP_COLORS = ["#ff9e1b", "#36a3ff", "#26c281", "#ff5cf0", "#ffd23f", "#c061ff", "#ff4d4d", "#00e0c6"];
  async function loadComp() {
    if (!comp.chart) comp.chart = new CompareChart($("#compchart"));
    buildCompControls();
    const myReq = ++comp.reqId;
    try {
      const results = await Promise.all(comp.symbols.map((s) =>
        api(`/api/chart?symbol=${encodeURIComponent(s)}&range=${comp.range}&interval=${comp.interval}&prov=1`).then((d) => ({ s, d })).catch(() => ({ s, d: null }))));
      if (myReq !== comp.reqId) return;
      let sim = false;
      const series = results.filter((r) => r.d && r.d.candles && r.d.candles.length).map((r) => {
        if (r.d.source === "sim") sim = true;
        return { symbol: r.s, points: r.d.candles.map((c) => ({ t: c.t, c: c.c })) };
      });
      setSource(sim);
      comp.chart.setData(series, { intraday: comp.intraday });
      setStatus(true, "COMPARE " + comp.symbols.join(" "));
    } catch (e) { setStatus(false, "COMPARE ERROR"); }
  }
  function showComp(symbols) {
    if (symbols && symbols.length) comp.symbols = symbols.slice(0, 8);
    showView("comp"); loadComp();
  }
  function compAdd(sym) { sym = normalizeSymbol(sym); if (!comp.symbols.includes(sym) && comp.symbols.length < 8) comp.symbols.push(sym); loadComp(); }
  function compRemove(sym) { comp.symbols = comp.symbols.filter((s) => s !== sym); loadComp(); }

  // ---------------- watchlist ----------------
  function getWatchlist() {
    try { return JSON.parse(localStorage.getItem("terminal.watchlist")) || ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN"]; }
    catch (e) { return ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN"]; }
  }
  function setWatchlist(list) { localStorage.setItem("terminal.watchlist", JSON.stringify(list)); }
  function addWatch(sym) {
    const l = getWatchlist(); if (!l.includes(sym)) { l.push(sym); setWatchlist(l); }
    loadGrid($("#watchtable"), getWatchlist(), { del: true, spark: true });
  }
  function delWatch(sym) {
    setWatchlist(getWatchlist().filter((s) => s !== sym));
    loadGrid($("#watchtable"), getWatchlist(), { del: true, spark: true });
  }

  // ---------------- news ----------------
  function newsItem(n) {
    const t = n.tickers && n.tickers.length ? `<span class="nt">${esc(n.tickers.slice(0, 3).join(" "))}</span>` : "";
    const href = n.link ? esc(n.link) : "#";
    return `<a class="news-item" href="${href}" target="_blank" rel="noopener noreferrer">
      <div class="news-title">${esc(n.title)} <span class="news-ext">↗</span></div>
      <div class="news-meta">${t}<span>${esc(n.publisher || "")}</span><span>${fmtTimeAgo(n.time)}</span></div>
    </a>`;
  }
  async function loadNews(container, q) {
    container.innerHTML = `<div class="loading">Loading news…</div>`;
    try {
      const data = await api("/api/news?q=" + encodeURIComponent(q));
      const items = (data.news || []).filter((n) => n.title);
      container.innerHTML = items.length ? items.map(newsItem).join("") : `<div class="ks-note">No headlines found.</div>`;
    } catch (e) { container.innerHTML = `<div class="err">News unavailable.</div>`; }
  }

  // ---------------- views ----------------
  function showView(v) {
    state.view = v;
    $("#view-home").classList.toggle("hidden", v !== "home");
    $("#view-sec").classList.toggle("hidden", v !== "sec");
    $("#view-heat").classList.toggle("hidden", v !== "heat");
    $("#view-comp").classList.toggle("hidden", v !== "comp");
    $("#view-screen").classList.toggle("hidden", v !== "screen");
    $("#view-tech").classList.toggle("hidden", v !== "tech");
    $$("#sectorbar .navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    if (v === "home") refreshHome();
  }

  // ---------------- security view ----------------
  function buildChartControls() {
    $("#ranges").innerHTML = RANGES.map((r) => `<button data-range="${r.k}">${r.k}</button>`).join("");
    $("#ctypes").innerHTML = ["candle", "line", "area"].map((t) => `<button data-ctype="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("");
    $("#cmas").innerHTML = [20, 50, 200].map((p) => `<button data-ma="${p}">MA${p}</button>`).join("");
    $("#cinds").innerHTML = [["bb", "BB"], ["ema", "EMA"], ["vwap", "VWAP"], ["fib", "FIB"], ["rsi", "RSI"], ["macd", "MACD"], ["stoch", "STOCH"], ["atr", "ATR"], ["obv", "OBV"]].map(([k, l]) => `<button data-ind="${k}">${l}</button>`).join("");
    syncControlButtons();
    $("#ranges").onclick = (e) => { const b = e.target.closest("[data-range]"); if (!b) return; const r = RANGES.find((x) => x.k === b.dataset.range); state.range = r.range; state.interval = r.interval; state.intraday = r.intraday; loadChart(); };
    $("#ctypes").onclick = (e) => { const b = e.target.closest("[data-ctype]"); if (!b) return; state.chartType = b.dataset.ctype; if (state.chart) state.chart.setType(state.chartType); syncControlButtons(); };
    $("#cmas").onclick = (e) => { const b = e.target.closest("[data-ma]"); if (!b) return; const p = +b.dataset.ma; state.smaOn[p] = !state.smaOn[p]; applySMA(); syncControlButtons(); };
    $("#cinds").onclick = (e) => { const b = e.target.closest("[data-ind]"); if (!b) return; const k = b.dataset.ind; state.ind[k] = !state.ind[k]; if (state.chart) state.chart.setIndicators(state.ind); syncControlButtons(); };
  }
  function syncControlButtons() {
    const curK = (RANGES.find((r) => r.range === state.range) || {}).k;
    $$("#ranges button").forEach((b) => b.classList.toggle("active", b.dataset.range === curK));
    $$("#ctypes button").forEach((b) => b.classList.toggle("active", b.dataset.ctype === state.chartType));
    $$("#cmas button").forEach((b) => b.classList.toggle("active", state.smaOn[+b.dataset.ma]));
    $$("#cinds button").forEach((b) => b.classList.toggle("active", state.ind[b.dataset.ind]));
  }
  function activeSMAPeriods() { return Object.keys(state.smaOn).filter((p) => state.smaOn[p]).map(Number); }
  function applySMA() { if (state.chart) state.chart.setSMA(state.intraday ? [] : activeSMAPeriods()); }

  function renderHeader(d) {
    const sym = d.symbol;
    const price = d.regularMarketPrice != null ? d.regularMarketPrice : (d.candles.length ? d.candles[d.candles.length - 1].c : null);
    const prev = d.previousClose;
    const chg = price != null && prev != null ? price - prev : null;
    const pct = chg != null && prev ? (chg / prev) * 100 : null;
    const dp = decimalsFor(sym, price);
    const cls = signClass(chg);
    $("#sh-ticker").textContent = sym;
    $("#sh-name").textContent = d.longName || d.shortName || NAMES[sym] || "";
    $("#sh-exch").textContent = [d.exchangeName, d.currency].filter(Boolean).join("  ·  ");
    const hfl = flashClass(state.lastHeaderPx, price);
    state.lastHeaderPx = price;
    $("#sh-last").innerHTML = `<span class="${cls} ${hfl}">${price == null ? "—" : fmtNum(price, dp)}</span>`;
    $("#sh-chg").innerHTML = `<span class="${cls}">${chg == null ? "" : (chg >= 0 ? "+" : "") + fmtNum(chg, dp)} (${fmtPct(pct)})</span>`;
    const stats = [
      ["OPEN", d.candles.length ? fmtNum(d.candles[d.candles.length - 1].o, dp) : "—"],
      ["PREV CLOSE", prev != null ? fmtNum(prev, dp) : "—"],
      ["DAY HIGH", d.regularMarketDayHigh != null ? fmtNum(d.regularMarketDayHigh, dp) : "—"],
      ["DAY LOW", d.regularMarketDayLow != null ? fmtNum(d.regularMarketDayLow, dp) : "—"],
      ["52W HIGH", d.fiftyTwoWeekHigh != null ? fmtNum(d.fiftyTwoWeekHigh, dp) : "—"],
      ["52W LOW", d.fiftyTwoWeekLow != null ? fmtNum(d.fiftyTwoWeekLow, dp) : "—"],
      ["VOLUME", fmtVol(d.regularMarketVolume)],
      ["AS OF", d.regularMarketTime ? new Date(d.regularMarketTime * 1000).toLocaleString("en-GB", { hour12: false }) : "—"],
    ];
    $("#sh-stats").innerHTML = stats.map(([l, v]) => `<div class="sh-stat"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");
    $("#sb-ticker").textContent = `${sym}  ${price == null ? "" : fmtNum(price, dp)}  ${chg == null ? "" : (chg >= 0 ? "+" : "") + fmtNum(chg, dp) + " " + fmtPct(pct)}`;
    $("#chart-title").innerHTML = `${esc(sym)} — ${(RANGES.find((r) => r.range === state.range) || {}).k} ${state.intraday ? "INTRADAY" : "DAILY"} <span style="color:#666;font-weight:400;letter-spacing:0">· scroll: zoom · drag: pan · dbl-click: reset</span>`;
  }

  async function loadChart() {
    syncControlButtons();
    const myReq = ++state.reqId;
    try {
      const d = await api(`/api/chart?symbol=${encodeURIComponent(state.symbol)}&range=${state.range}&interval=${state.interval}&prov=1&full=1`);
      if (myReq !== state.reqId) return; // a newer request superseded this one
      if (d.error) { setStatus(false, "SYMBOL ERROR: " + d.error); return; }
      state.lastChart = d;
      setSource(d.source === "sim");
      renderHeader(d);
      if (!state.chart) state.chart = new TerminalChart($("#chart"));
      // default visible window for the selected range (deep history is loaded; pan to reach it)
      const rr = RANGES.find((r) => r.range === state.range) || {};
      let viewBars = rr.viewBars;
      if (viewBars === "ytd") { const y = new Date().getFullYear(); viewBars = (d.candles || []).filter((c) => new Date(c.t * 1000).getFullYear() === y).length || 126; }
      state.chart.setData({
        candles: d.candles, type: state.chartType, intraday: state.intraday,
        smaPeriods: state.intraday ? [] : activeSMAPeriods(), indicators: state.ind, showVolume: true, currency: d.currency,
        dataId: state.symbol + ":" + state.interval, viewBars: viewBars,
      });
      setStatus(true, "LOADED " + state.symbol);
    } catch (e) { setStatus(false, "CHART ERROR"); }
  }

  function ksRow(l, v) { return `<div class="ks-row"><span class="l">${l}</span><span class="v">${v}</span></div>`; }
  function fmtKind(v, kind) {
    if (v == null || isNaN(v)) return "—";
    if (kind === "big") return fmtBig(v);
    if (kind === "pct") return (v * 100).toFixed(2) + "%";   // value is a fraction
    if (kind === "pct100") return v.toFixed(2) + "%";        // value already in %
    if (kind === "x") return v.toFixed(2) + "×";
    return fmtNum(v, 2);
  }
  function techSummaryHTML() {
    const d = state.lastChart;
    if (!d || !d.candles || d.candles.length < 35 || !window.TA) return "";
    const candles = d.candles, closes = candles.map((c) => c.c), T = window.TA;
    const price = d.regularMarketPrice != null ? d.regularMarketPrice : closes[closes.length - 1];
    const rsiV = lastVal(T.rsi(closes, 14));
    const m = T.macd(closes, 12, 26, 9), macdL = lastVal(m.line), macdS = lastVal(m.signal);
    const sma50 = lastVal(T.sma(closes, 50)), sma200 = lastVal(T.sma(closes, 200));
    let trend = "Sideways", tcls = "flat";
    if (sma50 != null && sma200 != null) {
      if (price > sma50 && sma50 > sma200) { trend = "Strong Uptrend"; tcls = "up"; }
      else if (price > sma200) { trend = "Uptrend"; tcls = "up"; }
      else if (price < sma50 && sma50 < sma200) { trend = "Strong Downtrend"; tcls = "down"; }
      else if (price < sma200) { trend = "Downtrend"; tcls = "down"; }
    }
    const rsiSig = rsiV == null ? "" : rsiV > 70 ? '<span class="down">Overbought</span>' : rsiV < 30 ? '<span class="up">Oversold</span>' : '<span class="flat">Neutral</span>';
    const macdSig = (macdL == null || macdS == null) ? "—" : macdL > macdS ? '<span class="up">Bullish ▲</span>' : '<span class="down">Bearish ▼</span>';
    let buy = 0, sell = 0;
    if (rsiV != null) { if (rsiV < 30) buy++; else if (rsiV > 70) sell++; }
    if (macdL != null && macdS != null) { macdL > macdS ? buy++ : sell++; }
    if (sma50 != null) { price > sma50 ? buy++ : sell++; }
    if (sma200 != null) { price > sma200 ? buy++ : sell++; }
    const tot = buy + sell, a = tot ? (buy - sell) / tot : 0;
    const vd = a > 0.5 ? ["STRONG BUY", "up"] : a > 0.1 ? ["BUY", "up"] : a < -0.5 ? ["STRONG SELL", "down"] : a < -0.1 ? ["SELL", "down"] : ["NEUTRAL", "flat"];
    const dp = decimalsFor(d.symbol, price);
    return `<div class="ks-section">TECHNICAL SUMMARY <span class="ks-src">TECH for full</span></div>`
      + ksRow("Trend", `<span class="${tcls}">${trend}</span>`)
      + ksRow("RSI (14)", rsiV == null ? "—" : rsiV.toFixed(1) + " &nbsp;" + rsiSig)
      + ksRow("MACD (12,26)", macdSig)
      + ksRow("Price vs SMA 50", sma50 == null ? "—" : `<span class="${price > sma50 ? "up" : "down"}">${price > sma50 ? "Above" : "Below"}</span> ${fmtNum(sma50, dp)}`)
      + ksRow("Price vs SMA 200", sma200 == null ? "—" : `<span class="${price > sma200 ? "up" : "down"}">${price > sma200 ? "Above" : "Below"}</span> ${fmtNum(sma200, dp)}`)
      + ksRow("Tech Signal", `<span class="${vd[1]}" style="font-weight:700">${vd[0]}</span>`);
  }
  function analystHTML(data) {
    const a = data.analyst;
    if (!a) return "";
    const cur = a.current != null ? a.current : (state.lastChart ? state.lastChart.regularMarketPrice : null);
    const upside = (a.targetMean != null && cur) ? (a.targetMean / cur - 1) * 100 : null;
    let html = `<div class="ks-section">ANALYST FORECASTS</div>`;
    html += ksRow("Price Target (avg)", a.targetMean == null ? "—" : fmtNum(a.targetMean, 2) + (upside != null ? ` <span class="${upside >= 0 ? "up" : "down"}">(${upside >= 0 ? "+" : ""}${upside.toFixed(1)}%)</span>` : ""));
    if (a.targetHigh != null || a.targetLow != null) html += ksRow("Target High / Low", `${a.targetHigh == null ? "—" : fmtNum(a.targetHigh, 2)} / ${a.targetLow == null ? "—" : fmtNum(a.targetLow, 2)}`);
    const dist = a.dist;
    if (dist) {
      const total = dist.strongBuy + dist.buy + dist.hold + dist.sell + dist.strongSell;
      const score = total ? (dist.strongBuy + dist.buy * 0.5 - dist.sell * 0.5 - dist.strongSell) / total : 0;
      const cons = score > 0.5 ? ["STRONG BUY", "up"] : score > 0.15 ? ["BUY", "up"] : score < -0.5 ? ["STRONG SELL", "down"] : score < -0.15 ? ["SELL", "down"] : ["HOLD", "flat"];
      html += ksRow("Consensus", `<span class="${cons[1]}" style="font-weight:700">${cons[0]}</span> <span class="flat">· ${total} analysts</span>`);
      const pct = (n) => total ? n / total * 100 : 0;
      html += `<div class="ks-row"><span class="l">Distribution</span><span class="v dist-cell"><span class="dist-bar"><i style="width:${pct(dist.strongBuy + dist.buy)}%;background:#26c281"></i><i style="width:${pct(dist.hold)}%;background:#6a6a6a"></i><i style="width:${pct(dist.sell + dist.strongSell)}%;background:#ff4d4d"></i></span></span></div>`;
      html += `<div class="ks-row"><span class="l" style="color:#555">buy/hold/sell</span><span class="v"><span class="up">${dist.strongBuy + dist.buy}</span> / <span class="flat">${dist.hold}</span> / <span class="down">${dist.sell + dist.strongSell}</span></span></div>`;
    }
    return html;
  }
  async function loadSummary(symbol) {
    const ks = $("#keystats"), pf = $("#profile");
    ks.innerHTML = `<div class="loading">Loading…</div>`;
    pf.innerHTML = `<div class="loading">Loading…</div>`;
    let data;
    try { data = await api("/api/summary?symbol=" + encodeURIComponent(symbol)); } catch (e) { data = { available: false }; }
    if (symbol !== state.symbol) return; // superseded
    if (!data.available) {
      ks.innerHTML = `<div class="ks-note">Detailed fundamentals aren't available for this symbol (indices, FX, commodities and crypto have no company fundamentals; for equities set a real-time API key for full coverage). Price, chart, range and news above are fully live.</div>`;
      pf.innerHTML = `<div class="ks-note">No company profile for this instrument.</div>`;
      return;
    }
    // ---- crypto-specific rendering (market cap, supply, ATH, performance) ----
    if (data.crypto) {
      const c = data.crypto, pctSpan = (v) => v == null ? "—" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(2)}%</span>`;
      const cr = [];
      cr.push(techSummaryHTML());
      cr.push(`<div class="ks-section">CRYPTO MARKET DATA <span class="ks-src">via CoinGecko</span></div>`);
      cr.push(ksRow("Market Cap", fmtBig(c.marketCap)));
      cr.push(ksRow("Market Cap Rank", c.rank != null ? "#" + c.rank : "—"));
      cr.push(ksRow("24h Volume", fmtBig(c.volume24h)));
      cr.push(ksRow("Circulating Supply", c.circulating != null ? fmtBig(c.circulating) : "—"));
      cr.push(ksRow("Max Supply", c.maxSupply != null ? fmtBig(c.maxSupply) : "∞ uncapped"));
      cr.push(ksRow("All-Time High", c.ath == null ? "—" : fmtNum(c.ath, 2) + (c.athChangePct != null ? ` <span class="${c.athChangePct >= 0 ? "up" : "down"}">(${c.athChangePct.toFixed(1)}%)</span>` : "")));
      cr.push(ksRow("24h High / Low", `${c.high24h == null ? "—" : fmtNum(c.high24h, 2)} / ${c.low24h == null ? "—" : fmtNum(c.low24h, 2)}`));
      cr.push(`<div class="ks-section">PERFORMANCE</div>`);
      cr.push(ksRow("24 Hours", pctSpan(c.chg24h)));
      cr.push(ksRow("7 Days", pctSpan(c.chg7d)));
      cr.push(ksRow("30 Days", pctSpan(c.chg30d)));
      cr.push(ksRow("1 Year", pctSpan(c.chg1y)));
      ks.innerHTML = cr.join("");
      const p = data.profile || {}, pr = [];
      if (p.name) pr.push(["Name", esc(p.name)]);
      if (p.sector) pr.push(["Type", esc(p.sector)]);
      if (p.industry) pr.push(["Category", esc(p.industry)]);
      if (p.website) pr.push(["Website", `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website)}</a>`]);
      let h = pr.map(([l, v]) => `<div class="pf-row"><span class="l">${l}</span><span class="v">${v}</span></div>`).join("");
      if (p.description) h += `<div class="pf-desc">${esc(p.description)}</div>`;
      pf.innerHTML = h || `<div class="ks-note">No profile.</div>`;
      return;
    }
    const s = data.stats || {}, srcLabel = data.source === "twelvedata" ? "Twelve Data" : data.source === "cnbc" ? "CNBC" : "Yahoo";
    const rows = [];
    rows.push(techSummaryHTML());   // RSI, trend, MACD, signal (from chart)
    rows.push(analystHTML(data));   // price targets + consensus (when available)
    rows.push(`<div class="ks-section">VALUATION <span class="ks-src">via ${srcLabel}</span></div>`);
    rows.push(ksRow("Market Cap", fmtKind(s.marketCap, "big")));
    rows.push(ksRow("Enterprise Value", fmtKind(s.enterpriseValue, "big")));
    rows.push(ksRow("Trailing P/E", fmtKind(s.trailingPE, "x")));
    rows.push(ksRow("Forward P/E", fmtKind(s.forwardPE, "x")));
    rows.push(ksRow("PEG Ratio", fmtKind(s.peg, "x")));
    rows.push(ksRow("Price / Sales", fmtKind(s.priceToSales, "x")));
    rows.push(ksRow("Price / Book", fmtKind(s.priceToBook, "x")));
    rows.push(`<div class="ks-section">PROFITABILITY & FINANCIALS</div>`);
    rows.push(ksRow("Revenue (ttm)", fmtKind(s.revenue, "big")));
    rows.push(ksRow("EBITDA", fmtKind(s.ebitda, "big")));
    rows.push(ksRow("Gross Margin", fmtKind(s.grossMargin, "pct")));
    rows.push(ksRow("Operating Margin", fmtKind(s.operatingMargin, "pct")));
    rows.push(ksRow("Profit Margin", fmtKind(s.profitMargin, "pct")));
    rows.push(ksRow("Return on Equity", fmtKind(s.roe, "pct")));
    rows.push(ksRow("EPS (ttm)", fmtKind(s.eps, "num")));
    rows.push(ksRow("Total Cash", fmtKind(s.totalCash, "big")));
    rows.push(ksRow("Total Debt", fmtKind(s.totalDebt, "big")));
    rows.push(`<div class="ks-section">DIVIDEND & RISK</div>`);
    rows.push(ksRow("Dividend Yield", fmtKind(s.dividendYield, "pct")));
    rows.push(ksRow("Payout Ratio", fmtKind(s.payoutRatio, "pct")));
    rows.push(ksRow("Beta", fmtKind(s.beta, "num")));
    rows.push(ksRow("Shares Out", fmtKind(s.sharesOut, "big")));
    rows.push(ksRow("52-Week Change", fmtKind(s.fiftyTwoWeekChange, "pct100")));
    if (s.targetMean != null) rows.push(ksRow("Analyst Target", fmtKind(s.targetMean, "num")));
    if (s.recommendation) rows.push(ksRow("Recommendation", esc(String(s.recommendation).toUpperCase())));
    if (data.earnings && data.earnings.length) {
      rows.push(`<div class="ks-section">EARNINGS — EST vs ACTUAL</div>`);
      data.earnings.forEach((e) => {
        const est = e.epsEstimate != null ? e.epsEstimate.toFixed(2) : "—";
        const hasAct = e.epsActual != null;
        const act = hasAct ? e.epsActual.toFixed(2) : "—";
        const sp = e.surprisePct;
        const spCls = sp == null ? "flat" : sp >= 0 ? "up" : "down";
        const tag = hasAct ? `<span class="${spCls}">act ${act} (${sp == null ? "—" : (sp >= 0 ? "+" : "") + sp.toFixed(1) + "%"})</span>` : `<span class="flat">upcoming</span>`;
        rows.push(`<div class="ks-row"><span class="l">${esc(e.date)}</span><span class="v">est ${est} · ${tag}</span></div>`);
      });
    }
    ks.innerHTML = rows.join("");

    // profile
    const p = data.profile || {};
    const pfRows = [];
    if (p.name) pfRows.push(["Name", esc(p.name)]);
    if (p.exchange) pfRows.push(["Exchange", esc(p.exchange)]);
    if (p.sector) pfRows.push(["Sector", esc(p.sector)]);
    if (p.industry) pfRows.push(["Industry", esc(p.industry)]);
    if (p.employees) pfRows.push(["Employees", Number(p.employees).toLocaleString("en-US")]);
    if (p.hq) pfRows.push(["HQ", esc(p.hq)]);
    if (p.country) pfRows.push(["Country", esc(p.country)]);
    if (p.currency) pfRows.push(["Currency", esc(p.currency)]);
    if (p.assetType) pfRows.push(["Type", esc(p.assetType)]);
    if (p.website) pfRows.push(["Website", `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website)}</a>`]);
    let html = pfRows.map(([l, v]) => `<div class="pf-row"><span class="l">${l}</span><span class="v">${v}</span></div>`).join("");
    if (p.description) html += `<div class="pf-desc">${esc(p.description)}</div>`;
    pf.innerHTML = html || `<div class="ks-note">No company profile (this looks like an index, FX pair, or commodity).</div>`;
  }

  async function loadSecurity(symbol) {
    state.symbol = symbol;
    state.lastHeaderPx = null; // don't flash on first paint of a new security
    showView("sec");
    $("#sh-ticker").textContent = symbol;
    $("#sb-left").textContent = "LOADING " + symbol + "…";
    buildChartControls();
    await loadChart();
    loadSummary(symbol);
    const d2 = await api("/api/chart?symbol=" + encodeURIComponent(symbol) + "&range=1d&interval=1d&prov=1").catch(() => ({}));
    const q = NAMES[symbol] || d2.longName || d2.shortName || symbol;
    state.newsQuery = q;
    loadNews($("#secnews"), q);
  }

  // ---------------- command parsing ----------------
  function normalizeSymbol(tok) {
    let s = tok.toUpperCase();
    if (ALIAS[s]) return ALIAS[s];
    return s;
  }
  function runCommand(raw) {
    const text = raw.trim();
    if (!text) return;
    const upper = text.toUpperCase();
    // search
    if (text.startsWith("/")) return doSearchOpen(text.slice(1));
    const tokens = upper.split(/\s+/);
    if (tokens[0] === "SE" || tokens[0] === "SEARCH") return doSearchOpen(text.replace(/^\s*\S+\s*/, ""));
    // navigation commands
    if (["HOME", "MON", "MONITOR", "WEI", "W", "WATCH"].includes(upper)) { showView("home"); if (upper === "W" || upper === "WATCH") $("#p-watch").scrollIntoView({ behavior: "smooth" }); return; }
    if (["TOP", "N", "NEWS"].includes(upper)) { showView("news"); showNews(); return; }
    if (["HEAT", "IMAP", "HEATMAP", "HMAP"].includes(upper)) { showHeat(); return; }
    if (["EQS", "SCREEN", "SCREENER"].includes(upper)) { showScreener(); return; }
    if (["TECH", "TA", "STUDY", "TECHNICALS"].includes(upper)) { showTech(); return; }
    if (["COMP", "COMPARE"].includes(tokens[0])) {
      const syms = tokens.slice(1).filter((t) => !YELLOW_KEYS.has(t)).map(normalizeSymbol);
      showComp(syms.length ? syms : null); return;
    }
    if (["ALRT", "ALERT", "ALERTS"].includes(upper)) { openAlerts(state.symbol); return; }
    if (["HELP", "H", "?"].includes(upper)) { openHelp(); return; }
    if (Object.keys(GROUPS).includes(upper) || ["INDEX", "CMDTY", "CRNCY", "GOVT", "CMDTYS"].includes(upper)) {
      const map = { INDEX: "INDICES", CMDTY: "COMMODITIES", CRNCY: "FX", GOVT: "RATES" };
      showView("home");
      const grp = map[upper] || upper;
      const panel = $(`.ptable[data-grid="${grp}"]`);
      if (panel) panel.closest(".panel").scrollIntoView({ behavior: "smooth" });
      return;
    }
    // otherwise: a security. Take first token (Bloomberg "AAPL US Equity" -> AAPL)
    let symTok = tokens[0];
    if (tokens.length > 1 && YELLOW_KEYS.has(tokens[tokens.length - 1])) symTok = tokens[0];
    const resolved = normalizeSymbol(symTok);
    if (state.view === "tech") { state.symbol = resolved; showTech(); return; }
    loadSecurity(resolved);
  }

  // news view reuses the home news panel area in a dedicated layout-less manner
  function showNews() {
    showView("home");
    $("#p-news-home").scrollIntoView({ behavior: "smooth" });
    loadNews($("#homenews"), "stock market");
  }

  // ---------------- autocomplete / search ----------------
  let acItems = [], acIdx = -1, acTimer = null;
  const acBox = $("#autocomplete");
  function renderAC() {
    if (!acItems.length) { acBox.classList.add("hidden"); return; }
    acBox.classList.remove("hidden");
    acBox.innerHTML = acItems.map((q, i) => `<div class="ac-item ${i === acIdx ? "active" : ""}" data-sym="${esc(q.symbol)}">
      <span class="ac-sym">${esc(q.symbol)}</span>
      <span class="ac-name">${esc(q.name || "")}</span>
      <span class="ac-type">${esc(q.exchange || q.type || "")}</span></div>`).join("");
  }
  function closeAC() { acItems = []; acIdx = -1; acBox.classList.add("hidden"); }
  async function doSearch(q) {
    if (!q || q.length < 1) { closeAC(); return; }
    let r = [];
    try { const d = await api("/api/search?q=" + encodeURIComponent(q)); r = d.quotes || []; } catch (e) { }
    acItems = mergeLocal(r, q); acIdx = -1; renderAC();
  }
  async function doSearchOpen(q) {
    const d = await api("/api/search?q=" + encodeURIComponent(q)).catch(() => ({ quotes: [] }));
    if (d.quotes && d.quotes.length) { acItems = d.quotes; acIdx = 0; renderAC(); $("#cmd").focus(); }
    else setStatus(false, "NO RESULTS FOR " + q);
  }

  // ---------------- events ----------------
  $("#cmdform").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#cmd").value;
    if (acIdx >= 0 && acItems[acIdx]) { const s = acItems[acIdx].symbol; closeAC(); $("#cmd").value = ""; loadSecurity(s); return; }
    closeAC(); $("#cmd").value = ""; runCommand(v);
  });
  $("#cmd").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    clearTimeout(acTimer);
    if (v.startsWith("/") || /\s/.test(v) || v.length < 2) { /* commands or short: no live search except for / */ }
    acTimer = setTimeout(() => { if (v.length >= 2 && !/^[\^]/.test(v)) doSearch(v); else closeAC(); }, 220);
  });
  $("#cmd").addEventListener("keydown", (e) => {
    if (acBox.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); acIdx = Math.min(acItems.length - 1, acIdx + 1); renderAC(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acIdx = Math.max(0, acIdx - 1); renderAC(); }
    else if (e.key === "Escape") { closeAC(); }
  });
  acBox.addEventListener("mousedown", (e) => {
    const it = e.target.closest(".ac-item"); if (!it) return;
    e.preventDefault(); closeAC(); $("#cmd").value = ""; loadSecurity(it.dataset.sym);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#cmdform")) closeAC(); });

  // sector bar
  $("#sectorbar").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.cmd === "help") return openHelp();
    if (b.dataset.cmd === "alerts") return openAlerts(state.symbol);
    if (b.dataset.view) { if (b.dataset.view === "news") showNews(); else if (b.dataset.view === "heat") showHeat(); else if (b.dataset.view === "comp") showComp(); else if (b.dataset.view === "screen") showScreener(); else if (b.dataset.view === "tech") showTech(); else showView("home"); return; }
    if (b.dataset.grp) { showView("home"); const p = $(`.ptable[data-grid="${b.dataset.grp}"]`); if (p) p.closest(".panel").scrollIntoView({ behavior: "smooth" }); }
  });

  // quote row clicks + delete (delegated on whole document for home grids)
  document.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); delWatch(del.dataset.del); return; }
    const row = e.target.closest(".qrow"); if (row) { loadSecurity(row.dataset.sym); return; }
    const tile = e.target.closest(".heat-tile"); if (tile) { loadSecurity(tile.dataset.sym); return; }
    const srow = e.target.closest(".scr-row"); if (srow) { loadSecurity(srow.dataset.sym); return; }
    // news items are native <a> links now — no JS needed
  });

  // ---- watchlist add (clickable, with autocomplete) ----
  const watchForm = $("#watchaddform"), watchInput = $("#watchadd"), watchAcBox = $("#watchac");
  let wac = [], wacIdx = -1, wacTimer = null;
  function openWatchAdd() { watchForm.classList.remove("hidden"); watchInput.value = ""; watchInput.focus(); }
  function closeWatchAdd() { watchForm.classList.add("hidden"); watchAcBox.classList.add("hidden"); wac = []; wacIdx = -1; }
  function renderWac() {
    if (!wac.length) { watchAcBox.classList.add("hidden"); return; }
    watchAcBox.classList.remove("hidden");
    watchAcBox.innerHTML = wac.map((q, i) => `<div class="ac-item ${i === wacIdx ? "active" : ""}" data-wsym="${esc(q.symbol)}">
      <span class="ac-sym">${esc(q.symbol)}</span><span class="ac-name">${esc(q.name || "")}</span><span class="ac-type">${esc(q.exchange || q.type || "")}</span></div>`).join("");
  }
  async function wsearch(q) {
    let r = [];
    try { const d = await api("/api/search?q=" + encodeURIComponent(q)); r = d.quotes || []; } catch (e) { }
    wac = mergeLocal(r, q); wacIdx = -1; renderWac();
  }
  function doWatchAdd(sym) {
    sym = (sym || "").trim(); if (!sym) return;
    addWatch(normalizeSymbol(sym));
    setStatus(true, "ADDED " + normalizeSymbol(sym) + " TO WATCHLIST");
    watchInput.value = ""; watchAcBox.classList.add("hidden"); wac = []; wacIdx = -1; watchInput.focus();
  }
  $("#addwatch").addEventListener("click", (e) => { e.preventDefault(); if (watchForm.classList.contains("hidden")) openWatchAdd(); else closeWatchAdd(); });
  watchInput.addEventListener("input", () => {
    const v = watchInput.value.trim(); clearTimeout(wacTimer);
    if (v.length >= 2 && !/^\^/.test(v)) wacTimer = setTimeout(() => wsearch(v), 200);
    else watchAcBox.classList.add("hidden");
  });
  watchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeWatchAdd(); return; }
    if (watchAcBox.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); wacIdx = Math.min(wac.length - 1, wacIdx + 1); renderWac(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); wacIdx = Math.max(0, wacIdx - 1); renderWac(); }
  });
  watchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    doWatchAdd(wacIdx >= 0 && wac[wacIdx] ? wac[wacIdx].symbol : watchInput.value);
  });
  watchAcBox.addEventListener("mousedown", (e) => { const it = e.target.closest("[data-wsym]"); if (!it) return; e.preventDefault(); doWatchAdd(it.dataset.wsym); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".watch-add-wrap")) closeWatchAdd(); });

  // compare controls
  $("#compform").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#compinput").value.trim(); if (v) compAdd(v); $("#compinput").value = ""; });
  $("#compchips").addEventListener("click", (e) => { const x = e.target.closest("[data-crem]"); if (x) compRemove(x.dataset.crem); });
  $("#compranges").addEventListener("click", (e) => { const b = e.target.closest("[data-crange]"); if (!b) return; const r = RANGES.find((x) => x.k === b.dataset.crange); comp.range = r.range; comp.interval = r.interval; comp.intraday = r.intraday; loadComp(); });

  // help overlay
  function openHelp() { $("#help").classList.remove("hidden"); }
  function closeHelp() { $("#help").classList.add("hidden"); }
  $("#help-close").addEventListener("click", closeHelp);
  $("#help").addEventListener("click", (e) => { if (e.target.id === "help") closeHelp(); });

  // global keys
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeHelp(); closeAC(); closeAlerts(); }
    if (e.key === "/" && document.activeElement !== $("#cmd")) { e.preventDefault(); $("#cmd").focus(); }
  });

  // ---------------- technical analysis (TECH) ----------------
  const tech = { reqId: 0 };
  function showTech() { showView("tech"); loadTech(); }
  function lastVal(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }
  function oscSig(v, lowBuy, highSell) { return v == null ? "neutral" : v < lowBuy ? "buy" : v > highSell ? "sell" : "neutral"; }
  function signNum(v) { return v == null ? "neutral" : v > 0 ? "buy" : v < 0 ? "sell" : "neutral"; }
  function actionCell(s) { return `<span class="act ${s}">${s === "buy" ? "BUY" : s === "sell" ? "SELL" : "NEUTRAL"}</span>`; }
  async function loadTech() {
    const sym = state.symbol || "AAPL";
    state.symbol = sym;
    $("#th-sym").textContent = sym;
    const myReq = ++tech.reqId;
    try {
      const d = await api(`/api/chart?symbol=${encodeURIComponent(sym)}&range=1y&interval=1d&prov=1`);
      if (myReq !== tech.reqId) return;
      if (d.error || !d.candles || d.candles.length < 35) { $("#tech-osc").innerHTML = `<div class="ks-note">Not enough data for technicals on ${esc(sym)}.</div>`; $("#tech-ma").innerHTML = ""; $("#tech-summary").innerHTML = ""; return; }
      setSource(d.source === "sim");
      renderTech(sym, d);
    } catch (e) { $("#tech-osc").innerHTML = `<div class="err">Technicals unavailable.</div>`; }
  }
  function renderTech(sym, d) {
    const candles = d.candles, closes = candles.map((c) => c.c);
    const price = d.regularMarketPrice != null ? d.regularMarketPrice : closes[closes.length - 1];
    const prev = d.previousClose, chg = (price != null && prev != null) ? price - prev : null, pct = (chg != null && prev) ? chg / prev * 100 : null;
    const dp = decimalsFor(sym, price), cls = signClass(chg);
    $("#th-last").innerHTML = `<span class="${cls}">${fmtNum(price, dp)}</span>`;
    $("#th-chg").innerHTML = chg == null ? "" : `<span class="${cls}">${(chg >= 0 ? "+" : "") + fmtNum(chg, dp)} (${fmtPct(pct)})</span>`;
    const T = window.TA;
    const rsiV = lastVal(T.rsi(closes, 14));
    const stoK = lastVal(T.stochastic(candles, 14, 3).k);
    const srsi = lastVal(T.stochRSI(closes, 14, 14));
    const m = T.macd(closes, 12, 26, 9), macdL = lastVal(m.line), macdS = lastVal(m.signal);
    const cciV = lastVal(T.cci(candles, 20));
    const wr = lastVal(T.williamsR(candles, 14));
    const ad = T.adx(candles, 14), adxV = lastVal(ad.adx), pdi = lastVal(ad.plusDI), mdi = lastVal(ad.minusDI);
    const momV = lastVal(T.momentum(closes, 10));
    const uo = lastVal(T.ultimateOsc(candles));
    const ao = lastVal(T.awesome(candles));
    const macdSig = (macdL == null || macdS == null) ? "neutral" : macdL > macdS ? "buy" : macdL < macdS ? "sell" : "neutral";
    const adxSig = (adxV == null || adxV <= 20 || pdi == null || mdi == null) ? "neutral" : (pdi > mdi ? "buy" : "sell");
    const osc = [
      ["RSI (14)", rsiV, oscSig(rsiV, 30, 70), 2],
      ["Stochastic %K (14)", stoK, oscSig(stoK, 20, 80), 2],
      ["Stochastic RSI (14)", srsi, oscSig(srsi, 20, 80), 2],
      ["MACD (12,26)", macdL, macdSig, "n"],
      ["CCI (20)", cciV, oscSig(cciV, -100, 100), 2],
      ["Williams %R (14)", wr, oscSig(wr, -80, -20), 2],
      ["ADX (14)", adxV, adxSig, 2],
      ["Momentum (10)", momV, signNum(momV), "n"],
      ["Ultimate Osc (7,14,28)", uo, oscSig(uo, 30, 70), 2],
      ["Awesome Osc", ao, signNum(ao), "n"],
    ];
    const maRows = [];
    [10, 20, 30, 50, 100, 200].forEach((p) => { const s = lastVal(T.sma(closes, p)); maRows.push(["SMA " + p, s, s == null ? "neutral" : (price > s ? "buy" : price < s ? "sell" : "neutral")]); });
    [10, 20, 30, 50, 100, 200].forEach((p) => { const e = lastVal(T.ema(closes, p)); maRows.push(["EMA " + p, e, e == null ? "neutral" : (price > e ? "buy" : price < e ? "sell" : "neutral")]); });
    const head = `<div class="tech-row tech-head"><span>INDICATOR</span><span class="num">VALUE</span><span class="act-h">ACTION</span></div>`;
    $("#tech-osc").innerHTML = head + osc.map(([n, v, s, fmt]) => `<div class="tech-row"><span>${n}</span><span class="num">${v == null ? "—" : (fmt === "n" ? fmtNum(v, 2) : v.toFixed(2))}</span>${actionCell(s)}</div>`).join("");
    $("#tech-ma").innerHTML = head + maRows.map(([n, v, s]) => `<div class="tech-row"><span>${n}</span><span class="num">${v == null ? "—" : fmtNum(v, dp)}</span>${actionCell(s)}</div>`).join("");
    const count = (arr) => arr.reduce((a, r) => { a[r[2]]++; return a; }, { buy: 0, sell: 0, neutral: 0 });
    const oc = count(osc), mc = count(maRows), all = { buy: oc.buy + mc.buy, sell: oc.sell + mc.sell, neutral: oc.neutral + mc.neutral };
    const verdict = (c) => { const tot = c.buy + c.sell + c.neutral, a = tot ? (c.buy - c.sell) / tot : 0; return { v: a > 0.5 ? "STRONG BUY" : a > 0.1 ? "BUY" : a < -0.5 ? "STRONG SELL" : a < -0.1 ? "SELL" : "NEUTRAL", cls: a > 0.1 ? "buy" : a < -0.1 ? "sell" : "neutral" }; };
    const gauge = (label, c) => { const vd = verdict(c); return `<div class="gauge"><div class="g-label">${label}</div><div class="g-verdict ${vd.cls}">${vd.v}</div><div class="g-counts"><span class="sell">${c.sell}</span><span class="neutral">${c.neutral}</span><span class="buy">${c.buy}</span></div></div>`; };
    $("#tech-summary").innerHTML = gauge("SUMMARY", all) + gauge("OSCILLATORS", oc) + gauge("MOVING AVERAGES", mc);
    const vd = verdict(all); const vtag = $("#tech-verdict-tag"); vtag.textContent = vd.v; vtag.className = "phead-r " + vd.cls;
  }

  // ---------------- price alerts ----------------
  function getAlerts() { try { return JSON.parse(localStorage.getItem("terminal.alerts")) || []; } catch (e) { return []; } }
  function setAlerts(a) { localStorage.setItem("terminal.alerts", JSON.stringify(a)); updateBell(); }
  function updateBell() {
    const a = getAlerts();
    const active = a.filter((x) => !x.triggered).length;
    const fired = a.some((x) => x.triggered);
    const c = $("#bell-count");
    c.textContent = a.length;
    c.classList.toggle("hidden", a.length === 0);
    $("#bell").classList.toggle("fired", fired);
  }
  function addAlert(sym, op, price) {
    sym = normalizeSymbol(sym); price = parseFloat(price);
    if (!sym || isNaN(price)) return;
    const a = getAlerts();
    a.push({ id: Date.now() + "" + Math.floor(Math.random() * 1000), sym, op, price, triggered: false, created: Date.now() });
    setAlerts(a); renderAlerts();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }
  function removeAlert(id) { setAlerts(getAlerts().filter((x) => x.id !== id)); renderAlerts(); }
  function renderAlerts() {
    const a = getAlerts();
    const el = $("#alertlist");
    if (!a.length) { el.innerHTML = `<div class="alert-empty">No alerts. Add one above (or use + ALERT on a security).</div>`; return; }
    el.innerHTML = a.map((x) => `<div class="alert-item ${x.triggered ? "triggered" : ""}">
      <div class="ai-main"><span class="ai-sym">${esc(x.sym)}</span> ${x.op === "above" ? "≥" : "≤"} ${fmtNum(x.price, decimalsFor(x.sym, x.price))}
        <div class="ai-state">${x.triggered ? "✓ TRIGGERED " + (x.lastPrice != null ? "at " + fmtNum(x.lastPrice) : "") : "armed"}</div></div>
      <span class="ai-x" data-alrm="${x.id}">✕</span></div>`).join("");
  }
  function openAlerts(prefillSym) {
    if (prefillSym) { $("#al-sym").value = prefillSym; if (state.lastChart && state.lastChart.regularMarketPrice) $("#al-price").value = state.lastChart.regularMarketPrice; }
    renderAlerts(); $("#alerts").classList.remove("hidden"); $("#al-sym").focus();
  }
  function closeAlerts() { $("#alerts").classList.add("hidden"); }
  function toast(title, msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<div class="t-h">🔔 ${esc(title)}</div><div>${esc(msg)}</div>`;
    $("#toast").appendChild(t);
    setTimeout(() => t.remove(), 9000);
    t.addEventListener("click", () => t.remove());
  }
  function fireAlert(al, price) {
    al.triggered = true; al.lastPrice = price;
    const msg = `${al.sym} ${al.op === "above" ? "≥" : "≤"} ${fmtNum(al.price)} — now ${fmtNum(price)}`;
    toast("PRICE ALERT", msg);
    $("#bell").classList.add("fired");
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("TERMINAL — Price Alert", { body: msg }); } catch (e) {}
    }
  }
  async function checkAlerts() {
    const a = getAlerts();
    const pending = a.filter((x) => !x.triggered);
    if (!pending.length) return;
    const syms = [...new Set(pending.map((x) => x.sym))];
    try {
      // use the live provider path and only fire on real (non-simulated) prices
      const results = await Promise.all(syms.map((s) =>
        api(`/api/chart?symbol=${encodeURIComponent(s)}&range=1d&interval=1d&prov=1`).then((d) => ({ s, d })).catch(() => ({ s, d: null }))));
      const px = {};
      results.forEach(({ s, d }) => {
        if (d && !d.error && d.source === "live" && d.regularMarketPrice != null) px[s] = d.regularMarketPrice;
      });
      let changed = false;
      a.forEach((al) => {
        if (al.triggered) return;
        const p = px[al.sym]; if (p == null) return; // skip when no live price available
        if ((al.op === "above" && p >= al.price) || (al.op === "below" && p <= al.price)) { fireAlert(al, p); changed = true; }
      });
      if (changed) { setAlerts(a); renderAlerts(); }
    } catch (e) {}
  }

  // ---------------- export ----------------
  function exportCSV() {
    const d = state.lastChart;
    if (!d || !d.candles) { setStatus(false, "NOTHING TO EXPORT"); return; }
    const lines = [];
    lines.push(`# ${d.symbol} — exported ${new Date().toISOString()}`);
    lines.push(`# Last,${d.regularMarketPrice},PrevClose,${d.previousClose},52wHigh,${d.fiftyTwoWeekHigh},52wLow,${d.fiftyTwoWeekLow},Currency,${d.currency || ""},Source,${d.source}`);
    lines.push("Date,Open,High,Low,Close,Volume");
    d.candles.forEach((c) => {
      const dt = new Date(c.t * 1000).toISOString();
      lines.push([dt, c.o, c.h, c.l, c.c, c.v].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${d.symbol}_${state.range}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(true, "EXPORTED " + d.symbol + ".csv");
  }

  // alerts/export events
  $("#bell").addEventListener("click", () => openAlerts());
  $("#alerts-close").addEventListener("click", closeAlerts);
  $("#alerts").addEventListener("click", (e) => { if (e.target.id === "alerts") closeAlerts(); });
  $("#alertform").addEventListener("submit", (e) => { e.preventDefault(); addAlert($("#al-sym").value, $("#al-op").value, $("#al-price").value); $("#al-price").value = ""; });
  $("#alertlist").addEventListener("click", (e) => { const x = e.target.closest("[data-alrm]"); if (x) removeAlert(x.dataset.alrm); });
  $("#act-alert").addEventListener("click", () => openAlerts(state.symbol));
  $("#act-watch2").addEventListener("click", () => { if (state.symbol) { addWatch(state.symbol); setStatus(true, "ADDED " + state.symbol + " TO WATCHLIST"); } });
  $("#act-csv").addEventListener("click", exportCSV);
  $("#act-print").addEventListener("click", () => window.print());

  // screener controls
  $("#screen-presets").addEventListener("click", (e) => { const b = e.target.closest("[data-preset]"); if (b) setPreset(b.dataset.preset); });
  $("#screen-table").addEventListener("click", (e) => {
    const h = e.target.closest("[data-sort]"); if (!h) return;
    const key = h.dataset.sort;
    if (scr.sortKey === key) scr.sortDir *= -1; else { scr.sortKey = key; scr.sortDir = key === "symbol" ? 1 : -1; }
    renderScreener();
  });
  ["#f-pmin", "#f-pmax", "#f-prmin", "#f-prmax"].forEach((id) => $(id).addEventListener("input", renderScreener));
  $("#f-reset").addEventListener("click", () => { ["#f-pmin", "#f-pmax", "#f-prmin", "#f-prmax"].forEach((id) => ($(id).value = "")); renderScreener(); });
  setInterval(checkAlerts, 20000);
  updateBell();

  // ---------------- news auto-refresh ----------------
  function refreshNews() {
    if (state.view === "sec" && state.symbol) loadNews($("#secnews"), state.newsQuery || state.symbol);
    else if (state.view === "home") loadNews($("#homenews"), "stock market");
  }
  setInterval(refreshNews, 60000);

  // ---------------- auto refresh ----------------
  setInterval(() => {
    if (state.view === "home") refreshHome();
    else if (state.view === "heat") loadHeat();
    else if (state.view === "comp") loadComp();
    else if (state.view === "screen") loadScreener();
    else if (state.view === "tech") loadTech();
    else if (state.view === "sec" && state.symbol) {
      // refresh via loadChart (same full=1 / dataId / viewBars -> preserves your pan & zoom)
      loadChart();
    }
  }, 6000);

  // ---------------- boot ----------------
  buildChartControls();
  showView("home");
  loadNews($("#homenews"), "stock market");
  $("#cmd").focus();
  window.__loadSecurity = loadSecurity; // debug hook
})();
