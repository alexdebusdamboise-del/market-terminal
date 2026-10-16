/* Shared helpers — exposed on window.IFX */
(function () {
  "use strict";
  const IFX = (window.IFX = window.IFX || {});
  // Set by the claude.ai build: no Python server behind the page
  IFX.STATIC = !!window.IFX_STATIC;
  // Set by the offline single-file build (opened by double-click): can print, no server either
  IFX.OFFLINE = !!window.IFX_OFFLINE;

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  IFX.esc = (s) => (s === null || s === undefined ? "" : String(s).replace(/[&<>"']/g, (c) => ESC[c]));

  // The other field tools (private claude.ai pages of the same account). The selector
  // opens locally in the installed version, where it shares this catalogue.
  IFX.TOOLS = [
    ["Relevé de visite", "https://claude.ai/artifact/E9SD5iW2k8UiQVpfaErkji"],
    ["Relevé technique", "https://claude.ai/artifact/2zu93hewvkyqpHjZYwaNpD"],
    ["Calculateur ROI lubrification", "https://claude.ai/artifact/NpWuPsDVKqCXGw4fprEW1T"],
    ["Calculateur ROI express", "https://claude.ai/artifact/MPXTksVpZrpnCqE4VxQ2Df"],
    ["Sélecteur (version client)", IFX.STATIC ? "https://claude.ai/artifact/XVxdNfaBbYwUvJvf7orC1S" : "/selecteur/"],
  ];

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
    // company and place searches go straight to the public APIs (js/sources.js)
    if (IFX.sources && IFX.sources[path]) return IFX.sources[path](params || {}, signal);
    const qs = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return;
      qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    });
    let res;
    try {
      res = await fetch(`${path}?${qs.toString()}`, { signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Connexion impossible : vérifie ta connexion internet (ou que le serveur est lancé), puis relance.");
    }
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
            let s = v === null || v === undefined ? "" : String(v);
            // Excel would turn "01000" into 1000 and a SIRET into 1,23E+13
            if (/^\d+$/.test(s) && (s.length >= 9 || (s.length > 1 && s[0] === "0"))) return `="${s}"`;
            // never let a cell start like a formula (CSV injection)
            if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
            return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(";")
      )
      .join("\r\n");

  // In a claude.ai page, files are offered through the platform's download
  // capability (direct downloads are blocked there); elsewhere, a plain link.
  let downloadsNs;
  const downloadsCap = () => {
    if (downloadsNs === undefined) {
      downloadsNs = window.claude && typeof window.claude.use === "function" ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);
    }
    return downloadsNs;
  };
  IFX.download = async (filename, content, type) => {
    const cap = await downloadsCap();
    if (cap) {
      try {
        await cap.save({ filename, data: content });
      } catch (e) {
        if (e && e.code !== "declined") IFX.toast("Téléchargement impossible ici (" + ((e && e.code) || "erreur") + ")", true);
      }
      return;
    }
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
    let seq = 0;
    const close = () => {
      seq++; // drop any response still in flight
      box.classList.add("hidden");
      idx = -1;
    };
    const render = () => {
      if (!items.length) return close();
      box.innerHTML = items.map((it, i) => `<div data-i="${i}" class="${i === idx ? "on" : ""}">${it.html}</div>`).join("");
      box.classList.remove("hidden");
    };
    input.addEventListener("input", async () => {
      const q = input.value.trim();
      const my = ++seq;
      const res = q ? await source(q) : [];
      if (my !== seq || input.value.trim() !== q) return; // a newer keystroke or a pick won
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

  // In-page confirmation (native confirm() is blocked in claude.ai pages)
  IFX.confirm = (text, okLabel, cancelLabel) =>
    new Promise((resolve) => {
      const box = IFX.$("#confirm");
      IFX.$("#confirm-text").textContent = text;
      const ok = IFX.$("#confirm-ok");
      const cancel = IFX.$("#confirm-cancel");
      ok.textContent = okLabel || "Confirmer";
      cancel.textContent = cancelLabel || "Annuler";
      const done = (v) => {
        box.classList.add("hidden");
        ok.onclick = cancel.onclick = box.onkeydown = null;
        resolve(v);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      box.onkeydown = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      };
      box.classList.remove("hidden");
      ok.focus();
    });

  // Tiny drawer used by prospects and products
  IFX.openDrawer = (title, html, onMount) => {
    IFX.$("#drawer-title").textContent = title;
    IFX.$("#drawer-body").innerHTML = html;
    IFX.$("#drawer-body").onclick = null;
    IFX.$("#drawer").classList.remove("hidden");
    if (onMount) onMount(IFX.$("#drawer-body"));
  };
  IFX.closeDrawer = () => IFX.$("#drawer").classList.add("hidden");
})();
