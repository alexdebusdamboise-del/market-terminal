/* Shared helpers — exposed on window.IFX */
(function () {
  "use strict";
  const IFX = (window.IFX = window.IFX || {});

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  IFX.esc = (s) => (s === null || s === undefined ? "" : String(s).replace(/[&<>"']/g, (c) => ESC[c]));

  // Only http(s) links from data files may become hrefs (no javascript: URLs)
  IFX.safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "#");

  IFX.$ = (sel, root) => (root || document).querySelector(sel);
  IFX.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // Accent/case-insensitive normalisation for searches
  IFX.norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  IFX.fmtInt = (n) => (n === null || n === undefined || isNaN(n) ? "—" : Math.round(n).toLocaleString("fr-FR"));
  IFX.fmtEur = (n) => {
    if (n === null || n === undefined || isNaN(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Md€";
    if (a >= 1e6) return (n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " M€";
    if (a >= 1e3) return Math.round(n / 1e3).toLocaleString("fr-FR") + " k€";
    return Math.round(n).toLocaleString("fr-FR") + " €";
  };
  IFX.fmtDate = (iso) => {
    if (!iso) return "—";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return d && m && y ? `${d}/${m}/${y}` : String(iso);
  };
  IFX.today = () => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // localStorage can throw (private mode, blocked storage): never let it break the app
  IFX.store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        IFX.toast("Stockage local indisponible : exporte tes données pour ne pas les perdre.", true);
        return false;
      }
    },
  };

  let toastTimer = null;
  IFX.toast = (msg, isErr) => {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), isErr ? 6000 : 3000);
  };

  IFX.api = async (path, params, signal) => {
    const qs = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return;
      qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    });
    const res = await fetch(`${path}?${qs.toString()}`, { signal });
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || `Erreur HTTP ${res.status}`);
      err.status = res.status;
      err.retryAfter = body && body.retry_after;
      throw err;
    }
    return body;
  };

  // CSV for French Excel: ';' separator + UTF-8 BOM
  IFX.csv = (rows) =>
    "﻿" +
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = v === null || v === undefined ? "" : String(v);
            return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(";")
      )
      .join("\r\n");

  IFX.download = (filename, content, type) => {
    const blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  };

  IFX.readFile = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });

  // Generic autocomplete: input + suggestion box; source(q) -> [{html, value}]
  IFX.autocomplete = (input, box, source, onPick) => {
    let items = [];
    let idx = -1;
    const close = () => {
      box.classList.add("hidden");
      idx = -1;
    };
    const render = () => {
      if (!items.length) return close();
      box.innerHTML = items.map((it, i) => `<div data-i="${i}" class="${i === idx ? "on" : ""}">${it.html}</div>`).join("");
      box.classList.remove("hidden");
    };
    let seq = 0;
    input.addEventListener("input", async () => {
      const q = input.value.trim();
      const my = ++seq;
      const res = q ? await source(q) : [];
      if (my !== seq) return; // a newer keystroke won
      items = res || [];
      idx = items.length ? 0 : -1;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (box.classList.contains("hidden")) return;
      if (e.key === "ArrowDown") {
        idx = Math.min(items.length - 1, idx + 1);
        render();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        idx = Math.max(0, idx - 1);
        render();
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (idx >= 0 && items[idx]) {
          e.preventDefault();
          onPick(items[idx].value);
          input.value = "";
          close();
        }
      } else if (e.key === "Escape") close();
    });
    box.addEventListener("mousedown", (e) => {
      const d = e.target.closest("[data-i]");
      if (!d) return;
      e.preventDefault();
      onPick(items[+d.dataset.i].value);
      input.value = "";
      close();
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  };

  // Tiny drawer used by prospects and products
  IFX.openDrawer = (title, html, onMount) => {
    IFX.$("#drawer-title").textContent = title;
    IFX.$("#drawer-body").innerHTML = html;
    IFX.$("#drawer").classList.remove("hidden");
    if (onMount) onMount(IFX.$("#drawer-body"));
  };
  IFX.closeDrawer = () => IFX.$("#drawer").classList.add("hidden");
})();
