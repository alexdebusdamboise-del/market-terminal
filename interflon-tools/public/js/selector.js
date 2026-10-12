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

  const blank = () => ({ mode: "besoin", food: "", application: "", tmin: "", tmax: "", env: [], formats: [], replaceType: "", iso_vg: "", nlgi: "", query: "", client: "" });
  let crit = blank();

  const famLabel = (f) => FAMILIES[f] || f || "—";
  const appLabel = (a) => C.APPLICATIONS[a] || a;
  const tempTxt = (p) =>
    p.temp_min_c === null && p.temp_max_c === null
      ? "n.c."
      : `${p.temp_min_c === null ? "?" : p.temp_min_c} → ${p.temp_max_c === null ? "?" : p.temp_max_c} °C`;
  const isVerified = (p) => p.confidence === "high" && !(p.uncertain_fields || []).some((f) => /nsf|temp/.test(f));

  function effective() {
    const c = {
      food: crit.food || null,
      application: crit.application || null,
      tmin: crit.tmin,
      tmax: crit.tmax,
      env: crit.env.slice(),
      formats: crit.formats.slice(),
      query: crit.query,
    };
    if (crit.mode === "remplacement") {
      c.iso_vg = crit.iso_vg;
      c.nlgi = crit.nlgi;
      const t = C.REPLACE_TYPES[crit.replaceType];
      if (t) {
        if (!c.application && t.application) c.application = t.application;
        if (t.families) c.families = t.families;
        (t.env || []).forEach((e) => c.env.includes(e) || c.env.push(e));
      }
    }
    return c;
  }

  const hasCriteria = (c) => !!(c.food || c.application || c.tmin !== "" || c.tmax !== "" || c.env.length || c.formats.length || c.query || c.families || c.iso_vg || c.nlgi);

  // ------------------------------------------------------------------ form
  const tiles = (name, entries, current, multi) =>
    `<div class="tiles" data-name="${name}" data-multi="${multi ? 1 : 0}">${entries
      .map(([k, l]) => `<button type="button" class="tile ${multi ? (current.includes(k) ? "on" : "") : current === k ? "on" : ""}" data-v="${esc(k)}">${esc(l)}</button>`)
      .join("")}</div>`;

  function renderForm() {
    const appEntries = Object.entries(C.APPLICATIONS).filter(([k]) => k !== "autre" && PRODUCTS.some((p) => (p.applications || []).includes(k)));
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
        ${EQUIV.length ? `<div style="margin-top:6px"><label class="muted small" for="sel-equiv">Référence concurrente (table validée)</label>
          <input id="sel-equiv" type="text" placeholder="Marque ou référence…"/><div id="sel-equiv-res"></div></div>` : ""}
      </div>` : ""}
      <div class="q"><div class="qt">1 · CONTACT ALIMENTAIRE POSSIBLE ?</div>
        <div class="qh">Agroalimentaire, boissons, pharma, emballage alimentaire : contact fortuit = NSF H1 obligatoire</div>
        ${tiles("food", [["oui", "Oui → NSF H1"], ["non", "Non"], ["nsp", "Je ne sais pas"]], crit.food, false)}</div>
      <div class="q"><div class="qt">2 · APPLICATION</div>${tiles("application", appEntries, crit.application, false)}</div>
      <div class="q"><div class="qt">3 · TEMPÉRATURE DE FONCTIONNEMENT</div>
        <div class="temp-row">
          <div><label for="sel-tmin">Mini (°C)</label><input id="sel-tmin" type="number" step="1" value="${esc(crit.tmin)}" placeholder="ex. -20"/></div>
          <div><label for="sel-tmax">Maxi (°C)</label><input id="sel-tmax" type="number" step="1" value="${esc(crit.tmax)}" placeholder="ex. 180"/></div>
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
      crit = blank();
      segHint = null;
      changed(true);
    });
    $("#sel-results").addEventListener("click", (e) => {
      const d = e.target.closest("[data-detail]");
      if (d) openProduct(d.dataset.detail);
    });
    $("#sel-print").addEventListener("click", printReco);
  }

  function changed(rerenderForm) {
    IFX.store.set(LS_CRIT, crit);
    if (rerenderForm) renderForm();
    renderResults();
  }

  function renderEquiv(q) {
    const box = $("#sel-equiv-res");
    if (!box) return;
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return (box.innerHTML = "");
    const hits = EQUIV.filter((x) => words.every((w) => norm(`${x.marque} ${x.reference}`).includes(w))).slice(0, 8);
    box.innerHTML = hits.length
      ? `<ul class="tight">${hits
          .map((x) => `<li><b>${esc(x.marque)} ${esc(x.reference)}</b> → <a href="#" data-detail="${esc((findProduct(x.interflon) || {}).id || "")}">${esc(x.interflon)}</a>${x.note ? ` <span class="muted">· ${esc(x.note)}</span>` : ""}${x.valide_par ? ` <span class="badge ok">validé ${esc(x.valide_par)}</span>` : ""}</li>`)
          .join("")}</ul>`
      : `<div class="muted small">Pas d'équivalence enregistrée : utilise les critères ci-dessous.</div>`;
  }

  // ------------------------------------------------------------------ results
  function tempBar(p, c) {
    const lo = -60;
    const hi = 400;
    const pos = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
    if (p.temp_min_c === null && p.temp_max_c === null) return "";
    const a = p.temp_min_c === null ? lo : p.temp_min_c;
    const b = p.temp_max_c === null ? hi : p.temp_max_c;
    const tmin = c.tmin === "" || c.tmin === undefined ? null : +c.tmin;
    const tmax = c.tmax === "" || c.tmax === undefined ? null : +c.tmax;
    const need =
      tmin !== null || tmax !== null
        ? `<span class="need" style="left:${pos(tmin === null ? tmax : tmin)}%;width:${Math.max(0.6, pos(tmax === null ? tmin : tmax) - pos(tmin === null ? tmax : tmin))}%"></span>`
        : "";
    return `<div class="tbar" title="Plage produit (orange) vs besoin (bleu), échelle -60 → 400 °C"><span class="p" style="left:${pos(a)}%;width:${pos(b) - pos(a)}%"></span>${need}</div>`;
  }

  function card(r, c, top) {
    const p = r.product;
    return `<div class="card ${top ? "top" : ""} ${r.eligible ? "" : "out"}">
      <div class="card-h"><div><span class="pname">${esc(p.name)}</span>
        ${p.nsf ? `<span class="badge ${C.nsfList(p).includes("H1") ? "ok" : "blue"}">NSF ${esc(p.nsf)}</span>` : ""}
        <span class="badge">${esc(famLabel(p.family))}</span>
        ${isVerified(p) ? '<span class="badge ok" title="Plage de température et NSF confirmées par une source Interflon">fiche vérifiée</span>' : '<span class="badge warn" title="Certaines données restent à confirmer par le service technique">à valider</span>'}
      </div><button type="button" class="btn small" data-detail="${esc(p.id)}">Détails</button></div>
      <div class="desc">${esc(p.description_fr || "")}</div>
      <div class="small muted">Température : ${esc(tempTxt(p))}${p.viscosity_iso_vg ? ` · ISO VG ${esc(p.viscosity_iso_vg)}` : ""}${p.nlgi ? ` · NLGI ${esc(p.nlgi)}` : ""}${(p.formats || []).length ? ` · ${esc(p.formats.join(", "))}` : ""}</div>
      ${tempBar(p, c)}
      ${r.reasons.length ? `<ul class="reasons">${r.reasons.map((x) => `<li class="${x.s}">${x.s === "y" ? "✔" : x.s === "n" ? "✖" : "?"} ${esc(x.t)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  let lastRanked = [];
  function renderResults() {
    const c = effective();
    const ranked = C.rank(PRODUCTS, c);
    lastRanked = ranked;
    const ok = ranked.filter((r) => r.eligible);
    const out = ranked.filter((r) => !r.eligible);
    const low = PRODUCTS.filter((p) => !isVerified(p)).length;
    $("#sel-warning").textContent =
      (META.avertissement || "Données issues des sources publiques Interflon : à valider par le service technique.") +
      (low ? ` ${low} fiche(s) sur ${PRODUCTS.length} comportent des données à confirmer.` : "");
    $("#sel-title").textContent = hasCriteria(c) ? `PRODUITS RECOMMANDÉS · ${ok.length} / ${PRODUCTS.length}` : `TOUS LES PRODUITS · ${PRODUCTS.length}`;
    if (!PRODUCTS.length) {
      $("#sel-results").innerHTML = `<div class="empty"><p>Catalogue produits vide.</p><p class="muted">Vérifie le fichier public/data/produits.json.</p></div>`;
      return;
    }
    if (!hasCriteria(c)) {
      $("#sel-results").innerHTML =
        `<div class="empty"><p>Réponds aux questions à gauche : les recommandations se mettent à jour en direct.</p></div>` +
        `<div class="cards">${ranked
          .slice()
          .sort((a, b) => String(a.product.name).localeCompare(String(b.product.name)))
          .map((r) => card(r, c, false))
          .join("")}</div>`;
      return;
    }
    $("#sel-results").innerHTML =
      (ok.length
        ? `<div class="cards">${ok.map((r, i) => card(r, c, i < 3)).join("")}</div>`
        : `<div class="empty"><p>Aucun produit ne remplit toutes les contraintes.</p><p class="muted">Assouplis la température ou l'application, ou consulte le service technique. Les produits écartés sont listés ci-dessous avec la raison.</p></div>`) +
      (out.length ? `<details ${ok.length ? "" : "open"}><summary class="section-title">ÉCARTÉS (${out.length})</summary><div class="cards">${out.map((r) => card(r, c, false)).join("")}</div></details>` : "");
  }

  // ------------------------------------------------------------------ product sheet
  function findProduct(nameOrId) {
    const n = norm(nameOrId).replace(/^interflon\s+/, "");
    return (
      PRODUCTS.find((p) => p.id === nameOrId) ||
      PRODUCTS.find((p) => norm(p.name).replace(/^interflon\s+/, "") === n) ||
      PRODUCTS.find((p) => norm(p.name).includes(n)) ||
      null
    );
  }

  function openProduct(id) {
    const p = findProduct(id);
    if (!p) return IFX.toast("Produit introuvable dans le catalogue", true);
    const list = (arr, fn) => (arr && arr.length ? `<ul class="tight">${arr.map((x) => `<li>${fn ? fn(x) : esc(x)}</li>`).join("")}</ul>` : '<span class="muted">—</span>');
    const html = `
      <div>${p.nsf ? `<span class="badge ${C.nsfList(p).includes("H1") ? "ok" : "blue"}">NSF ${esc(p.nsf)}${p.nsf_reg_no ? " · n° " + esc(p.nsf_reg_no) : ""}</span>` : '<span class="badge">pas de NSF</span>'}
        <span class="badge">${esc(famLabel(p.family))}</span><span class="badge">${esc(p.range || "")}</span>
        ${isVerified(p) ? '<span class="badge ok">fiche vérifiée</span>' : '<span class="badge warn">à valider</span>'}</div>
      <p>${esc(p.description_fr || "")}</p>
      <dl class="kv">
        <dt>Température</dt><dd>${esc(tempTxt(p))}${p.temp_note ? `<div class="muted small">${esc(p.temp_note)}</div>` : ""}</dd>
        <dt>Viscosité</dt><dd>${esc(p.viscosity_iso_vg ? "ISO VG " + p.viscosity_iso_vg : "—")}</dd>
        <dt>Grade NLGI</dt><dd>${esc(p.nlgi || "—")}</dd>
        <dt>Base</dt><dd>${esc(p.base || "—")}</dd>
        <dt>Conditionnements</dt><dd>${esc((p.formats || []).join(", ") || "—")}</dd>
      </dl>
      <h3>APPLICATIONS</h3>${list(p.applications, (a) => esc(appLabel(a)))}
      <h3>PROPRIÉTÉS</h3>${list(p.properties, (a) => esc(C.PROPERTIES[a] || a))}
      ${(p.industries || []).length ? `<h3>SECTEURS</h3><div>${esc(p.industries.join(" · "))}</div>` : ""}
      ${(p.key_claims || []).length ? `<h3>ARGUMENTS (SOURCE INTERFLON)</h3>${list(p.key_claims)}` : ""}
      <h3>SOURCES</h3>${list(p.source_urls, (u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, "").slice(0, 70))}</a>`)}
      ${(p.uncertain_fields || []).length ? `<h3>À CONFIRMER</h3><div class="muted">${esc(p.uncertain_fields.join(", "))}</div>` : ""}
      ${p.checked ? `<div class="muted small" style="margin-top:10px">Données vérifiées le ${esc(IFX.fmtDate(p.checked))}</div>` : ""}`;
    IFX.openDrawer(p.name, html);
  }

  // ------------------------------------------------------------------ print
  function printReco() {
    const c = effective();
    const ok = lastRanked.filter((r) => r.eligible).slice(0, 3);
    if (!hasCriteria(c) || !ok.length) return IFX.toast("Renseigne le besoin et obtiens au moins une recommandation avant d'imprimer.", true);
    const need = [];
    if (crit.mode === "remplacement" && C.REPLACE_TYPES[crit.replaceType]) need.push(`Remplacement : ${C.REPLACE_TYPES[crit.replaceType].label}`);
    if (c.food) need.push(`Contact alimentaire : ${{ oui: "oui (NSF H1 requis)", non: "non", nsp: "à préciser" }[c.food]}`);
    if (c.application) need.push(`Application : ${appLabel(c.application)}`);
    if (c.tmin !== "" || c.tmax !== "") need.push(`Température : ${c.tmin === "" ? "?" : c.tmin} → ${c.tmax === "" ? "?" : c.tmax} °C`);
    if (c.env.length) need.push(`Environnement : ${c.env.map((e) => C.PROPERTIES[e] || e).join(", ")}`);
    if (c.formats.length) need.push(`Conditionnement : ${c.formats.map((f) => C.FORMATS[f]).join(", ")}`);
    $("#print-area").innerHTML = `
      <h1>Recommandation de lubrification</h1>
      <div class="muted">${esc(crit.client || "")}${crit.client ? " · " : ""}${esc(IFX.fmtDate(IFX.today()))}</div>
      <h2>Besoin</h2><ul>${need.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${ok
        .map(
          (r, i) => `<h2>${i + 1}. ${esc(r.product.name)}${r.product.nsf ? ` — NSF ${esc(r.product.nsf)}` : ""}</h2>
        <p>${esc(r.product.description_fr || "")}</p>
        <ul>${r.reasons.filter((x) => x.s === "y").map((x) => `<li>${esc(x.t)}</li>`).join("")}</ul>
        <div class="muted">Température : ${esc(tempTxt(r.product))}${(r.product.formats || []).length ? ` · Conditionnements : ${esc(r.product.formats.join(", "))}` : ""}</div>`
        )
        .join("")}
      <p class="muted" style="margin-top:18pt">Proposition indicative établie à partir des fiches produits publiques. À confirmer avec la fiche technique et la fiche de données de sécurité en vigueur.</p>`;
    window.print();
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
          (p) => `<tr class="clickable" data-detail="${esc(p.id)}"><td class="name">${esc(p.name)}</td><td>${esc(famLabel(p.family))}</td>
        <td>${p.nsf ? `<span class="badge ${C.nsfList(p).includes("H1") ? "ok" : "blue"}">${esc(p.nsf)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num">${esc(tempTxt(p))}</td><td class="hide-sm">${esc([p.viscosity_iso_vg && "VG " + p.viscosity_iso_vg, p.nlgi && "NLGI " + p.nlgi].filter(Boolean).join(" · ") || "—")}</td>
        <td class="hide-sm">${esc((p.applications || []).map(appLabel).join(", "))}</td><td class="hide-sm">${esc((p.formats || []).join(", "))}</td>
        <td>${isVerified(p) ? '<span class="badge ok">vérifiée</span>' : '<span class="badge warn">à valider</span>'}</td></tr>`
        )
        .join("")}</tbody></table>`
      : `<div class="empty"><p>Aucun produit.</p></div>`;
  }

  // ------------------------------------------------------------------ public API
  S.init = (productsDoc, equivDoc) => {
    PRODUCTS = (productsDoc && productsDoc.products) || [];
    META = (productsDoc && productsDoc._meta) || {};
    EQUIV = ((equivDoc && equivDoc.equivalences) || []).filter((x) => x && x.marque && x.interflon);
    const saved = IFX.store.get(LS_CRIT, null);
    if (saved && typeof saved === "object") crit = Object.assign(blank(), saved);
    renderForm();
    bindForm();
    const fams = Array.from(new Set(PRODUCTS.map((p) => p.family).filter(Boolean))).sort();
    $("#cat-family").innerHTML = `<option value="">Toutes familles</option>` + fams.map((f) => `<option value="${esc(f)}">${esc(famLabel(f))}</option>`).join("");
    $("#cat-text").addEventListener("input", renderCatalog);
    $("#cat-family").addEventListener("change", renderCatalog);
    $("#cat-h1").addEventListener("change", renderCatalog);
    $("#cat-list").addEventListener("click", (e) => {
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
})();
