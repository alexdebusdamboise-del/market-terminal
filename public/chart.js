/* TerminalChart — a dependency-free canvas chart engine in the spirit of a
 * Bloomberg GP/GIP screen: candlesticks or line, stacked sub-panels (volume,
 * RSI, MACD), price overlays (SMA, EMA, Bollinger Bands), a right-hand price
 * axis, time axis, and a crosshair tooltip. */
(function () {
  "use strict";

  const THEME = {
    bg: "#000000",
    grid: "#161616",
    axis: "#2a2a2a",
    text: "#8a8a8a",
    textBright: "#d8d8d8",
    up: "#26c281",
    down: "#ff4d4d",
    line: "#ff9e1b",
    area0: "rgba(255,158,27,0.22)",
    area1: "rgba(255,158,27,0.00)",
    crosshair: "#ffb84d",
    sma: ["#36a3ff", "#ffd23f", "#c061ff"],
    ema: ["#00e0c6", "#ff7ad9"],
    bb: "#7a8aff",
    rsi: "#ffd23f",
    macd: "#36a3ff",
    signal: "#ff7ad9",
    vwap: "#ff5cf0",
    fib: "#c8a24a",
    stochK: "#36a3ff",
    stochD: "#ff7ad9",
    atr: "#00e0c6",
    obv: "#9fd356",
    compare: ["#ff9e1b", "#36a3ff", "#26c281", "#ff5cf0", "#ffd23f", "#c061ff", "#ff4d4d", "#00e0c6"],
  };

  function fmtNum(n, dp) {
    if (n == null || isNaN(n)) return "—";
    if (dp == null) {
      const a = Math.abs(n);
      dp = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    }
    return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtVol(v) {
    if (v == null || isNaN(v)) return "—";
    if (v >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
    return String(Math.round(v));
  }

  // ---- indicator math ----
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { out[i] = prev; continue; }
      prev = prev == null ? v : v * k + prev * (1 - k);
      if (i >= period - 1) out[i] = prev;
    }
    return out;
  }
  function bollinger(values, period, mult) {
    const mid = sma(values, period);
    const up = new Array(values.length).fill(null);
    const lo = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / period);
      up[i] = mid[i] + mult * sd;
      lo[i] = mid[i] - mult * sd;
    }
    return { mid, up, lo };
  }
  function rsi(values, period) {
    const out = new Array(values.length).fill(null);
    let gain = 0, loss = 0;
    for (let i = 1; i < values.length; i++) {
      const ch = values[i] - values[i - 1];
      const g = Math.max(0, ch), l = Math.max(0, -ch);
      if (i <= period) { gain += g; loss += l; if (i === period) { gain /= period; loss /= period; out[i] = 100 - 100 / (1 + (loss === 0 ? 100 : gain / loss)); } }
      else { gain = (gain * (period - 1) + g) / period; loss = (loss * (period - 1) + l) / period; out[i] = 100 - 100 / (1 + (loss === 0 ? 100 : gain / loss)); }
    }
    return out;
  }
  function macd(values, fast, slow, sig) {
    const ef = ema(values, fast), es = ema(values, slow);
    const line = values.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    const compact = line.map((v) => (v == null ? 0 : v));
    const signal = ema(compact, sig).map((v, i) => (line[i] == null ? null : v));
    const hist = line.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
    return { line, signal, hist };
  }
  function vwap(candles) {
    const out = []; let cumPV = 0, cumV = 0;
    for (const c of candles) {
      const tp = (c.h + c.l + c.c) / 3, v = c.v || 0;
      cumPV += tp * v; cumV += v;
      out.push(cumV > 0 ? cumPV / cumV : c.c);
    }
    return out;
  }
  function fibLevels(candles) {
    let lo = Infinity, hi = -Infinity, iLo = 0, iHi = 0;
    candles.forEach((c, i) => { if (c.l < lo) { lo = c.l; iLo = i; } if (c.h > hi) { hi = c.h; iHi = i; } });
    const span = hi - lo;
    const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    // if the high came first, retracement counts down from the high
    const desc = iHi < iLo;
    const levels = ratios.map((r) => ({ r, price: desc ? hi - span * r : lo + span * r }));
    return { lo, hi, levels };
  }
  function stochastic(candles, kP, dP) {
    const k = new Array(candles.length).fill(null);
    for (let i = kP - 1; i < candles.length; i++) {
      let ll = Infinity, hh = -Infinity;
      for (let j = i - kP + 1; j <= i; j++) { if (candles[j].l < ll) ll = candles[j].l; if (candles[j].h > hh) hh = candles[j].h; }
      k[i] = hh === ll ? 50 : 100 * (candles[i].c - ll) / (hh - ll);
    }
    const compact = k.map((v) => (v == null ? 0 : v));
    const d = sma(compact, dP).map((v, i) => (k[i] == null ? null : v));
    return { k, d };
  }
  function atr(candles, period) {
    const tr = new Array(candles.length).fill(null);
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (i === 0) { tr[i] = c.h - c.l; continue; }
      const pc = candles[i - 1].c;
      tr[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    }
    const out = new Array(candles.length).fill(null);
    let prev = null;
    for (let i = 0; i < candles.length; i++) {
      if (i < period) { if (i === period - 1) { let s = 0; for (let j = 0; j < period; j++) s += tr[j]; prev = s / period; out[i] = prev; } continue; }
      prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev;
    }
    return out;
  }
  function obv(candles) {
    const out = new Array(candles.length).fill(0);
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].c - candles[i - 1].c;
      out[i] = out[i - 1] + (d > 0 ? candles[i].v : d < 0 ? -candles[i].v : 0);
    }
    return out;
  }
  function cci(candles, period) {
    const out = new Array(candles.length).fill(null);
    const tp = candles.map((c) => (c.h + c.l + c.c) / 3);
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += tp[j];
      const ma = sum / period;
      let md = 0; for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - ma); md /= period;
      out[i] = md === 0 ? 0 : (tp[i] - ma) / (0.015 * md);
    }
    return out;
  }
  function williamsR(candles, period) {
    const out = new Array(candles.length).fill(null);
    for (let i = period - 1; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) { if (candles[j].h > hh) hh = candles[j].h; if (candles[j].l < ll) ll = candles[j].l; }
      out[i] = hh === ll ? -50 : -100 * (hh - candles[i].c) / (hh - ll);
    }
    return out;
  }
  function roc(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period; i < values.length; i++) { const p = values[i - period]; out[i] = p ? (values[i] / p - 1) * 100 : null; }
    return out;
  }
  function momentum(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period; i < values.length; i++) out[i] = values[i] - values[i - period];
    return out;
  }
  function stochRSI(values, rsiP, stochP) {
    const r = rsi(values, rsiP);
    const out = new Array(values.length).fill(null);
    for (let i = stochP - 1; i < values.length; i++) {
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let j = i - stochP + 1; j <= i; j++) { if (r[j] == null) { ok = false; break; } if (r[j] < lo) lo = r[j]; if (r[j] > hi) hi = r[j]; }
      if (ok) out[i] = hi === lo ? 50 : 100 * (r[i] - lo) / (hi - lo);
    }
    return out;
  }
  function adx(candles, period) {
    const n = candles.length;
    const pDM = new Array(n).fill(0), mDM = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = candles[i].h - candles[i - 1].h, dn = candles[i - 1].l - candles[i].l;
      pDM[i] = (up > dn && up > 0) ? up : 0;
      mDM[i] = (dn > up && dn > 0) ? dn : 0;
      const c = candles[i], pc = candles[i - 1].c;
      tr[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    }
    const sm = (arr) => { const o = new Array(n).fill(null); let s = 0; for (let i = 1; i < n; i++) { if (i <= period) { s += arr[i]; if (i === period) o[i] = s; } else { o[i] = o[i - 1] - o[i - 1] / period + arr[i]; } } return o; };
    const sP = sm(pDM), sM = sm(mDM), sTR = sm(tr);
    const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
      if (sTR[i]) { plusDI[i] = 100 * sP[i] / sTR[i]; minusDI[i] = 100 * sM[i] / sTR[i]; const su = plusDI[i] + minusDI[i]; dx[i] = su ? 100 * Math.abs(plusDI[i] - minusDI[i]) / su : 0; }
    }
    const adxArr = new Array(n).fill(null); let started = false, sumDX = 0, c2 = 0;
    for (let i = period; i < n; i++) { if (dx[i] == null) continue; if (!started) { sumDX += dx[i]; c2++; if (c2 === period) { adxArr[i] = sumDX / period; started = true; } } else { adxArr[i] = (adxArr[i - 1] * (period - 1) + dx[i]) / period; } }
    return { adx: adxArr, plusDI, minusDI };
  }
  function ultimateOsc(candles) {
    const n = candles.length; const bp = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) { const c = candles[i], pc = candles[i - 1].c; const low = Math.min(c.l, pc), high = Math.max(c.h, pc); bp[i] = c.c - low; tr[i] = high - low; }
    const out = new Array(n).fill(null);
    const sr = (arr, i, p) => { let s = 0; for (let j = i - p + 1; j <= i; j++) s += arr[j]; return s; };
    for (let i = 28; i < n; i++) { const trd = sr(tr, i, 7), a7 = trd ? sr(bp, i, 7) / trd : 0; const t14 = sr(tr, i, 14), a14 = t14 ? sr(bp, i, 14) / t14 : 0; const t28 = sr(tr, i, 28), a28 = t28 ? sr(bp, i, 28) / t28 : 0; out[i] = 100 * (4 * a7 + 2 * a14 + a28) / 7; }
    return out;
  }
  function awesome(candles) {
    const med = candles.map((c) => (c.h + c.l) / 2);
    const s5 = sma(med, 5), s34 = sma(med, 34);
    return med.map((_, i) => (s5[i] != null && s34[i] != null) ? s5[i] - s34[i] : null);
  }

  class TerminalChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.candles = [];
      this.type = "candle";
      this.intraday = false;
      this.smaPeriods = [];
      this.showVolume = true;
      this.ind = { bb: false, ema: false, rsi: false, macd: false, vwap: false, fib: false, stoch: false, atr: false, obv: false };
      this.currency = "";
      this.hover = null;
      this.viewSpan = 0; this.viewRight = 0; this._dataId = null; this._prevN = 0;
      this._dragging = false;
      this.dpr = window.devicePixelRatio || 1;
      this._bind();
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement);
      this.resize();
    }

    _bind() {
      const c = this.canvas;
      c.style.cursor = "crosshair";
      c.addEventListener("mousemove", (e) => {
        const r = c.getBoundingClientRect();
        this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
        if (!this._dragging) { this._updateHover(); this.render(); }
      });
      c.addEventListener("mouseleave", () => { if (!this._dragging) { this.mouse = null; this.hover = null; this.render(); } });
      // wheel = zoom around cursor (continuous; viewSpan = visible width in candle-slots)
      c.addEventListener("wheel", (e) => {
        if (!this.candles.length) return;
        e.preventDefault();
        const L = this._layout();
        const r = c.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, ((e.clientX - r.left) - L.plotLeft) / Math.max(1, L.plotRight - L.plotLeft)));
        const leftPos = this.viewRight - this.viewSpan;
        const posC = leftPos + frac * this.viewSpan;                 // index-position under cursor
        const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        this.viewSpan = this.viewSpan * factor;
        this.viewRight = posC + (1 - frac) * this.viewSpan;          // keep cursor anchored
        this._clampView(); this._updateHover(); this.render();
      }, { passive: false });
      // drag = pan (LEFT -> back in time; RIGHT -> forward / into the empty right margin)
      c.addEventListener("mousedown", (e) => {
        if (!this.candles.length) return;
        this._dragging = true; this._dragX = e.clientX; this._dragRight = this.viewRight;
        c.style.cursor = "grabbing";
      });
      window.addEventListener("mousemove", (e) => {
        if (!this._dragging) return;
        const L = this._layout(), plotW = Math.max(1, L.plotRight - L.plotLeft);
        const dPos = (e.clientX - this._dragX) / plotW * this.viewSpan;
        this.viewRight = this._dragRight + dPos;
        this._clampView(); this.render();
      });
      window.addEventListener("mouseup", () => { if (this._dragging) { this._dragging = false; c.style.cursor = "crosshair"; } });
      // double-click = reset to the range's default window with a right margin
      c.addEventListener("dblclick", () => { this._resetView(this.candles.length, this._lastVB); this.render(); });
    }

    _resetView(n, vb) {
      let visN;
      if (vb === null) visN = n;                                  // show all loaded history
      else if (vb === undefined) visN = Math.min(n, Math.max(30, Math.round(n * 0.6)));
      else visN = Math.min(n, Math.max(8, vb));                   // the range's nominal window
      const margin = Math.max(3, Math.round(visN * 0.1));         // empty slots on the right
      this.viewSpan = visN + margin;
      this.viewRight = (n - 1) + margin;
      this._clampView();
    }

    _clampView() {
      const n = this.candles.length;
      if (n === 0) { this.viewSpan = 0; this.viewRight = 0; return; }
      this.viewSpan = Math.max(8, Math.min(this.viewSpan, n + Math.round(n * 0.3) + 30));
      const maxRight = (n - 1) + this.viewSpan * 0.45;   // cap empty space on the right
      if (this.viewRight > maxRight) this.viewRight = maxRight;
      const minRight = Math.min(n - 1, this.viewSpan - 1) + 0.0001;   // keep candles in view (no big left gap)
      if (this.viewSpan <= n && this.viewRight < minRight) this.viewRight = minRight;
      if (this.viewRight < Math.min(n - 1, 4)) this.viewRight = Math.min(n - 1, 4);
    }

    setData(opts) {
      this.candles = opts.candles || [];
      if (opts.type) this.type = opts.type;
      if (opts.intraday != null) this.intraday = opts.intraday;
      if (opts.smaPeriods) this.smaPeriods = opts.smaPeriods;
      if (opts.showVolume != null) this.showVolume = opts.showVolume;
      if (opts.indicators) this.ind = Object.assign({}, this.ind, opts.indicators);
      if (opts.currency != null) this.currency = opts.currency;
      this._compute();
      const n = this.candles.length;
      const newId = opts.dataId != null ? opts.dataId : this._dataId;
      const vb = opts.viewBars;   // default visible candle count (number, null=all, or undefined=unchanged)
      if (newId !== this._dataId || this.viewSpan <= 0) {
        this._dataId = newId; this._lastVB = vb;
        this._resetView(n, vb);   // new symbol/granularity -> default window + right margin
      } else if (vb !== undefined && vb !== this._lastVB) {
        this._lastVB = vb;
        this._resetView(n, vb);   // same data, different range button -> re-window
      } else {
        // refresh of same data: follow the live edge if we were at it, else keep
        const grew = n - this._prevN;
        if (this.viewRight >= this._prevN - 1 - 0.5 && grew !== 0) this.viewRight += grew;
        this._clampView();
      }
      this._prevN = n;
      this.render();
    }
    setType(t) { this.type = t; this.render(); }
    setSMA(periods) { this.smaPeriods = periods; this._compute(); this.render(); }
    setIndicators(obj) { this.ind = Object.assign({}, this.ind, obj); this._compute(); this.render(); }
    toggleVolume() { this.showVolume = !this.showVolume; this.render(); }

    _compute() {
      const closes = this.candles.map((c) => c.c);
      this.smaSeries = (this.smaPeriods || []).map((p) => ({ period: p, data: sma(closes, p) }));
      this.bb = this.ind.bb ? bollinger(closes, 20, 2) : null;
      this.emaSeries = this.ind.ema ? [{ period: 12, data: ema(closes, 12) }, { period: 26, data: ema(closes, 26) }] : [];
      this.rsiData = this.ind.rsi ? rsi(closes, 14) : null;
      this.macdData = this.ind.macd ? macd(closes, 12, 26, 9) : null;
      this.vwapData = this.ind.vwap ? vwap(this.candles) : null;
      this.fib = this.ind.fib ? fibLevels(this.candles) : null;
      this.stochData = this.ind.stoch ? stochastic(this.candles, 14, 3) : null;
      this.atrData = this.ind.atr ? atr(this.candles, 14) : null;
      this.obvData = this.ind.obv ? obv(this.candles) : null;
    }

    resize() {
      const parent = this.canvas.parentElement;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
      this.W = w; this.H = h;
      this.render();
    }

    _layout() {
      const padTop = 10, padBottom = 22, axisW = 64, padLeft = 6, gap = 8;
      const plotLeft = padLeft, plotRight = this.W - axisW;
      const top = padTop, bottomLimit = this.H - padBottom;
      const totalH = bottomLimit - top;
      const lowers = [];
      if (this.showVolume) lowers.push("vol");
      if (this.rsiData) lowers.push("rsi");
      if (this.macdData) lowers.push("macd");
      if (this.stochData) lowers.push("stoch");
      if (this.atrData) lowers.push("atr");
      if (this.obvData) lowers.push("obv");
      const minPrice = 70;
      let eachH = 0;
      if (lowers.length) {
        const avail = totalH - minPrice - lowers.length * gap;
        eachH = Math.max(28, Math.min(120, Math.min(totalH * 0.2, avail / lowers.length)));
      }
      const used = lowers.length ? lowers.length * eachH + lowers.length * gap : 0;
      const priceH = Math.max(minPrice, totalH - used);
      const priceTop = top, priceBottom = top + priceH;
      let y = priceBottom + gap;
      const panels = lowers.map((name) => { const o = { name, top: y, bottom: y + eachH }; y += eachH + gap; return o; });
      const bottomMost = panels.length ? panels[panels.length - 1].bottom : priceBottom;
      return { plotLeft, plotRight, priceTop, priceBottom, axisW, panels, bottomMost };
    }

    _updateHover() {
      const N = this.candles.length;
      if (!this.mouse || N === 0 || this.viewSpan <= 0) { this.hover = null; return; }
      const L = this._layout();
      const leftPos = this.viewRight - this.viewSpan;
      const iFrom = Math.max(0, Math.floor(leftPos));
      const x = Math.max(L.plotLeft, Math.min(L.plotRight, this.mouse.x));
      const frac = (x - L.plotLeft) / Math.max(1, L.plotRight - L.plotLeft);
      const gIdx = Math.round(leftPos + frac * this.viewSpan);   // global candle index under cursor
      this.hover = Math.max(0, Math.min(N - 1, gIdx)) - iFrom;    // -> local index into the rendered slice
    }

    render() {
      const ctx = this.ctx;
      if (!this.W) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.fillStyle = THEME.bg;
      ctx.fillRect(0, 0, this.W, this.H);
      if (!this.candles.length) {
        ctx.fillStyle = THEME.text; ctx.font = "12px ui-monospace, Menlo, monospace";
        ctx.textAlign = "center"; ctx.fillText("NO DATA", this.W / 2, this.H / 2); return;
      }
      // ---- zoom/pan: render the visible window (continuous viewSpan/viewRight; viewRight may exceed the last candle -> empty right margin) ----
      const _F = { c: this.candles, sma: this.smaSeries, ema: this.emaSeries, bb: this.bb, vwap: this.vwapData, fib: this.fib, rsi: this.rsiData, macd: this.macdData, stoch: this.stochData, atr: this.atrData, obv: this.obvData };
      const _N = _F.c.length;
      if (this.viewSpan <= 0) this._resetView(_N);
      this._clampView();
      const _span = this.viewSpan, _leftPos = this.viewRight - _span;
      const _iFrom = Math.max(0, Math.floor(_leftPos));
      const _iTo = Math.min(_N - 1, Math.ceil(this.viewRight));
      const _lo = _iFrom, _hi = Math.max(_iFrom, _iTo);
      const _sl = (a) => a ? a.slice(_lo, _hi + 1) : a;
      try {
        this.candles = _F.c.slice(_lo, _hi + 1);
        this.smaSeries = _F.sma ? _F.sma.map((s) => ({ period: s.period, data: _sl(s.data) })) : _F.sma;
        this.emaSeries = _F.ema ? _F.ema.map((s) => ({ period: s.period, data: _sl(s.data) })) : _F.ema;
        this.bb = _F.bb ? { mid: _sl(_F.bb.mid), up: _sl(_F.bb.up), lo: _sl(_F.bb.lo) } : null;
        this.vwapData = _sl(_F.vwap);
        this.fib = _F.fib ? fibLevels(this.candles) : null;
        this.rsiData = _sl(_F.rsi);
        this.macdData = _F.macd ? { line: _sl(_F.macd.line), signal: _sl(_F.macd.signal), hist: _sl(_F.macd.hist) } : null;
        this.stochData = _F.stoch ? { k: _sl(_F.stoch.k), d: _sl(_F.stoch.d) } : null;
        this.atrData = _sl(_F.atr);
        this.obvData = _sl(_F.obv);
      const L = this._layout();
      const n = this.candles.length;
      const pitch = (L.plotRight - L.plotLeft) / _span;            // px per candle slot
      this._pitch = pitch;
      const xOf = (iLocal) => L.plotLeft + ((_iFrom + iLocal) - _leftPos) * pitch;

      // ---- price range (include overlays) ----
      let lo = Infinity, hi = -Infinity;
      for (const c of this.candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
      const addArr = (arr) => { for (const v of arr) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } };
      for (const s of (this.smaSeries || [])) addArr(s.data);
      for (const s of (this.emaSeries || [])) addArr(s.data);
      if (this.bb) { addArr(this.bb.up); addArr(this.bb.lo); }
      if (this.vwapData) addArr(this.vwapData);
      if (lo === hi) { lo -= 1; hi += 1; }
      const padR = (hi - lo) * 0.06; lo -= padR; hi += padR;
      const yOf = (p) => L.priceBottom - ((p - lo) / (hi - lo)) * (L.priceBottom - L.priceTop);

      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 6; i++) {
        const p = lo + (i / 6) * (hi - lo), y = yOf(p);
        ctx.strokeStyle = THEME.grid; ctx.beginPath(); ctx.moveTo(L.plotLeft, y); ctx.lineTo(L.plotRight, y); ctx.stroke();
        ctx.fillStyle = THEME.text; ctx.textAlign = "left"; ctx.fillText(fmtNum(p), L.plotRight + 6, y);
      }

      // ---- Bollinger fill + bands ----
      if (this.bb) {
        ctx.fillStyle = "rgba(122,138,255,0.08)";
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) { if (this.bb.up[i] == null) continue; const x = xOf(i), y = yOf(this.bb.up[i]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
        for (let i = n - 1; i >= 0; i--) { if (this.bb.lo[i] == null) continue; ctx.lineTo(xOf(i), yOf(this.bb.lo[i])); }
        ctx.closePath(); ctx.fill();
        const band = (arr, dash) => { ctx.strokeStyle = THEME.bb; ctx.lineWidth = 1; ctx.setLineDash(dash || []); ctx.beginPath(); let st = false; for (let i = 0; i < n; i++) { if (arr[i] == null) { st = false; continue; } const x = xOf(i), y = yOf(arr[i]); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); } ctx.stroke(); ctx.setLineDash([]); };
        band(this.bb.up, [2, 2]); band(this.bb.lo, [2, 2]); band(this.bb.mid, []);
      }

      // ---- price series ----
      if (this.type === "candle") {
        const bw = Math.max(1, pitch * 0.62);
        for (let i = 0; i < n; i++) {
          const c = this.candles[i], x = xOf(i), up = c.c >= c.o, col = up ? THEME.up : THEME.down;
          ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, yOf(c.h)); ctx.lineTo(x, yOf(c.l)); ctx.stroke();
          const yo = yOf(c.o), yc = yOf(c.c), t = Math.min(yo, yc); let bh = Math.abs(yc - yo); if (bh < 1) bh = 1;
          if (bw <= 1.5) { ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + bh); ctx.stroke(); } else ctx.fillRect(x - bw / 2, t, bw, bh);
        }
      } else {
        ctx.beginPath();
        for (let i = 0; i < n; i++) { const x = xOf(i), y = yOf(this.candles[i].c); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        if (this.type === "area") {
          const grad = ctx.createLinearGradient(0, L.priceTop, 0, L.priceBottom);
          grad.addColorStop(0, THEME.area0); grad.addColorStop(1, THEME.area1);
          ctx.lineTo(xOf(n - 1), L.priceBottom); ctx.lineTo(xOf(0), L.priceBottom); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
          ctx.beginPath(); for (let i = 0; i < n; i++) { const x = xOf(i), y = yOf(this.candles[i].c); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        }
        ctx.strokeStyle = THEME.line; ctx.lineWidth = 1.4; ctx.stroke(); ctx.lineWidth = 1;
      }

      // ---- SMA / EMA overlays ----
      const drawLine = (arr, color) => { ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath(); let st = false; for (let i = 0; i < n; i++) { const v = arr[i]; if (v == null) { st = false; continue; } const x = xOf(i), y = yOf(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); } ctx.stroke(); ctx.lineWidth = 1; };
      (this.smaSeries || []).forEach((s, idx) => drawLine(s.data, THEME.sma[idx % THEME.sma.length]));
      (this.emaSeries || []).forEach((s, idx) => drawLine(s.data, THEME.ema[idx % THEME.ema.length]));
      if (this.vwapData) drawLine(this.vwapData, THEME.vwap);

      // ---- Fibonacci retracement ----
      if (this.fib) {
        ctx.font = "10px ui-monospace, Menlo, monospace"; ctx.textBaseline = "middle";
        for (const lv of this.fib.levels) {
          const y = yOf(lv.price);
          if (y < L.priceTop || y > L.priceBottom) continue;
          ctx.strokeStyle = "rgba(200,162,74,0.35)"; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(L.plotLeft, y); ctx.lineTo(L.plotRight, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = THEME.fib; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
          ctx.fillText((lv.r * 100).toFixed(1) + "%  " + fmtNum(lv.price), L.plotRight - 4, y - 2);
          ctx.textBaseline = "middle";
        }
      }

      // ---- price legend ----
      ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "10px ui-monospace, Menlo, monospace";
      let lx = L.plotLeft + 6, ly = L.priceTop + 6;
      const legend = (txt, col) => { ctx.fillStyle = col; ctx.fillText(txt, lx, ly); lx += ctx.measureText(txt).width + 12; };
      (this.smaSeries || []).forEach((s, idx) => legend("MA" + s.period, THEME.sma[idx % THEME.sma.length]));
      (this.emaSeries || []).forEach((s, idx) => legend("EMA" + s.period, THEME.ema[idx % THEME.ema.length]));
      if (this.bb) legend("BB(20,2)", THEME.bb);
      if (this.vwapData) legend("VWAP", THEME.vwap);
      if (this.fib) legend("FIB", THEME.fib);

      // ---- lower panels ----
      for (const p of L.panels) {
        ctx.strokeStyle = THEME.axis; ctx.beginPath(); ctx.moveTo(L.plotLeft, p.bottom); ctx.lineTo(L.plotRight, p.bottom); ctx.stroke();
        if (p.name === "vol") this._drawVolume(ctx, L, p, xOf, n);
        else if (p.name === "rsi") this._drawRSI(ctx, L, p, xOf, n);
        else if (p.name === "macd") this._drawMACD(ctx, L, p, xOf, n);
        else if (p.name === "stoch") this._drawStoch(ctx, L, p, xOf, n);
        else if (p.name === "atr") this._drawATR(ctx, L, p, xOf, n);
        else if (p.name === "obv") this._drawOBV(ctx, L, p, xOf, n);
      }

      // ---- time axis ----
      ctx.fillStyle = THEME.text; ctx.textAlign = "center"; ctx.textBaseline = "top";
      const labelCount = Math.min(7, n);
      for (let k = 0; k < labelCount; k++) {
        const i = Math.round((k / (labelCount - 1 || 1)) * (n - 1));
        const d = new Date(this.candles[i].t * 1000);
        const label = this.intraday ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
          : d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "2-digit" });
        ctx.fillText(label, Math.max(L.plotLeft + 18, Math.min(L.plotRight - 18, xOf(i))), L.bottomMost + 5);
      }

      // ---- crosshair + tooltip ----
      if (this.hover != null && this.mouse) this._drawCrosshair(ctx, L, xOf, yOf, lo, hi);
      } finally {
        this.candles = _F.c; this.smaSeries = _F.sma; this.emaSeries = _F.ema; this.bb = _F.bb;
        this.vwapData = _F.vwap; this.fib = _F.fib; this.rsiData = _F.rsi; this.macdData = _F.macd;
        this.stochData = _F.stoch; this.atrData = _F.atr; this.obvData = _F.obv;
      }
    }

    _drawVolume(ctx, L, p, xOf, n) {
      let vmax = 0; for (const c of this.candles) if (c.v > vmax) vmax = c.v; vmax = vmax || 1;
      const bw = Math.max(1, (this._pitch || (L.plotRight - L.plotLeft) / n) * 0.7);
      for (let i = 0; i < n; i++) {
        const c = this.candles[i], h = (c.v / vmax) * (p.bottom - p.top), x = xOf(i);
        ctx.fillStyle = (c.c >= c.o) ? "rgba(38,194,129,0.45)" : "rgba(255,77,77,0.45)";
        ctx.fillRect(x - bw / 2, p.bottom - h, bw, h);
      }
      ctx.fillStyle = THEME.text; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillText("VOL", L.plotLeft + 6, p.top + 3);
      ctx.textBaseline = "middle"; ctx.fillText(fmtVol(vmax), L.plotRight + 6, p.top + 6);
    }

    _drawRSI(ctx, L, p, xOf, n) {
      const yOf = (v) => p.bottom - (v / 100) * (p.bottom - p.top);
      [30, 50, 70].forEach((lvl) => { ctx.strokeStyle = lvl === 50 ? THEME.grid : "rgba(255,210,63,0.18)"; ctx.setLineDash(lvl === 50 ? [] : [2, 3]); ctx.beginPath(); ctx.moveTo(L.plotLeft, yOf(lvl)); ctx.lineTo(L.plotRight, yOf(lvl)); ctx.stroke(); ctx.setLineDash([]); });
      ctx.strokeStyle = THEME.rsi; ctx.lineWidth = 1.2; ctx.beginPath(); let st = false;
      for (let i = 0; i < n; i++) { const v = this.rsiData[i]; if (v == null) { st = false; continue; } const x = xOf(i), y = yOf(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = THEME.rsi; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillText("RSI(14) " + (this.rsiData[n - 1] != null ? this.rsiData[n - 1].toFixed(1) : "—"), L.plotLeft + 6, p.top + 3);
      ctx.fillStyle = THEME.text; ctx.textBaseline = "middle"; ctx.fillText("70", L.plotRight + 6, yOf(70)); ctx.fillText("30", L.plotRight + 6, yOf(30));
    }

    _drawMACD(ctx, L, p, xOf, n) {
      const m = this.macdData;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { for (const a of [m.line[i], m.signal[i], m.hist[i]]) if (a != null) { if (a < lo) lo = a; if (a > hi) hi = a; } }
      if (!isFinite(lo)) { lo = -1; hi = 1; }
      const span = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -span; hi = span;
      const yOf = (v) => p.bottom - ((v - lo) / (hi - lo)) * (p.bottom - p.top);
      ctx.strokeStyle = THEME.grid; ctx.beginPath(); ctx.moveTo(L.plotLeft, yOf(0)); ctx.lineTo(L.plotRight, yOf(0)); ctx.stroke();
      const bw = Math.max(1, (this._pitch || (L.plotRight - L.plotLeft) / n) * 0.6);
      for (let i = 0; i < n; i++) { const v = m.hist[i]; if (v == null) continue; const x = xOf(i), y0 = yOf(0), y1 = yOf(v); ctx.fillStyle = v >= 0 ? "rgba(38,194,129,0.55)" : "rgba(255,77,77,0.55)"; ctx.fillRect(x - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0)); }
      const line = (arr, col) => { ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); let st = false; for (let i = 0; i < n; i++) { const v = arr[i]; if (v == null) { st = false; continue; } const x = xOf(i), y = yOf(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); } ctx.stroke(); ctx.lineWidth = 1; };
      line(m.line, THEME.macd); line(m.signal, THEME.signal);
      ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillStyle = THEME.macd; ctx.fillText("MACD(12,26,9)", L.plotLeft + 6, p.top + 3);
    }

    _drawStoch(ctx, L, p, xOf, n) {
      const yOf = (v) => p.bottom - (v / 100) * (p.bottom - p.top);
      [20, 80].forEach((lvl) => { ctx.strokeStyle = "rgba(54,163,255,0.18)"; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(L.plotLeft, yOf(lvl)); ctx.lineTo(L.plotRight, yOf(lvl)); ctx.stroke(); ctx.setLineDash([]); });
      const line = (arr, col) => { ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); let st = false; for (let i = 0; i < n; i++) { const v = arr[i]; if (v == null) { st = false; continue; } const x = xOf(i), y = yOf(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); } ctx.stroke(); ctx.lineWidth = 1; };
      line(this.stochData.k, THEME.stochK); line(this.stochData.d, THEME.stochD);
      ctx.fillStyle = THEME.stochK; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillText("STOCH(14,3)", L.plotLeft + 6, p.top + 3);
      ctx.fillStyle = THEME.text; ctx.textBaseline = "middle"; ctx.fillText("80", L.plotRight + 6, yOf(80)); ctx.fillText("20", L.plotRight + 6, yOf(20));
    }

    _drawATR(ctx, L, p, xOf, n) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { const v = this.atrData[i]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      if (!isFinite(lo)) { lo = 0; hi = 1; } if (lo === hi) hi = lo + 1; lo = Math.min(lo, 0);
      const yOf = (v) => p.bottom - ((v - lo) / (hi - lo)) * (p.bottom - p.top);
      ctx.strokeStyle = THEME.atr; ctx.lineWidth = 1.2; ctx.beginPath(); let st = false;
      for (let i = 0; i < n; i++) { const v = this.atrData[i]; if (v == null) { st = false; continue; } const x = xOf(i), y = yOf(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = THEME.atr; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillText("ATR(14) " + (this.atrData[n - 1] != null ? fmtNum(this.atrData[n - 1]) : "—"), L.plotLeft + 6, p.top + 3);
      ctx.fillStyle = THEME.text; ctx.textBaseline = "middle"; ctx.fillText(fmtNum(hi), L.plotRight + 6, p.top + 6);
    }

    _drawOBV(ctx, L, p, xOf, n) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { const v = this.obvData[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === hi) { lo -= 1; hi += 1; }
      const yOf = (v) => p.bottom - ((v - lo) / (hi - lo)) * (p.bottom - p.top);
      ctx.strokeStyle = THEME.obv; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let i = 0; i < n; i++) { const x = xOf(i), y = yOf(this.obvData[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = THEME.obv; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillText("OBV " + fmtVol(this.obvData[n - 1]), L.plotLeft + 6, p.top + 3);
    }

    _drawCrosshair(ctx, L, xOf, yOf, lo, hi) {
      const i = this.hover, c = this.candles[i], x = xOf(i);
      ctx.strokeStyle = THEME.crosshair; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, L.priceTop); ctx.lineTo(x, L.bottomMost); ctx.stroke();
      const cy = Math.max(L.priceTop, Math.min(L.priceBottom, this.mouse.y));
      if (this.mouse.y <= L.priceBottom) { ctx.beginPath(); ctx.moveTo(L.plotLeft, cy); ctx.lineTo(L.plotRight, cy); ctx.stroke(); }
      ctx.setLineDash([]);
      if (this.mouse.y <= L.priceBottom) {
        const pVal = lo + ((L.priceBottom - cy) / (L.priceBottom - L.priceTop)) * (hi - lo);
        ctx.fillStyle = THEME.crosshair; ctx.fillRect(L.plotRight, cy - 8, L.axisW, 16);
        ctx.fillStyle = "#000"; ctx.font = "10px ui-monospace, Menlo, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(fmtNum(pVal), L.plotRight + 6, cy);
      }
      const d = new Date(c.t * 1000);
      const dateStr = this.intraday ? d.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", year: "numeric" });
      const ch = c.c - c.o, chp = c.o ? (ch / c.o) * 100 : 0;
      const lines = [dateStr, "O " + fmtNum(c.o) + "   H " + fmtNum(c.h), "L " + fmtNum(c.l) + "   C " + fmtNum(c.c),
        "Chg " + (ch >= 0 ? "+" : "") + fmtNum(ch) + " (" + chp.toFixed(2) + "%)", "Vol " + fmtVol(c.v)];
      if (this.rsiData && this.rsiData[i] != null) lines.push("RSI " + this.rsiData[i].toFixed(1));
      if (this.macdData && this.macdData.line[i] != null) lines.push("MACD " + fmtNum(this.macdData.line[i]));
      ctx.font = "10px ui-monospace, Menlo, monospace";
      let bw = 0; for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width); bw += 14;
      const bh = lines.length * 14 + 8;
      let bx = x + 12; if (bx + bw > L.plotRight) bx = x - bw - 12; const by = L.priceTop + 6;
      ctx.fillStyle = "rgba(10,10,10,0.92)"; ctx.strokeStyle = THEME.axis; ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      for (let k = 0; k < lines.length; k++) { ctx.fillStyle = k === 0 ? THEME.crosshair : (c.c >= c.o ? THEME.up : THEME.down); if (k >= 4) ctx.fillStyle = THEME.textBright; ctx.fillText(lines[k], bx + 7, by + 6 + k * 14); }
    }
  }

  // ---- CompareChart: normalized (% change) multi-line overlay ----
  class CompareChart {
    constructor(canvas) {
      this.canvas = canvas; this.ctx = canvas.getContext("2d");
      this.series = []; this.intraday = false; this.dpr = window.devicePixelRatio || 1;
      this.mouse = null; this.hover = null;
      canvas.addEventListener("mousemove", (e) => { const r = canvas.getBoundingClientRect(); this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; this.render(); });
      canvas.addEventListener("mouseleave", () => { this.mouse = null; this.render(); });
      this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(canvas.parentElement); this.resize();
    }
    setData(series, opts) {
      // series: [{symbol, points:[{t,c}]}] -> normalize to % from first point
      this.series = (series || []).map((s, idx) => {
        const pts = s.points || []; const base = pts.length ? pts[0].c : 1;
        return { symbol: s.symbol, color: THEME.compare[idx % THEME.compare.length], norm: pts.map((p) => ({ t: p.t, v: base ? (p.c / base - 1) * 100 : 0 })) };
      });
      if (opts && opts.intraday != null) this.intraday = opts.intraday;
      this.render();
    }
    resize() { const par = this.canvas.parentElement, w = par.clientWidth, h = par.clientHeight; if (!w || !h) return; this.dpr = window.devicePixelRatio || 1; this.canvas.width = Math.floor(w * this.dpr); this.canvas.height = Math.floor(h * this.dpr); this.canvas.style.width = w + "px"; this.canvas.style.height = h + "px"; this.W = w; this.H = h; this.render(); }
    render() {
      const ctx = this.ctx; if (!this.W) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.W, this.H);
      ctx.fillStyle = THEME.bg; ctx.fillRect(0, 0, this.W, this.H);
      const padTop = 10, padBottom = 22, axisW = 58, padLeft = 6;
      const left = padLeft, right = this.W - axisW, top = padTop, bottom = this.H - padBottom;
      if (!this.series.length) { ctx.fillStyle = THEME.text; ctx.font = "12px ui-monospace, Menlo, monospace"; ctx.textAlign = "center"; ctx.fillText("ADD SYMBOLS TO COMPARE", this.W / 2, this.H / 2); return; }
      let lo = Infinity, hi = -Infinity, maxLen = 0, longest = null;
      for (const s of this.series) { for (const p of s.norm) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; } if (s.norm.length > maxLen) { maxLen = s.norm.length; longest = s; } }
      if (!isFinite(lo)) { lo = -1; hi = 1; } if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      const yOf = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
      ctx.font = "10px ui-monospace, Menlo, monospace"; ctx.textBaseline = "middle";
      for (let i = 0; i <= 6; i++) { const v = lo + (i / 6) * (hi - lo), y = yOf(v); ctx.strokeStyle = (Math.abs(v) < 1e-9 || (lo < 0 && hi > 0 && i === Math.round((-lo) / (hi - lo) * 6))) ? THEME.axis : THEME.grid; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillStyle = THEME.text; ctx.textAlign = "left"; ctx.fillText((v >= 0 ? "+" : "") + v.toFixed(1) + "%", right + 6, y); }
      // zero line emphasis
      if (lo < 0 && hi > 0) { const y0 = yOf(0); ctx.strokeStyle = "#3a3a3a"; ctx.beginPath(); ctx.moveTo(left, y0); ctx.lineTo(right, y0); ctx.stroke(); }
      // time labels from longest
      if (longest) { ctx.fillStyle = THEME.text; ctx.textAlign = "center"; ctx.textBaseline = "top"; const lc = Math.min(7, longest.norm.length); for (let k = 0; k < lc; k++) { const i = Math.round((k / (lc - 1 || 1)) * (longest.norm.length - 1)); const d = new Date(longest.norm[i].t * 1000); const lbl = this.intraday ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "2-digit" }); const x = left + (i / Math.max(1, longest.norm.length - 1)) * (right - left); ctx.fillText(lbl, Math.max(left + 18, Math.min(right - 18, x)), bottom + 5); } }
      // lines
      for (const s of this.series) { const n = s.norm.length; ctx.strokeStyle = s.color; ctx.lineWidth = 1.4; ctx.beginPath(); for (let i = 0; i < n; i++) { const x = left + (i / Math.max(1, n - 1)) * (right - left), y = yOf(s.norm[i].v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); }
      ctx.lineWidth = 1;
      // legend with last value
      ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "11px ui-monospace, Menlo, monospace";
      let lx = left + 6, ly = top + 4;
      for (const s of this.series) { const last = s.norm.length ? s.norm[s.norm.length - 1].v : 0; const txt = s.symbol + " " + (last >= 0 ? "+" : "") + last.toFixed(2) + "%"; ctx.fillStyle = s.color; ctx.fillText(txt, lx, ly); lx += ctx.measureText(txt).width + 16; if (lx > right - 80) { lx = left + 6; ly += 15; } }
      // crosshair
      if (this.mouse && this.mouse.x >= left && this.mouse.x <= right && longest) {
        const frac = (this.mouse.x - left) / (right - left);
        ctx.strokeStyle = THEME.crosshair; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(this.mouse.x, top); ctx.lineTo(this.mouse.x, bottom); ctx.stroke(); ctx.setLineDash([]);
        const idxL = Math.round(frac * (longest.norm.length - 1));
        const d = new Date(longest.norm[idxL].t * 1000);
        const lines = [this.intraday ? d.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", year: "numeric" })];
        const cols = [THEME.crosshair];
        for (const s of this.series) { const i = Math.round(frac * (s.norm.length - 1)); const v = s.norm[i] ? s.norm[i].v : 0; lines.push(s.symbol + "  " + (v >= 0 ? "+" : "") + v.toFixed(2) + "%"); cols.push(s.color); }
        ctx.font = "10px ui-monospace, Menlo, monospace"; let bw = 0; for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width); bw += 14; const bh = lines.length * 14 + 8;
        let bx = this.mouse.x + 12; if (bx + bw > right) bx = this.mouse.x - bw - 12; const by = top + 4;
        ctx.fillStyle = "rgba(10,10,10,0.92)"; ctx.strokeStyle = THEME.axis; ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
        ctx.textAlign = "left"; ctx.textBaseline = "top"; for (let k = 0; k < lines.length; k++) { ctx.fillStyle = cols[k]; ctx.fillText(lines[k], bx + 7, by + 6 + k * 14); }
      }
    }
  }

  window.TerminalChart = TerminalChart;
  window.CompareChart = CompareChart;
  window.TA = { sma, ema, rsi, macd, bollinger, stochastic, atr, obv, cci, williamsR, roc, momentum, stochRSI, adx, ultimateOsc, awesome };
  window.fmtNum = fmtNum;
  window.fmtVol = fmtVol;
})();
