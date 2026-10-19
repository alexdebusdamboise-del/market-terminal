/* SEL + CAT — product selector wizard, catalogue and product sheets. */
(function () {
  "use strict";
  const IFX = window.IFX;
  const { esc, $, $$, norm } = IFX;
  const C = window.SelectorCore;
  const S = (IFX.sel = {});

  const FAMILIES = {
    huile: "Huile",
    graisse: "Graisse",
    aerosol: "Aérosol",
    nettoyant: "Nettoyant",
    degraissant: "Dégraissant",
    agent_demoulage: "Agent de démoulage",
    lubrificateur_automatique: "Lubrificateur automatique",
    accessoire: "Accessoire",
    autre: "Autre",
  };
  const ENV_CHOICES = [
    ["resistant_eau", "Eau / humidité"],
    ["lavage_frequent", "Lavages fréquents"],
    ["environnement_poussiereux", "Poussière / saleté"],
    ["charges_elevees_chocs", "Charges élevées / chocs"],
    ["vitesse_elevee", "Vitesse élevée"],
    ["anti_corrosion", "Corrosion / extérieur"],
    ["compatible_plastiques_joints", "Plastiques / joints"],
    ["biodegradable", "Biodégradable exigé"],
    ["sans_pfas", "Sans PFAS exigé"],
  ];
  const TEMP_PRESETS = [
    ["Surgélation", -40, -18],
    ["Froid", -5, 10],
    ["Ambiant", 5, 40],
    ["Chaud", 20, 120],
    ["Four / étuve", 50, 250],
    ["Très haute", "", 300],
  ];
  const LS_CRIT = "ifx.sel.criteria";

  let PRODUCTS = [];
  let META = {};
  let EQUIV = [];
  let segHint = null;

  // fromEquiv: the answers the last competitor reference changed ({was, set}), undone by the next one
  const blank = () => ({ mode: "besoin", food: "", application: "", tmin: "", tmax: "", env: [], formats: [], replaceType: "", iso_vg: "", nlgi: "", query: "", client: "", fromEquiv: {} });
  let crit = blank();
  // answers restored from the last visit: said so until the first change
  let restored = false;

  const famLabel = (f) => FAMILIES[f] || f || "—";
  const appLabel = (a) => C.APPLICATIONS[a] || a;
  const known = (x) => x !== null && x !== undefined && x !== "";
  // y conforme · n non conforme · u donnée manquante · a à vérifier chez le client · r voisin (organe ou propriété)
  const MARK = { y: "✔", n: "✖", u: "?", a: "!", r: "≈" };
  // equipment (automatic lubricators, accessories) is listed in CAT, not ranked by the selector
  const EQUIP = new Set(["lubrificateur_automatique", "accessoire"]);
  const tempRange = (p) =>
    p.temp_na
      ? "sans objet"
      : !known(p.temp_min_c) && !known(p.temp_max_c)
      ? "n.c."
      : `${known(p.temp_min_c) ? p.temp_min_c : "?"} → ${known(p.temp_max_c) ? p.temp_max_c : "?"} °C`;
  const tempTxt = (p) => tempRange(p) + (known(p.temp_min_gearbox_c) && !p.temp_na ? ` (réducteur : ${p.temp_min_gearbox_c} °C mini)` : "");
  // "temp_max_c (source unique)" -> "Température maxi (source unique)"
  const FIELD_LABEL = { nsf_reg_no: "N° d'enregistrement NSF", nsf: "Homologation NSF", temp_min_c: "Température mini", temp_max_c: "Température maxi",
    viscosity_iso_vg: "Viscosité", nlgi: "Grade NLGI", base: "Huile de base", formats: "Conditionnements", applications: "Applications", properties: "Propriétés" };
  const doubtTxt = (f) => String(f).replace(/^(nsf_reg_no|nsf|temp_min_c|temp_max_c|viscosity_iso_vg|nlgi|base|formats|applications|properties)\b/, (k) => FIELD_LABEL[k]);
  // ISO VG grade when the source gives one, otherwise the measured viscosity at 40 °C
  const viscTxt = (p) => (p.viscosity_iso_vg ? `ISO VG ${p.viscosity_iso_vg}` : known(p.viscosity_cst40) ? `${p.viscosity_cst40} cSt à 40 °C` : "");
  const isVerified = C.isVerified;
  // temperature checked on its own: a sheet that only lacks its packaging keeps a verified range
  const TEMP_MARK = {
    ok: '<span class="vmark ok" title="Plage appuyée par une citation de sa source (Détails ▸ Preuves)">✔ vérifiée</span>',
    doubt: '<span class="vmark warn" title="Plage relevée, source à confirmer">à confirmer</span>',
  };
  const tempMark = (p) => TEMP_MARK[C.tempStatus(p)] || "";
  // badge of the whole sheet, saying what is missing instead of a vague "à valider"
  const sheetBadge = (p, short) => {
    if (isVerified(p)) return '<span class="badge ok" title="Chaque donnée de la fiche (NSF, températures, conditionnements, applications…) est appuyée par une source citée">fiche vérifiée</span>';
    const g = C.gapsText(p) || "à confirmer";
    return `<span class="badge warn" title="${esc(g)}">${esc(short && g.length > 40 ? "à compléter" : g)}</span>`;
  };

  // "-20", "−30" (U+2212), "180°C", "12,5" -> number; "" -> ""; garbage -> NaN
  function parseTemp(raw) {
    const s = String(raw === undefined || raw === null ? "" : raw)
      .replace(/[\u2212\u2013\u2014]/g, "-")
      .replace(/°\s*c?|\s/gi, "")
      .replace(",", ".");
    if (!s || s === "-") return ""; // empty or still being typed
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }

  function effective() {
    const c = {
      food: crit.food || null,
      application: crit.application || null,
      tmin: parseTemp(crit.tmin),
      tmax: parseTemp(crit.tmax),
      env: crit.env.slice(),
      formats: crit.formats.slice(),
      query: crit.query,
    };
    if (crit.mode === "remplacement") {
      c.iso_vg = crit.iso_vg;
      c.nlgi = crit.nlgi;
      const t = C.REPLACE_TYPES[crit.replaceType];
      if (t) {
        if (t.families) c.families = t.families;
        (t.env || []).forEach((e) => c.env.includes(e) || c.env.push(e));
      }
    }
    c.badTemp = Number.isNaN(c.tmin) || Number.isNaN(c.tmax);
    return c;
  }

  const hasCriteria = (c) => !!(c.food || c.application || c.tmin !== "" || c.tmax !== "" || c.env.length || c.formats.length || c.query || c.families || c.iso_vg || c.nlgi);

  // ------------------------------------------------------------------ form
  const tiles = (name, entries, current, multi) =>
    `<div class="tiles" data-name="${name}" data-multi="${multi ? 1 : 0}">${entries
      .map(([k, l]) => `<button type="button" class="tile ${multi ? (current.includes(k) ? "on" : "") : current === k ? "on" : ""}" data-v="${esc(k)}">${esc(l)}</button>`)
      .join("")}</div>`;

  function renderForm() {
    // applications some product lists, plus the current choice (e.g. set from a sector) so it can be seen and unselected
    const appEntries = Object.entries(C.APPLICATIONS).filter(
      ([k]) => k === crit.application || (k !== "autre" && PRODUCTS.some((p) => (p.applications || []).includes(k)))
    );
    const html = `
      <div class="q">
        <div class="seg-toggle" id="sel-mode">
          <button type="button" data-mode="besoin" class="${crit.mode === "besoin" ? "on" : ""}">Nouveau besoin</button>
          <button type="button" data-mode="remplacement" class="${crit.mode === "remplacement" ? "on" : ""}">Remplacer un produit</button>
        </div>
      </div>
      ${segHint ? `<div class="q"><div class="qt">SECTEUR : ${esc(segHint.label.toUpperCase())}</div>
        ${(segHint.typical_applications || []).length ? `<div class="qh">${esc(segHint.typical_applications.slice(0, 6).join(" · "))}</div>` : ""}
        ${(segHint.applications || []).filter((a) => C.APPLICATIONS[a]).length ? `<div class="presets">${segHint.applications
          .filter((a) => C.APPLICATIONS[a])
          .map((a) => `<button type="button" data-segapp="${esc(a)}">${esc(appLabel(a))}</button>`)
          .join("")}</div>` : ""}
        <button type="button" class="linkbtn" id="sel-clear-seg">retirer le contexte secteur</button></div>` : ""}
      ${crit.mode === "remplacement" ? `
      <div class="q"><div class="qt">PRODUIT ACTUEL DU CLIENT</div>
        <div class="qh">Type de produit utilisé aujourd'hui (toutes marques)</div>
        ${tiles("replaceType", Object.entries(C.REPLACE_TYPES).map(([k, v]) => [k, v.label]), crit.replaceType, false)}
        <div class="temp-row" style="margin-top:6px">
          <div><label for="sel-vg">Viscosité ISO VG (si connue)</label><input id="sel-vg" type="text" inputmode="numeric" placeholder="ex. 220" value="${esc(crit.iso_vg)}"/></div>
          <div><label for="sel-nlgi">Grade NLGI (graisse)</label><input id="sel-nlgi" type="text" placeholder="ex. 2" value="${esc(crit.nlgi)}"/></div>
        </div>
        ${EQUIV.length ? `<div style="margin-top:6px"><label class="muted small" for="sel-equiv">Référence concurrente (marque ou produit)</label>
          <input id="sel-equiv" type="text" placeholder="Marque ou référence…"/><div id="sel-equiv-res"></div></div>` : ""}
      </div>` : ""}
      <div class="q"><div class="qt">1 · CONTACT ALIMENTAIRE POSSIBLE ?</div>
        <div class="qh">Agroalimentaire, boissons, pharma, emballage alimentaire : contact fortuit = NSF H1 obligatoire</div>
        ${tiles("food", [["oui", "Oui → NSF H1"], ["non", "Non"], ["nsp", "Je ne sais pas"]], crit.food, false)}</div>
      <div class="q"><div class="qt">2 · APPLICATION</div>${tiles("application", appEntries, crit.application, false)}</div>
      <div class="q"><div class="qt">3 · TEMPÉRATURE DE FONCTIONNEMENT</div>
        <div class="temp-row">
          <div><label for="sel-tmin">Mini (°C)</label><input id="sel-tmin" type="text" autocomplete="off" value="${esc(crit.tmin)}" placeholder="ex. -20"/></div>
          <div><label for="sel-tmax">Maxi (°C)</label><input id="sel-tmax" type="text" autocomplete="off" value="${esc(crit.tmax)}" placeholder="ex. 180"/></div>
        </div>
        <div class="presets">${TEMP_PRESETS.map(([l, a, b], i) => `<button type="button" data-preset="${i}">${esc(l)} <span class="muted">${a === "" ? "" : a + "/"}${b}</span></button>`).join("")}<button type="button" data-preset="-1">effacer</button></div></div>
      <div class="q"><div class="qt">4 · ENVIRONNEMENT</div>${tiles("env", ENV_CHOICES, crit.env, true)}</div>
      <div class="q"><div class="qt">5 · CONDITIONNEMENT SOUHAITÉ</div>${tiles("formats", Object.entries(C.FORMATS), crit.formats, true)}</div>
      <div class="q"><div class="qt">RECHERCHE LIBRE</div><input id="sel-query" type="text" placeholder="nom, mot-clé…" value="${esc(crit.query)}"/></div>
      <div class="q"><div class="qt">CLIENT / SITE (pour l'impression)</div><input id="sel-client" type="text" placeholder="optionnel" value="${esc(crit.client)}"/></div>`;
    $("#sel-form").innerHTML = html;
  }

  function bindForm() {
    const form = $("#sel-form");
    form.addEventListener("click", (e) => {
      const apply = e.target.closest("[data-equiv-apply]");
      if (apply) return applyEquiv(EQUIV[+apply.dataset.equivApply]);
      const detail = e.target.closest("[data-detail]");
      if (detail) {
        e.preventDefault();
        return openProduct(detail.dataset.detail);
      }
      const mode = e.target.closest("#sel-mode button");
      if (mode) {
        crit.mode = mode.dataset.mode;
        return changed(true);
      }
      const segApp = e.target.closest("[data-segapp]");
      if (segApp) {
        crit.application = segApp.dataset.segapp;
        return changed(true);
      }
      if (e.target.id === "sel-clear-seg") {
        segHint = null;
        return changed(true);
      }
      const preset = e.target.closest("[data-preset]");
      if (preset) {
        const i = +preset.dataset.preset;
        crit.tmin = i < 0 ? "" : String(TEMP_PRESETS[i][1]);
        crit.tmax = i < 0 ? "" : String(TEMP_PRESETS[i][2]);
        $("#sel-tmin").value = crit.tmin;
        $("#sel-tmax").value = crit.tmax;
        return changed(false);
      }
      const tile = e.target.closest(".tile");
      if (!tile) return;
      const box = tile.parentElement;
      const name = box.dataset.name;
      const v = tile.dataset.v;
      if (name === "replaceType") {
        pickReplaceType(crit.replaceType === v ? "" : v);
        return changed(true);
      }
      if (box.dataset.multi === "1") {
        crit[name] = crit[name].includes(v) ? crit[name].filter((x) => x !== v) : crit[name].concat(v);
        tile.classList.toggle("on");
      } else {
        crit[name] = crit[name] === v ? "" : v;
        $$(".tile", box).forEach((t) => t.classList.toggle("on", t.dataset.v === crit[name]));
      }
      changed(false);
    });
    form.addEventListener("input", (e) => {
      const map = { "sel-tmin": "tmin", "sel-tmax": "tmax", "sel-query": "query", "sel-client": "client", "sel-vg": "iso_vg", "sel-nlgi": "nlgi" };
      const k = map[e.target.id];
      if (k) {
        crit[k] = e.target.value.trim();
        changed(false);
      }
      if (e.target.id === "sel-equiv") renderEquiv(e.target.value);
    });
    $("#sel-reset").addEventListener("click", () => {
      crit = Object.assign(blank(), { mode: crit.mode });
      segHint = null;
      changed(true);
    });
    $("#sel-results").addEventListener("click", (e) => {
      const d = e.target.closest("[data-detail]");
      if (d) openProduct(d.dataset.detail);
    });
    $("#sel-needbar").addEventListener("click", (e) => {
      if (e.target.closest("[data-reset]")) {
        crit = Object.assign(blank(), { mode: crit.mode });
        segHint = null;
        return changed(true);
      }
      const d = e.target.closest("[data-drop]");
      if (d) drop(d.dataset.drop);
    });
    $("#sel-print").addEventListener("click", printReco);
    $("#sel-jump").addEventListener("click", () => $("#sel-results-panel").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // the product type in place decides the organ (a leftover organ would override it)
  function pickReplaceType(v) {
    const before = C.REPLACE_TYPES[crit.replaceType];
    crit.replaceType = v;
    const t = C.REPLACE_TYPES[v];
    if (t && t.application) crit.application = t.application;
    else if (before && before.application === crit.application) crit.application = "";
  }
  // × on an active criterion
  function drop(key) {
    const [name, v] = key.split(":");
    if (v !== undefined) crit[name] = crit[name].filter((x) => x !== v);
    else if (name === "temp") crit.tmin = crit.tmax = "";
    else if (name === "replaceType") pickReplaceType("");
    else crit[name] = "";
    changed(true);
  }

  function changed(rerenderForm) {
    restored = false;
    IFX.store.set(LS_CRIT, crit);
    if (rerenderForm) renderForm();
    renderResults();
  }

  function renderEquiv(q) {
    const box = $("#sel-equiv-res");
    if (!box) return;
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return (box.innerHTML = "");
    const hits = EQUIV.map((x, i) => [x, i]).filter(([x]) => words.every((w) => norm(`${x.marque} ${x.reference} ${x.type || ""}`).includes(w))).slice(0, 8);
    const temps = (x) => (known(x.temp_min_c) || known(x.temp_max_c) ? `${known(x.temp_min_c) ? x.temp_min_c : "?"} → ${known(x.temp_max_c) ? x.temp_max_c : "?"} °C` : "");
    const specs = (x) => [x.type, x.nsf ? `NSF ${x.nsf}` : "", temps(x), x.iso_vg ? `ISO VG ${x.iso_vg}` : "", x.nlgi ? `NLGI ${x.nlgi}` : ""].filter(Boolean).join(" · ");
    box.innerHTML = hits.length
      ? `<ul class="tight">${hits
          .map(([x, i]) => {
            const p = x.interflon ? findProduct(x.interflon) : null;
            const direct = x.interflon ? ` → ${p ? `<a href="#" data-detail="${esc(p.id)}">${esc(x.interflon)}</a>` : `${esc(x.interflon)} <span class="badge bad">introuvable dans le catalogue</span>`}` : "";
            const canApply = x.replace_type || x.application;
            const xname = norm(x.reference).startsWith(norm(x.marque)) ? x.reference : `${x.marque} ${x.reference}`;
            return `<li><b>${esc(xname)}</b>${direct}
              ${x.valide_par ? `<span class="badge ok">validé ${esc(x.valide_par)}</span>` : `<span class="badge warn">à valider</span>`}
              <div class="muted small">${esc(specs(x))}${x.note ? ` · ${esc(x.note)}` : ""}${x.source ? ` · <a href="${esc(IFX.safeUrl(x.source))}" target="_blank" rel="noopener">fiche</a>` : x.origine ? ` · ${esc(x.origine)}` : ""}</div>
              ${canApply ? `<button type="button" class="btn small" data-equiv-apply="${i}">Appliquer ses critères</button>` : `<div class="muted small">Pas d'équivalent Interflon.</div>`}</li>`;
          })
          .join("")}</ul>`
      : `<div class="muted small">Référence absente de la table : utilise les critères ci-dessous.</div>`;
  }

  // Competitor -> criteria (type, food contact, its published range, viscosity / grade)
  // Competitor -> criteria it really provides; the rep's own answers are kept, and what a
  // previous reference filled in is put back first
  const FROM_EQUIV = ["replaceType", "application", "food", "tmin", "tmax", "iso_vg", "nlgi"];
  function applyEquiv(x) {
    Object.entries(crit.fromEquiv || {}).forEach(([k, v]) => {
      if (crit[k] === v.set) crit[k] = v.was;
    });
    const was = {};
    FROM_EQUIV.forEach((k) => {
      was[k] = crit[k];
    });
    // the reference is the product in place: its type (or none) replaces the one picked before
    pickReplaceType(C.REPLACE_TYPES[x.replace_type] ? x.replace_type : "");
    if (x.application && C.APPLICATIONS[x.application]) crit.application = x.application;
    // a food-grade product in place means food contact; any other never lowers the rep's answer
    if (x.nsf === "H1") crit.food = "oui";
    // a data-sheet range is a product limit, not the machine's temperature: only
    // heat-purpose products (oven chain oils…) pass their upper limit on, when none is given
    if (x.besoin_temp && known(x.temp_max_c) && crit.tmin === "" && crit.tmax === "") crit.tmax = String(x.temp_max_c);
    if (x.iso_vg) crit.iso_vg = String(x.iso_vg);
    if (x.nlgi) crit.nlgi = String(x.nlgi);
    crit.fromEquiv = {};
    FROM_EQUIV.forEach((k) => {
      if (crit[k] !== was[k]) crit.fromEquiv[k] = { was: was[k], set: crit[k] };
    });
    changed(true);
    const name = norm(x.reference).startsWith(norm(x.marque)) ? x.reference : `${x.marque} ${x.reference}`;
    const fromTmax = crit.fromEquiv.tmax;
    IFX.toast(
      `Critères de ${name} appliqués${
        fromTmax ? ` : sa limite de ${fromTmax.set} °C est reprise comme besoin, remplace-la par la température réelle de la machine` : crit.tmin === "" && crit.tmax === "" && (known(x.temp_min_c) || known(x.temp_max_c)) ? " : indique la température réelle de la machine pour affiner" : ""
      }.`
    );
  }

  // ------------------------------------------------------------------ results
  function tempBar(p, c) {
    const lo = -60;
    const hi = 400;
    const pos = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
    if (!known(p.temp_min_c) && !known(p.temp_max_c)) return "";
    // an unknown limit is drawn as a hatched stub, never as coverage
    const a = known(p.temp_min_c) ? p.temp_min_c : null;
    const b = known(p.temp_max_c) ? p.temp_max_c : null;
    const solidA = a === null ? b : a;
    const solidB = b === null ? a : b;
    const unk =
      a === null
        ? `<span class="unk" style="left:${Math.max(0, pos(b) - 8)}%;width:${pos(b) - Math.max(0, pos(b) - 8)}%"></span>`
        : b === null
        ? `<span class="unk" style="left:${pos(a)}%;width:${Math.min(100, pos(a) + 8) - pos(a)}%"></span>`
        : "";
    const tmin = typeof c.tmin === "number" && !isNaN(c.tmin) ? c.tmin : null;
    const tmax = typeof c.tmax === "number" && !isNaN(c.tmax) ? c.tmax : null;
    const need =
      tmin !== null || tmax !== null
        ? `<span class="need" style="left:${pos(tmin === null ? tmax : tmin)}%;width:${Math.max(0.6, pos(tmax === null ? tmin : tmax) - pos(tmin === null ? tmax : tmin))}%"></span>`
        : "";
    return `<div class="tbar" title="Plage produit (orange, hachuré = limite inconnue) vs besoin (bleu), échelle -60 → 400 °C"><span class="p" style="left:${pos(solidA)}%;width:${Math.max(0.6, pos(solidB) - pos(solidA))}%"></span>${unk}${need}</div>`;
  }

  // rank: {n, tie} for the first choices (CHOIX n, shared when only the name differs), null otherwise
  function card(r, c, rank) {
    const p = r.product;
    return `<div class="card ${rank && rank.n === 1 ? "top" : ""} ${r.eligible ? "" : "out"}">
      ${rank ? `<div class="rank">CHOIX ${rank.n}${rank.tie ? ' <span class="tie">· EX ÆQUO</span>' : ""}</div>` : ""}
      ${r.eligible && r.unchecked.length ? `<div class="unchecked">Non vérifié : ${esc(r.unchecked.join(", "))} (donnée manquante sur la fiche)</div>` : ""}
      <div class="card-h"><div><span class="pname">${esc(p.name)}</span>
        ${p.nsf ? `<span class="badge ${C.nsfList(p).includes("H1") ? "ok" : "blue"}">NSF ${esc(p.nsf)}</span>` : ""}
        <span class="badge">${esc(famLabel(p.family))}</span>
        ${sheetBadge(p)}
      </div><button type="button" class="btn small" data-detail="${esc(p.id)}">Détails</button></div>
      <div class="desc">${esc(p.description_fr || "")}</div>
      <div class="small muted">Température : ${esc(tempTxt(p))} ${tempMark(p)}${viscTxt(p) ? ` · ${esc(viscTxt(p))}` : ""}${p.nlgi ? ` · NLGI ${esc(p.nlgi)}` : ""}${(p.formats || []).length ? ` · ${esc(p.formats.join(", "))}` : ""}</div>
      ${tempBar(p, c)}
      ${r.reasons.length ? `<ul class="reasons">${r.reasons.map((x) => `<li class="${x.s}">${MARK[x.s] || "?"} ${esc(x.t)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  // CHOIX 1..3 among the products made for the requested organ; equal products share the number
  function choiceRanks(list) {
    const n = [];
    list.forEach((r, i) => {
      n[i] = i > 0 && !C.compare(list[i - 1], r) ? n[i - 1] : i + 1;
    });
    return list.map((r, i) => (n[i] <= 3 ? { n: n[i], tie: n[i - 1] === n[i] || n[i + 1] === n[i] } : null));
  }
  // made for the requested organ ("main"), for a neighbouring organ, additives for the oil
  // in place, data missing, excluded
  function groups(list) {
    return {
      ok: list.filter((r) => r.verified && r.group === "main"),
      near: list.filter((r) => r.verified && r.group === "related"),
      adds: list.filter((r) => r.verified && r.group === "additive"),
      pending: list.filter((r) => r.eligible && !r.verified),
      out: list.filter((r) => !r.eligible),
    };
  }

  // what could still tell equal products apart (never a criterion already given)
  function tieHint(c, ok) {
    const tied = ok.filter((r) => !C.compare(ok[0], r));
    // only criteria not given yet that some of them meet and others not
    const sp = C.splitters(tied.map((r) => r.product), c, ENV_CHOICES.map(([k]) => k));
    const hints = [];
    if (sp.temp) hints.push("la température");
    if (sp.env.length) hints.push(`l'environnement (${sp.env.map((e) => (ENV_CHOICES.find(([k]) => k === e) || [e, e])[1].toLowerCase()).join(" ; ")})`);
    if (sp.formats.length) hints.push(`le conditionnement (${sp.formats.map((f) => C.FORMATS[f].toLowerCase()).join(" ; ")})`);
    return hints.length ? `précise ${hints.join(", ")} pour les départager` : "à départager avec le service technique";
  }

  // answers in force, each with its ×, so none stays active unseen
  function renderNeedbar() {
    const t = [];
    const repl = crit.mode === "remplacement";
    if (repl && C.REPLACE_TYPES[crit.replaceType]) t.push([C.REPLACE_TYPES[crit.replaceType].label, "replaceType"]);
    if (crit.food) t.push([`Contact alimentaire : ${{ oui: "oui (NSF H1)", non: "non", nsp: "à préciser" }[crit.food]}`, "food"]);
    if (crit.application) t.push([appLabel(crit.application), "application"]);
    const tr = C.needRange(crit);
    if (tr) t.push([C.needText(tr), "temp"]);
    else if (crit.tmin !== "" || crit.tmax !== "") t.push([`${crit.tmin || "?"} → ${crit.tmax || "?"} °C`, "temp"]);
    crit.env.forEach((e) => t.push([(ENV_CHOICES.find(([k]) => k === e) || [e, e])[1], "env:" + e]));
    crit.formats.forEach((f) => t.push([C.FORMATS[f] || f, "formats:" + f]));
    if (repl && crit.iso_vg) t.push([`ISO VG ${crit.iso_vg}`, "iso_vg"]);
    if (repl && crit.nlgi) t.push([`NLGI ${crit.nlgi}`, "nlgi"]);
    if (crit.query) t.push([`« ${crit.query} »`, "query"]);
    const bar = $("#sel-needbar");
    bar.hidden = !t.length;
    bar.innerHTML = t.length
      ? `<span class="lbl">${restored ? "REPRIS DE TA DERNIÈRE VISITE :" : "CRITÈRES ACTIFS :"}</span>${t
          .map(([l, k]) => `<span class="tag">${esc(l)}<button type="button" data-drop="${esc(k)}" aria-label="Retirer : ${esc(l)}" title="Retirer">×</button></span>`)
          .join("")}<button type="button" class="linkbtn" data-reset>tout effacer</button>`
      : "";
  }

  let lastRanked = [];
  function renderResults() {
    const c = effective();
    const SELECTABLE = PRODUCTS.filter((p) => !EQUIP.has(p.family));
    const ranked = C.rank(SELECTABLE, c);
    lastRanked = ranked;
    // recommended = made for the requested organ and every hard criterion checked on
    // sourced data; everything else is listed apart, never among the choices
    const { ok, near, adds, pending, out } = groups(ranked);
    renderNeedbar();
    const low = SELECTABLE.filter((p) => !isVerified(p));
    const noPack = low.filter((p) => C.gaps(p).some((g) => g.label === "conditionnements")).length;
    $("#sel-warning").textContent =
      (META.avertissement || "Données issues des sources publiques Interflon : à valider par le service technique.") +
      (low.length ? ` ${low.length} fiche(s) sur ${SELECTABLE.length} incomplète(s)${noPack ? `, dont ${noPack} sans conditionnements renseignés` : ""} : le badge de chaque fiche dit ce qui manque.` : "");
    const organ = c.application ? appLabel(c.application) : "";
    $("#sel-title").textContent = !hasCriteria(c)
      ? `TOUS LES LUBRIFIANTS ET NETTOYANTS · ${SELECTABLE.length}`
      : c.badTemp
      ? "PRODUITS RECOMMANDÉS"
      : organ
      ? `PRODUITS RECOMMANDÉS · ${ok.length} / ${SELECTABLE.length}`
      : `PRODUITS COMPATIBLES · ${ok.length} / ${SELECTABLE.length} · CHOISIS L'APPLICATION POUR LES CLASSER`;
    $("#sel-jump").textContent =
      !hasCriteria(c) || c.badTemp ? "Voir les produits ↓" : ok.length === 0 ? "Aucun produit : voir pourquoi ↓" : ok.length === 1 ? "Voir le produit ↓" : `Voir les ${ok.length} produits ↓`;
    if (!PRODUCTS.length) {
      $("#sel-results").innerHTML = `<div class="empty"><p>Catalogue produits vide.</p><p class="muted">Vérifie le fichier public/data/produits.json.</p></div>`;
      return;
    }
    if (c.badTemp) {
      $("#sel-results").innerHTML = `<div class="empty"><p>Température illisible : saisis un nombre, par exemple <b>-20</b> ou <b>180</b>.</p><p class="muted">Aucune recommandation tant que la température n'est pas comprise.</p></div>`;
      return;
    }
    if (!hasCriteria(c)) {
      $("#sel-results").innerHTML =
        `<div class="empty"><p>Réponds aux questions : les recommandations se mettent à jour en direct.</p></div>` +
        `<div class="cards">${ranked
          .slice()
          .sort((a, b) => String(a.product.name).localeCompare(String(b.product.name)))
          .map((r) => card(r, c, null))
          .join("")}</div>`;
      return;
    }
    // a ranking needs the application: without it, the products are only compatible
    const ranks = organ ? choiceRanks(ok) : [];
    const tied = ok.length ? ok.filter((r) => !C.compare(ok[0], r)).length : 0;
    const others = near.length || pending.length || adds.length;
    const group = (list, title, note, open) =>
      list.length
        ? `<details ${open ? "open" : ""}><summary class="section-title">${title} (${list.length})</summary>${note ? `<p class="group-note">${note}</p>` : ""}<div class="cards">${list
            .map((r) => card(r, c, null))
            .join("")}</div></details>`
        : "";
    $("#sel-results").innerHTML =
      (ok.length
        ? `${organ && tied > 2 ? `<p class="group-note">${tied} produits à égalité sur ces critères : ${tieHint(c, ok)}.</p>` : ""}<div class="cards">${ok
            .map((r, i) => card(r, c, ranks[i] || null))
            .join("")}</div>`
        : others
        ? `<div class="empty"><p>Aucun produit n'est confirmé ${organ ? `pour « ${esc(organ)} » ` : ""}sur tous les critères.</p><p class="muted">Pistes ci-dessous, à confirmer avec le service technique.</p></div>`
        : `<div class="empty"><p>Aucun produit ne remplit toutes les contraintes.</p><p class="muted">Assouplis la température ou l'application, ou consulte le service technique. Les produits écartés sont listés ci-dessous avec la raison.</p></div>`) +
      group(near, "PRÉVUS POUR UNE APPLICATION VOISINE", `Leur fiche ne les annonce pas pour « ${esc(organ)} » mais pour une application proche : à confirmer avec le service technique.`, !ok.length) +
      group(adds, "ADDITIFS À AJOUTER À L'HUILE EN PLACE", "Ils améliorent l'huile du client (technologie MicPol®), ils ne la remplacent pas.", !ok.length && !near.length) +
      group(pending, "À VÉRIFIER : DONNÉE MANQUANTE SUR LA FICHE", "", !ok.length && !near.length && !adds.length) +
      group(out, "ÉCARTÉS", "", !ok.length && !others);
  }

  // ------------------------------------------------------------------ product sheet
  function findProduct(nameOrId) {
    const n = norm(nameOrId).replace(/^interflon\s+/, "").trim();
    if (!n) return null;
    const exact = PRODUCTS.find((p) => p.id === nameOrId) || PRODUCTS.find((p) => norm(p.name).replace(/^interflon\s+/, "") === n);
    if (exact) return exact;
    const fuzzy = PRODUCTS.filter((p) => norm(p.name).includes(n));
    return fuzzy.length === 1 ? fuzzy[0] : null; // never guess between several products
  }

  function openProduct(id) {
    const p = findProduct(id);
    if (!p) return IFX.toast("Produit introuvable dans le catalogue", true);
    const list = (arr, fn) => (arr && arr.length ? `<ul class="tight">${arr.map((x) => `<li>${fn ? fn(x) : esc(x)}</li>`).join("")}</ul>` : '<span class="muted">—</span>');
    const html = `
      <div>${p.nsf ? `<span class="badge ${C.nsfList(p).includes("H1") ? "ok" : "blue"}">NSF ${esc(p.nsf)}${p.nsf_reg_no ? " · n° " + esc(p.nsf_reg_no) : ""}</span>` : '<span class="badge">pas de NSF</span>'}
        <span class="badge">${esc(famLabel(p.family))}</span><span class="badge">${esc(p.range || "")}</span>
        ${sheetBadge(p)}</div>
      <p>${esc(p.description_fr || "")}</p>
      ${p.nsf_note ? `<p class="muted small">${esc(p.nsf_note)}</p>` : ""}
      <dl class="kv">
        <dt>Température</dt><dd>${esc(tempTxt(p))} ${tempMark(p)}${p.temp_note ? `<div class="muted small">${esc(p.temp_note)}</div>` : ""}</dd>
        <dt>Viscosité</dt><dd>${esc(viscTxt(p) || "—")}</dd>
        <dt>Grade NLGI</dt><dd>${esc(p.nlgi || "—")}</dd>
        <dt>Base</dt><dd>${esc(p.base || "—")}</dd>
        <dt>Conditionnements</dt><dd>${esc((p.formats || []).join(", ") || "—")}</dd>
      </dl>
      <h3>APPLICATIONS</h3>${list(p.applications, (a) => esc(appLabel(a)))}
      <h3>PROPRIÉTÉS</h3>${list(p.properties, (a) => esc(C.PROPERTIES[a] || a))}
      ${(p.industries || []).length ? `<h3>SECTEURS</h3><div>${esc(p.industries.join(" · "))}</div>` : ""}
      ${(p.key_claims || []).length ? `<h3>ARGUMENTS (SOURCE INTERFLON)</h3>${list(p.key_claims)}` : ""}
      <h3>SOURCES</h3>${list(p.source_urls, (u) => `<a href="${esc(IFX.safeUrl(u))}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, "").slice(0, 70))}</a>`)}
      ${(p.source_docs || []).length ? `<h3>DOCUMENTS INTERFLON INTERNES</h3>${list(p.source_docs)}` : ""}
      ${(p.evidence || []).length ? `<details><summary class="muted" style="cursor:pointer;margin-top:10px">PREUVES (${p.evidence.length}) : citation exacte derrière chaque valeur</summary>${list(
        p.evidence,
        (e) => `<b>${esc(e.field)}</b> : « ${esc(e.quote)} » ${e.url ? `<a href="${esc(IFX.safeUrl(e.url))}" target="_blank" rel="noopener">source</a>` : `<span class="muted">(${esc(e.doc || "document interne")})</span>`}`
      )}</details>` : ""}
      ${(p.uncertain_fields || []).length ? `<h3>À CONFIRMER</h3>${list(p.uncertain_fields, (x) => esc(doubtTxt(x)))}` : ""}
      ${p.checked ? `<div class="muted small" style="margin-top:10px">Données vérifiées le ${esc(IFX.fmtDate(p.checked))}</div>` : ""}`;
    IFX.openDrawer(p.name, html);
  }

  // ------------------------------------------------------------------ print
  function printReco() {
    const c = effective();
    const main = groups(lastRanked).ok;
    const rk = choiceRanks(main);
    const ok = main.slice(0, 3);
    if (c.badTemp) return IFX.toast("Température illisible : corrige-la avant d'imprimer.", true);
    if (!hasCriteria(c)) return IFX.toast("Renseigne le besoin avant d'imprimer.", true);
    if (!c.application) return IFX.toast("Choisis l'application : la recommandation classe les produits pour cet organe.", true);
    if (!ok.length) return IFX.toast("Aucun produit n'est vérifié sur tous les critères : rien à recommander pour l'instant.", true);
    // products sharing the last printed rank but left out: named, never dropped silently
    const rest = rk[2] ? main.slice(3).filter((r, i) => rk[i + 3] && rk[i + 3].n === rk[2].n) : [];
    const need = [];
    if (crit.mode === "remplacement" && C.REPLACE_TYPES[crit.replaceType]) need.push(`Remplacement : ${C.REPLACE_TYPES[crit.replaceType].label}`);
    const foodRule = c.application === "nettoyage_degraissage" ? "NSF H1, A1 ou A7 requis" : c.application === "demoulage" ? "NSF 3H ou H1 requis" : "NSF H1 requis";
    if (c.food) need.push(`Contact alimentaire : ${{ oui: `oui (${foodRule})`, non: "non", nsp: "à préciser" }[c.food]}`);
    if (c.application) need.push(`Application : ${appLabel(c.application)}`);
    if (C.needRange(c)) need.push(`Température : ${C.needText(C.needRange(c))}`);
    if (c.env.length) need.push(`Environnement : ${c.env.map((e) => C.PROPERTIES[e] || e).join(", ")}`);
    if (c.formats.length) need.push(`Conditionnement : ${c.formats.map((f) => C.FORMATS[f]).join(", ")}`);
    // the printed proposal carries the logo of the build when it has one
    const logo = document.querySelector("#topbar .brand-logo img");
    $("#print-area").innerHTML = `
      ${logo ? `<img class="print-logo" src="${esc(logo.src)}" alt="Interflon" />` : ""}
      <h1>Recommandation de lubrification</h1>
      <div class="muted">${esc(crit.client || "")}${crit.client ? " · " : ""}${esc(IFX.fmtDate(IFX.today()))}</div>
      <h2>Besoin</h2><ul>${need.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${ok
        .map(
          (r, i) => {
            const p = r.product;
            const check = r.reasons.filter((x) => x.s !== "y");
            const notFood = c.food && c.food !== "non" && !C.foodOk(p, c.application);
            const label = `Choix ${rk[i].n}${rk[i].tie ? " (ex æquo)" : ""}`;
            return `<h2>${label} : ${esc(p.name)}${p.nsf ? ` — NSF ${esc(p.nsf)}` : ""}</h2>
        ${notFood ? `<p><b>ATTENTION : produit NON homologué pour le contact alimentaire. À n'utiliser que hors de toute zone de contact avec les denrées.</b></p>` : ""}
        <p>${esc(p.description_fr || "")}</p>
        <ul>${r.reasons.filter((x) => x.s === "y").map((x) => `<li>✔ ${esc(x.t)}</li>`).join("")}</ul>
        ${check.length ? `<div><b>À vérifier avant usage :</b></div><ul>${check.map((x) => `<li>${MARK[x.s] || "?"} ${esc(x.t)}</li>`).join("")}</ul>` : ""}
        <div class="muted">Température : ${esc(tempTxt(p))}${(p.formats || []).length ? ` · Conditionnements : ${esc(p.formats.join(", "))}` : ""}
          · ${isVerified(p) ? "fiche vérifiée (chaque donnée appuyée par une source citée)" : `${C.tempStatus(p) === "ok" ? "température vérifiée · " : ""}${esc(C.gapsText(p) || "données à confirmer")} (service technique Interflon)`}</div>`;
          }
        )
        .join("")}
      ${rest.length ? `<p>Également à égalité avec le choix ${rk[2].n} : ${esc(rest.map((r) => r.product.name).join(", "))}.</p>` : ""}
      <p class="muted" style="margin-top:18pt">Proposition indicative établie à partir des fiches produits publiques. À confirmer avec la fiche technique et la fiche de données de sécurité en vigueur.</p>`;
    if (IFX.STATIC && !IFX.OFFLINE) return copyReco();
    // only this recommendation is printed; other prints (Ctrl+P elsewhere) are left alone
    document.body.classList.add("printing-reco");
    window.print();
  }

  // claude.ai pages cannot print: copy the same recommendation as plain text
  function copyReco() {
    const area = $("#print-area");
    const lines = [];
    area.querySelectorAll("h1,h2,p,li,div").forEach((el) => {
      if (el.tagName === "DIV" && el.querySelector("h1,h2,p,li,div")) return;
      const t = el.textContent.replace(/\s+/g, " ").trim();
      if (!t) return;
      lines.push(el.tagName === "LI" ? "  - " + t : el.tagName === "H2" ? "\n" + t.toUpperCase() : t);
    });
    const text = lines.join("\n");
    area.innerHTML = "";
    const fallback = () => {
      IFX.openDrawer("Recommandation", `<p class="muted">Copie automatique refusée : sélectionne le texte ci-dessous.</p><textarea id="reco-text" rows="22" readonly></textarea>`, (root) => {
        const ta = $("#reco-text", root);
        ta.value = text;
        ta.focus();
        ta.select();
      });
    };
    try {
      navigator.clipboard.writeText(text).then(() => IFX.toast("Recommandation copiée : colle-la dans ton e-mail ou ton compte rendu"), fallback);
    } catch (e) {
      fallback();
    }
  }

  // ------------------------------------------------------------------ catalogue
  function renderCatalog() {
    const words = $("#cat-text").value;
    const fam = $("#cat-family").value;
    const h1 = $("#cat-h1").checked;
    const rows = PRODUCTS.filter((p) => C.matchesQuery(p, words))
      .filter((p) => !fam || p.family === fam)
      .filter((p) => !h1 || C.nsfList(p).includes("H1"))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    $("#cat-count").textContent = `${rows.length} / ${PRODUCTS.length}`;
    $("#cat-list").innerHTML = rows.length
      ? `<table class="grid"><thead><tr><th>Produit</th><th>Famille</th><th>NSF</th><th>Température</th><th class="hide-sm">Viscosité / NLGI</th><th class="hide-sm">Applications</th><th class="hide-sm">Conditionnements</th><th>Fiche</th></tr></thead><tbody>
      ${rows
        .map(
          (p) => `<tr class="clickable" data-detail="${esc(p.id)}"><td><a href="#" class="name" data-detail="${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(famLabel(p.family))}</td>
        <td>${p.nsf ? `<span class="badge ${C.nsfList(p).includes("H1") ? "ok" : "blue"}">${esc(p.nsf)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num">${esc(tempTxt(p))}</td><td class="hide-sm">${esc([viscTxt(p), p.nlgi && "NLGI " + p.nlgi].filter(Boolean).join(" · ") || "—")}</td>
        <td class="hide-sm">${esc((p.applications || []).map(appLabel).join(", "))}</td><td class="hide-sm">${esc((p.formats || []).join(", "))}</td>
        <td>${sheetBadge(p, true)}</td></tr>`
        )
        .join("")}</tbody></table>`
      : `<div class="empty"><p>Aucun produit.</p></div>`;
  }

  // Saved criteria may come from an older version: keep only what is still valid
  function sanitizeCrit(s) {
    const c = blank();
    if (!s || typeof s !== "object") return c;
    if (["besoin", "remplacement"].includes(s.mode)) c.mode = s.mode;
    if (["oui", "non", "nsp"].includes(s.food)) c.food = s.food;
    if (C.APPLICATIONS[s.application]) c.application = s.application;
    if (C.REPLACE_TYPES[s.replaceType]) c.replaceType = s.replaceType;
    c.env = (Array.isArray(s.env) ? s.env : []).filter((k) => ENV_CHOICES.some(([e]) => e === k));
    c.formats = (Array.isArray(s.formats) ? s.formats : []).filter((k) => C.FORMATS[k]);
    ["tmin", "tmax", "iso_vg", "nlgi", "query", "client"].forEach((k) => {
      if (typeof s[k] === "string" || typeof s[k] === "number") c[k] = String(s[k]).slice(0, 80);
    });
    if (s.fromEquiv && typeof s.fromEquiv === "object") {
      ["replaceType", "application", "food", "tmin", "tmax", "iso_vg", "nlgi"].forEach((k) => {
        const v = s.fromEquiv[k];
        if (v && typeof v === "object" && typeof v.was === "string" && typeof v.set === "string") c.fromEquiv[k] = { was: v.was.slice(0, 80), set: v.set.slice(0, 80) };
      });
    }
    return c;
  }

  // ------------------------------------------------------------------ public API
  S.init = (productsDoc, equivDoc) => {
    PRODUCTS = (productsDoc && productsDoc.products) || [];
    META = (productsDoc && productsDoc._meta) || {};
    EQUIV = ((equivDoc && equivDoc.equivalences) || []).filter((x) => x && x.marque && x.reference);
    crit = sanitizeCrit(IFX.store.get(LS_CRIT, null));
    restored = hasCriteria(effective());
    if (IFX.STATIC && !IFX.OFFLINE) $("#sel-print").textContent = "Copier la recommandation";
    window.addEventListener("afterprint", () => {
      document.body.classList.remove("printing-reco");
      $("#print-area").innerHTML = "";
    });
    renderForm();
    bindForm();
    const fams = Array.from(new Set(PRODUCTS.map((p) => p.family).filter(Boolean))).sort();
    $("#cat-family").innerHTML = `<option value="">Toutes familles</option>` + fams.map((f) => `<option value="${esc(f)}">${esc(famLabel(f))}</option>`).join("");
    $("#cat-text").addEventListener("input", renderCatalog);
    $("#cat-family").addEventListener("change", renderCatalog);
    $("#cat-h1").addEventListener("change", renderCatalog);
    $("#cat-list").addEventListener("click", (e) => {
      if (e.target.closest("a[data-detail]")) e.preventDefault(); // keep the #cat hash
      const tr = e.target.closest("[data-detail]");
      if (tr) openProduct(tr.dataset.detail);
    });
  };
  S.onShow = renderResults;
  S.onShowCatalog = renderCatalog;
  S.catalogQuery = (q) => {
    $("#cat-text").value = q || "";
    renderCatalog();
  };
  S.fromSegment = (seg) => {
    crit = blank();
    segHint = seg;
    if (seg && seg.food) crit.food = "oui";
    changed(true);
  };
  S.openProductByName = (name) => openProduct(name);
  S.products = () => PRODUCTS;
  S.equivCount = () => EQUIV.length;
})();
