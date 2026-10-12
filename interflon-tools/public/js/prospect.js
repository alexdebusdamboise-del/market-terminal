/* PROS — prospecting module: target plants by sector (NAF) + zone, score them,
 * show them as a list or on a map, open a company sheet, save to the pipeline. */
(function () {
  "use strict";
  const IFX = window.IFX;
  const { esc, $, $$, norm } = IFX;
  const P = (IFX.pros = {});

  // Staff bands (INSEE "tranche d'effectif"): lower / upper bounds
  const TR_MIN = { NN: 0, "00": 0, "01": 1, "02": 3, "03": 6, 11: 10, 12: 20, 21: 50, 22: 100, 31: 200, 32: 250, 41: 500, 42: 1000, 51: 2000, 52: 5000, 53: 10000 };
  const TR_MAX = { NN: 0, "00": 0, "01": 2, "02": 5, "03": 9, 11: 19, 12: 49, 21: 99, 22: 199, 31: 249, 32: 499, 41: 999, 42: 1999, 51: 4999, 52: 9999, 53: Infinity };
  const TR_SHORT = { NN: "0", "00": "0", "01": "1-2", "02": "3-5", "03": "6-9", 11: "10-19", 12: "20-49", 21: "50-99", 22: "100-199", 31: "200-249", 32: "250-499", 41: "500-999", 42: "1000-1999", 51: "2000-4999", 52: "5000-9999", 53: "10000+" };
  const MAX_PAGES = 40; // "tout charger" stops at 1 000 companies
  const NEW_SITE_DAYS = 730;
  const LS_FILTERS = "ifx.pros.filters";
  // Departements accepted by the upstream API (metropole, Corse, DROM except 975)
  const DEP_OK = /^(0[1-9]|1\d|2[1-9]|[3-8]\d|9[0-5]|2A|2B|97[12346])$/;

  let REF = null;
  let SEGMENTS = [];
  let NAF2SEG = {};

  const st = {
    segs: new Set(),
    customNaf: [],
    zone: "dep",
    deps: [],
    region: "",
    center: null,
    radius: 20,
    minSize: 10,
    companies: new Map(), // siren -> normalized company
    rows: [], // one row per establishment
    page: 0,
    totalPages: 0,
    totalResults: 0,
    query: null,
    queryMin: 0, // site-size pre-filter used by the last API query
    seq: 0,
    loading: false,
    abort: null,
    sort: { key: "score", dir: -1 },
    mode: "list",
    renderLimit: 400,
    needFit: true, // fit the map to the markers once per new result set
  };

  // ------------------------------------------------------------------ helpers
  const nafLabel = (code) => (REF && REF.naf[code]) || "";
  const division = (naf) => parseInt(String(naf || "").slice(0, 2), 10);
  const segOf = (naf) => (naf && NAF2SEG[naf] ? NAF2SEG[naf] : null);
  const trLabel = (t) => (t && TR_SHORT[t] ? TR_SHORT[t] + " sal." : "n.c.");
  const narrow = () => window.matchMedia && window.matchMedia("(max-width: 980px)").matches;
  const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity);

  function scoreRow(co, et, seg) {
    const parts = [];
    const lb = et.tranche && TR_MIN[et.tranche] !== undefined ? TR_MIN[et.tranche] : null;
    const size = lb === null ? 0 : lb >= 500 ? 45 : lb >= 250 ? 40 : lb >= 100 ? 34 : lb >= 50 ? 26 : lb >= 20 ? 18 : lb >= 10 ? 10 : lb >= 1 ? 3 : 0;
    parts.push(["Taille du site", size]);
    const prio = seg ? { haute: 30, moyenne: 20, basse: 10 }[seg.priority] || 15 : 15;
    parts.push([seg ? `Secteur ${seg.label} (${seg.priority})` : "Secteur hors liste", prio]);
    const d = division(et.naf || co.naf);
    const prod = d && d <= 39 ? 10 : d >= 49 && d <= 53 ? 5 : 0;
    parts.push(["Site de production probable", prod]);
    const ca = co.ca || 0;
    const caPts = ca >= 50e6 ? 10 : ca >= 10e6 ? 7 : ca >= 2e6 ? 4 : 0;
    parts.push(["Chiffre d'affaires", caPts]);
    const fresh = daysSince(et.date_creation) < NEW_SITE_DAYS ? 5 : 0;
    parts.push(["Site récent (< 2 ans)", fresh]);
    const total = parts.reduce((s, p) => s + p[1], 0);
    return { score: Math.min(100, total), parts };
  }

  function companyTrancheFilter(min) {
    // A company can only host a site of >= min staff if its own band can reach min
    if (!min) return [];
    return Object.keys(TR_MAX).filter((t) => TR_MAX[t] >= min && t !== "NN" && t !== "00");
  }

  function selectedNaf() {
    const set = new Set();
    st.segs.forEach((k) => {
      const s = SEGMENTS.find((x) => x.key === k);
      if (s) s.naf_codes.forEach((c) => set.add(c));
    });
    st.customNaf.forEach((c) => set.add(c));
    return Array.from(set);
  }

  // ------------------------------------------------------------------ filters UI
  function renderSegments() {
    $("#seg-list").innerHTML = SEGMENTS.map(
      (s) => `<label class="seg-item" title="${esc(s.pitch_fr || "")}">
        <input type="checkbox" value="${esc(s.key)}" ${st.segs.has(s.key) ? "checked" : ""}/>
        <span>${esc(s.label)} <span class="n">(${s.naf_codes.length})</span></span>
        <span class="prio ${esc(s.priority)}">${esc(s.priority)}</span></label>`
    ).join("");
  }

  function renderChips() {
    $("#naf-custom").innerHTML = st.customNaf
      .map((c) => `<span class="chip" title="${esc(nafLabel(c))}">${esc(c)} ${esc(nafLabel(c).slice(0, 28))}<button type="button" data-naf="${esc(c)}">✕</button></span>`)
      .join("");
    $("#dep-chips").innerHTML = st.deps
      .map((d) => `<span class="chip">${esc(d)} ${esc(REF.departements[d] || "")}<button type="button" data-dep="${esc(d)}">✕</button></span>`)
      .join("");
  }

  function stopPicking() {
    picking = false;
    document.body.classList.remove("map-picking");
  }

  function setZone(mode) {
    if (mode !== "autour") stopPicking();
    st.zone = mode;
    $$("#zone-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $$(".zone-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== mode));
  }

  function setCenter(lat, lon, label) {
    stopPicking();
    $("#city-input").value = "";
    st.center = { lat, lon, label };
    $("#center-label").textContent = `Centre : ${label} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    drawCenter();
    saveFilters();
  }

  function saveFilters() {
    IFX.store.set(LS_FILTERS, {
      segs: Array.from(st.segs),
      customNaf: st.customNaf,
      zone: st.zone,
      deps: st.deps,
      region: st.region,
      center: st.center,
      radius: st.radius,
      minSize: st.minSize,
    });
  }

  function loadFilters() {
    const f = IFX.store.get(LS_FILTERS, null);
    if (!f) return;
    (f.segs || []).forEach((k) => SEGMENTS.some((s) => s.key === k) && st.segs.add(k));
    st.customNaf = (f.customNaf || []).filter((c) => REF.naf[c]);
    st.deps = (f.deps || []).filter((d) => REF.departements[d]);
    st.region = REF.regions[f.region] ? f.region : "";
    st.center = f.center && isFinite(f.center.lat) && isFinite(f.center.lon) ? f.center : null;
    st.radius = [10, 20, 30, 50].includes(+f.radius) ? +f.radius : 20;
    st.minSize = [0, 10, 20, 50, 100, 250, 500].includes(+f.minSize) ? +f.minSize : 10;
    st.zone = ["dep", "region", "autour"].includes(f.zone) ? f.zone : "dep";
  }

  function bindFilters() {
    $("#seg-list").addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox]");
      if (!cb) return;
      cb.checked ? st.segs.add(cb.value) : st.segs.delete(cb.value);
      saveFilters();
    });
    $("#seg-none").addEventListener("click", () => {
      st.segs.clear();
      renderSegments();
      saveFilters();
    });

    // custom NAF codes: search by code or label
    const nafEntries = Object.entries(REF.naf).map(([c, l]) => [c, l, norm(c + " " + l)]);
    IFX.autocomplete(
      $("#naf-input"),
      $("#naf-suggest"),
      (q) => {
        const words = norm(q).split(/\s+/).filter(Boolean);
        return nafEntries
          .filter((e) => words.every((w) => e[2].includes(w)))
          .slice(0, 25)
          .map(([c, l]) => ({ html: `<b>${esc(c)}</b> ${esc(l)}${segOf(c) ? ` <span class="muted">· ${esc(segOf(c).label)}</span>` : ""}`, value: c }));
      },
      (code) => {
        if (!st.customNaf.includes(code)) st.customNaf.push(code);
        renderChips();
        saveFilters();
      }
    );
    $("#naf-custom").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-naf]");
      if (!b) return;
      st.customNaf = st.customNaf.filter((c) => c !== b.dataset.naf);
      renderChips();
      saveFilters();
    });

    // departements
    const depEntries = Object.entries(REF.departements).filter(([d]) => DEP_OK.test(d));
    IFX.autocomplete(
      $("#dep-input"),
      $("#dep-suggest"),
      (q) => {
        const n = norm(q);
        return depEntries
          .filter(([d, l]) => norm(d).startsWith(n) || norm(l).includes(n))
          .slice(0, 12)
          .map(([d, l]) => ({ html: `<b>${esc(d)}</b> ${esc(l)}`, value: d }));
      },
      (d) => addDep(d)
    );
    $("#dep-chips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-dep]");
      if (!b) return;
      st.deps = st.deps.filter((d) => d !== b.dataset.dep);
      renderChips();
      saveFilters();
    });

    // regions
    $("#region-select").innerHTML =
      `<option value="">— choisir une région —</option>` +
      Object.entries(REF.regions)
        .sort((a, b) => a[1].localeCompare(b[1], "fr"))
        .map(([c, l]) => `<option value="${esc(c)}">${esc(l)}</option>`)
        .join("");
    $("#region-select").value = st.region;
    $("#region-select").addEventListener("change", (e) => {
      st.region = e.target.value;
      saveFilters();
    });

    $("#zone-mode").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (!b) return;
      setZone(b.dataset.mode);
      saveFilters();
    });

    // "autour de": city geocoding, my position, pick on map
    IFX.autocomplete(
      $("#city-input"),
      $("#city-suggest"),
      async (q) => {
        if (q.length < 2) return [];
        try {
          const r = await IFX.api("/api/geocode", { q });
          return (r.results || []).map((x) => ({ html: `<b>${esc(x.label)}</b> <span class="muted">${esc(x.postcode)} ${esc(x.context)}</span>`, value: x }));
        } catch (e) {
          return [{ html: `<span class="muted">Géocodage indisponible : utilise « Ma position » ou la carte</span>`, value: null }];
        }
      },
      (x) => x && setCenter(x.lat, x.lon, x.label)
    );
    $("#geo-me").addEventListener("click", () => {
      if (!navigator.geolocation) return IFX.toast("Géolocalisation non disponible", true);
      navigator.geolocation.getCurrentPosition(
        (pos) => setCenter(pos.coords.latitude, pos.coords.longitude, "ma position"),
        (err) => IFX.toast("Position refusée ou indisponible (" + err.message + ")", true),
        { enableHighAccuracy: false, timeout: 10000 }
      );
    });
    $("#geo-map").addEventListener("click", () => {
      setMode("map");
      picking = true;
      document.body.classList.add("map-picking");
      if (narrow()) $("#res-map").scrollIntoView({ behavior: "smooth", block: "start" });
      IFX.toast(narrow() ? "Touche la carte pour choisir le centre de recherche" : "Clique sur la carte pour choisir le centre de recherche");
    });
    $("#radius").value = String(st.radius);
    $("#radius").addEventListener("change", (e) => {
      st.radius = +e.target.value;
      drawCenter();
      saveFilters();
    });

    $("#min-size").value = String(st.minSize);
    $("#min-size").addEventListener("change", (e) => {
      st.minSize = +e.target.value;
      saveFilters();
      // raising the minimum only filters what is loaded; lowering it needs smaller companies from the API
      if (st.query && st.minSize < st.queryMin) IFX.toast("Taille réduite : relance la recherche pour charger les sites plus petits.");
      renderResults();
    });

    ["#f-hide-clients", "#f-hide-saved", "#f-new", "#f-no-siege"].forEach((s) => $(s).addEventListener("change", renderResults));
    $$(".f-cat").forEach((c) => c.addEventListener("change", renderResults));
    $("#f-text").addEventListener("input", renderResults);

    $("#pros-search").addEventListener("click", () => search(true));
    $("#pros-more").addEventListener("click", () => loadPage(st.page + 1));
    $("#pros-all").addEventListener("click", loadAll);
    $("#pros-csv").addEventListener("click", exportCsv);
    $("#res-mode").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (b) setMode(b.dataset.mode);
    });
  }

  function addDep(d) {
    if (!REF.departements[d] || !DEP_OK.test(d)) return;
    if (!st.deps.includes(d)) st.deps.push(d);
    setZone("dep");
    renderChips();
    saveFilters();
  }

  // ------------------------------------------------------------------ querying
  function buildQuery() {
    const naf = selectedNaf();
    if (!naf.length) return { error: "Choisis au moins un secteur ou un code NAF." };
    if (naf.length > 200) return { error: `Trop de codes NAF (${naf.length}) : 200 maximum, retire des secteurs.` };
    if (st.zone === "dep") {
      if (!st.deps.length) return { error: "Ajoute au moins un département." };
      return { endpoint: "/api/entreprises", params: { naf, departement: st.deps, tranche: companyTrancheFilter(st.minSize) } };
    }
    if (st.zone === "region") {
      if (!st.region) return { error: "Choisis une région." };
      return { endpoint: "/api/entreprises", params: { naf, region: st.region, tranche: companyTrancheFilter(st.minSize) } };
    }
    if ($("#city-input").value.trim()) return { error: "Choisis la ville dans la liste proposée sous le champ (ou appuie sur Entrée)." };
    if (!st.center) return { error: "Choisis un centre : ville, ma position ou clic sur la carte." };
    return { endpoint: "/api/autour", params: { naf, lat: st.center.lat.toFixed(5), lon: st.center.lon.toFixed(5), radius: st.radius } };
  }

  function search(reset) {
    const q = buildQuery();
    if (q.error) {
      $("#pros-msg").textContent = q.error;
      IFX.toast(q.error, true);
      return;
    }
    if (st.abort) st.abort.abort();
    st.seq++;
    st.loading = false;
    st.query = q;
    st.queryMin = q.endpoint === "/api/entreprises" ? st.minSize : 0;
    st.needFit = true;
    if (reset) {
      st.companies.clear();
      st.rows = [];
      st.page = 0;
      st.totalPages = 0;
      st.totalResults = 0;
      st.renderLimit = 400;
    }
    $("#pros-msg").textContent = "";
    if (narrow()) $("#res-title").scrollIntoView({ behavior: "smooth", block: "start" });
    return loadPage(1);
  }

  async function fetchPage(page, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await IFX.api(st.query.endpoint, Object.assign({}, st.query.params, { page, per_page: 25 }), signal);
      } catch (e) {
        if (e.status === 429 && attempt < 3) {
          await new Promise((r) => setTimeout(r, Math.min(10, e.retryAfter || 2) * 1000));
          continue;
        }
        throw e;
      }
    }
  }

  function ingest(data) {
    st.totalPages = data.total_pages || 0;
    st.totalResults = data.total_results || 0;
    (data.results || []).forEach((co) => {
      if (st.companies.has(co.siren)) return;
      st.companies.set(co.siren, co);
      co.etablissements.forEach((et) => {
        const seg = segOf(et.naf) || segOf(co.naf);
        const sc = scoreRow(co, et, seg);
        st.rows.push({ key: et.siret, co, et, seg, score: sc.score, parts: sc.parts });
      });
    });
  }

  async function loadPage(page) {
    if (!st.query || st.loading) return;
    const seq = st.seq;
    st.loading = true;
    st.abort = new AbortController();
    setBusy(true);
    try {
      const data = await fetchPage(page, st.abort.signal);
      if (seq !== st.seq) return; // superseded by a newer search
      st.page = page;
      ingest(data);
    } catch (e) {
      if (e.name !== "AbortError" && seq === st.seq) {
        $("#pros-msg").textContent = e.message;
        IFX.toast(e.message, true);
      }
    } finally {
      if (seq === st.seq) {
        st.loading = false;
        setBusy(false);
        renderResults();
      }
    }
  }

  async function loadAll() {
    if (!st.query || st.loading) return;
    const seq = st.seq;
    const last = Math.min(st.totalPages, MAX_PAGES);
    if (st.totalPages > MAX_PAGES) IFX.toast(`Limité aux ${MAX_PAGES * 25} premières entreprises : affine la zone ou les secteurs.`);
    st.loading = true;
    st.abort = new AbortController();
    setBusy(true);
    try {
      for (let p = st.page + 1; p <= last; p++) {
        const data = await fetchPage(p, st.abort.signal);
        if (seq !== st.seq) return;
        st.page = p;
        ingest(data);
        setProgress(p / last);
        if (p % 4 === 0) renderResults();
      }
    } catch (e) {
      if (e.name !== "AbortError" && seq === st.seq) IFX.toast(e.message, true);
    } finally {
      if (seq === st.seq) {
        st.loading = false;
        setBusy(false);
        renderResults();
      }
    }
  }

  function setBusy(b) {
    $("#pros-search").disabled = b;
    $("#pros-search").textContent = b ? "… CHARGEMENT" : "▶ RECHERCHER";
    $("#res-progress").classList.toggle("hidden", !b);
    if (!b) setProgress(0);
    else setProgress(0.15);
  }
  function setProgress(f) {
    $("#res-progress div").style.width = Math.round(f * 100) + "%";
  }

  // ------------------------------------------------------------------ results
  function visibleRows() {
    const hideClients = $("#f-hide-clients").checked;
    const hideSaved = $("#f-hide-saved").checked;
    const onlyNew = $("#f-new").checked;
    const noSiege = $("#f-no-siege").checked;
    const cats = new Set($$(".f-cat").filter((c) => c.checked).map((c) => c.value));
    const words = norm($("#f-text").value).split(/\s+/).filter(Boolean);
    return st.rows.filter((r) => {
      if (st.minSize && !(r.et.tranche && TR_MIN[r.et.tranche] >= st.minSize)) return false;
      if (hideClients && IFX.pipe.clientStatus(r.et.siret, r.co.siren) === "site") return false;
      if (hideSaved && IFX.pipe.has(r.et.siret)) return false;
      if (onlyNew && !(daysSince(r.et.date_creation) < NEW_SITE_DAYS)) return false;
      if (noSiege && division(r.et.naf) >= 58) return false;
      if (!cats.has(r.co.categorie || "")) return false;
      if (words.length) {
        const hay = norm([r.co.nom, r.co.sigle, r.et.enseignes.join(" "), r.et.nom_commercial, r.et.commune, r.et.code_postal].join(" "));
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }

  const SORTS = {
    score: (r) => r.score,
    nom: (r) => norm(r.co.nom),
    commune: (r) => norm(r.et.commune),
    site: (r) => (r.et.tranche ? TR_MIN[r.et.tranche] : -1),
    ca: (r) => r.co.ca || -1,
    creation: (r) => r.et.date_creation || "",
    secteur: (r) => (r.seg ? norm(r.seg.label) : "zzz"),
  };

  function sortedRows(rows) {
    const f = SORTS[st.sort.key] || SORTS.score;
    const d = st.sort.dir;
    return rows.slice().sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return (x < y ? -1 : x > y ? 1 : 0) * d;
    });
  }

  function badges(r) {
    const b = [];
    const cs = IFX.pipe.clientStatus(r.et.siret, r.co.siren);
    if (cs === "site") b.push(`<span class="badge ok">CLIENT</span>`);
    else if (cs === "groupe") b.push(`<span class="badge blue" title="Un autre site de cette entreprise est client">GROUPE CLIENT</span>`);
    if (IFX.pipe.has(r.et.siret)) b.push(`<span class="badge amber">${esc(IFX.pipe.statusLabel(IFX.pipe.get(r.et.siret).status))}</span>`);
    if (daysSince(r.et.date_creation) < NEW_SITE_DAYS) b.push(`<span class="badge warn">NOUVEAU SITE</span>`);
    if (r.et.est_siege) b.push(`<span class="badge">SIÈGE</span>`);
    return b.join("");
  }

  function renderResults() {
    const rows = sortedRows(visibleRows());
    const nCo = new Set(rows.map((r) => r.co.siren)).size;
    $("#res-title").textContent = st.query
      ? `RÉSULTATS · ${rows.length} sites · ${nCo} entreprises · page ${st.page}/${st.totalPages || 1} (${IFX.fmtInt(st.totalResults)} entreprises au total)`
      : "RÉSULTATS";
    $("#pros-more").disabled = st.loading || !st.query || st.page >= st.totalPages;
    $("#pros-all").disabled = st.loading || !st.query || st.page >= Math.min(st.totalPages, MAX_PAGES);
    $("#pros-csv").disabled = !rows.length;

    if (!st.query) return;
    if (!rows.length) {
      const hidden = st.rows.length - rows.length;
      $("#res-list").innerHTML = `<div class="empty"><p>Aucun site à afficher.</p><p class="muted">${
        hidden > 0 ? `${hidden} site(s) masqué(s) par les filtres (taille, clients, catégorie…).` : "Élargis la zone, ajoute des secteurs ou baisse la taille minimale."
      }${st.page < st.totalPages ? " D'autres pages sont disponibles." : ""}</p></div>`;
    } else {
      const th = (key, label, cls) => `<th data-sort="${key}" tabindex="0" class="${cls || ""} ${st.sort.key === key ? "sorted" + (st.sort.dir > 0 ? " asc" : "") : ""}">${label}</th>`;
      const shown = rows.slice(0, st.renderLimit);
      $("#res-list").innerHTML = `<table class="grid"><thead><tr>
        <th title="Suivre">★</th>${th("score", "Score")}${th("nom", "Établissement")}${th("secteur", "Secteur", "hide-sm")}${th("commune", "Commune")}
        ${th("site", "Effectif site")}${th("ca", "CA", "hide-sm")}${th("creation", "Créé", "hide-sm")}</tr></thead><tbody>
        ${shown
          .map((r) => {
            const name = r.et.enseignes[0] && norm(r.et.enseignes[0]) !== norm(r.co.nom) ? `${r.co.nom} · ${r.et.enseignes[0]}` : r.co.nom;
            return `<tr class="clickable" data-key="${esc(r.key)}">
            <td><button type="button" class="star ${IFX.pipe.has(r.et.siret) ? "on" : ""}" data-star="${esc(r.key)}" title="Ajouter à mes prospects">★</button></td>
            <td><span class="score" title="${esc(r.parts.map((p) => `${p[0]} : +${p[1]}`).join("\n"))}"><span class="bar"><i style="width:${r.score}%"></i></span>${r.score}</span></td>
            <td><a href="#" class="name" data-open-row="${esc(r.key)}">${esc(name)}</a>${badges(r)}<div class="sub">${esc(r.et.naf || "")} ${esc(nafLabel(r.et.naf).slice(0, 60))}</div></td>
            <td class="hide-sm">${r.seg ? esc(r.seg.label) : '<span class="muted">—</span>'}</td>
            <td>${esc(r.et.commune)}<div class="sub">${esc(r.et.code_postal)}</div></td>
            <td class="num">${esc(trLabel(r.et.tranche))}<div class="sub">ent. ${esc(trLabel(r.co.tranche))} ${esc(r.co.categorie || "")}</div></td>
            <td class="num hide-sm">${esc(IFX.fmtEur(r.co.ca))}</td>
            <td class="num hide-sm">${esc(IFX.fmtDate(r.et.date_creation).slice(-4))}</td></tr>`;
          })
          .join("")}</tbody></table>
        ${rows.length > shown.length ? `<div class="empty"><button type="button" class="btn" id="show-more-rows">Afficher ${Math.min(400, rows.length - shown.length)} lignes de plus (${rows.length - shown.length} restantes)</button></div>` : ""}`;
    }
    if (st.mode === "map") renderMarkers(rows);
  }

  function bindResults() {
    // Enter / Space on a sortable header acts like a click
    $("#res-list").addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("th[data-sort]")) {
        e.preventDefault();
        e.target.click();
      }
    });
    $("#res-list").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (th) {
        const k = th.dataset.sort;
        st.sort = st.sort.key === k ? { key: k, dir: -st.sort.dir } : { key: k, dir: k === "nom" || k === "commune" || k === "secteur" ? 1 : -1 };
        return renderResults();
      }
      if (e.target.id === "show-more-rows") {
        st.renderLimit += 400;
        return renderResults();
      }
      const star = e.target.closest("[data-star]");
      if (star) {
        e.stopPropagation();
        const r = st.rows.find((x) => x.key === star.dataset.star);
        if (!r) return;
        const saved = IFX.pipe.get(r.key);
        if (saved) {
          const hasFollowUp = saved.note || saved.next_date || saved.status !== "a_contacter";
          if (hasFollowUp && !confirm(`Retirer « ${saved.nom} » de tes prospects ? Statut, relance et notes seront perdus.`)) return;
          IFX.pipe.remove(r.key);
        } else IFX.pipe.add(r);
        return renderResults();
      }
      const link = e.target.closest("[data-open-row]");
      if (link) e.preventDefault();
      const tr = e.target.closest("tr[data-key]");
      if (tr) openRow(tr.dataset.key);
    });
  }

  // ------------------------------------------------------------------ detail sheet
  function openRow(key) {
    const r = st.rows.find((x) => x.key === key);
    if (r) openSheet(r);
  }

  function rowFromSaved(p) {
    // Rebuild a minimal row from a saved prospect (pipeline view)
    const et = { siret: p.siret, adresse: p.adresse, code_postal: p.code_postal, commune: p.commune, departement: p.departement, naf: p.naf, tranche: p.tranche, lat: p.lat, lon: p.lon, enseignes: p.enseigne ? [p.enseigne] : [], date_creation: p.date_creation, est_siege: false };
    const co = { siren: p.siren, nom: p.nom, naf: p.naf_entreprise || p.naf, tranche: p.tranche_entreprise, categorie: p.categorie, ca: p.ca, ca_annee: p.ca_annee, dirigeants: p.dirigeants || [], etablissements: [et] };
    const seg = SEGMENTS.find((s) => s.key === p.segment) || segOf(p.naf);
    const sc = scoreRow(co, et, seg);
    return { key: p.siret, co, et, seg, score: sc.score, parts: sc.parts, saved: true };
  }
  P.openSaved = (p) => openSheet(rowFromSaved(p));

  function openSheet(r) {
    const { co, et, seg } = r;
    const q = encodeURIComponent;
    const mapsUrl = et.lat !== null && et.lat !== undefined ? `https://www.google.com/maps/search/?api=1&query=${et.lat},${et.lon}` : `https://www.google.com/maps/search/?api=1&query=${q(`${co.nom} ${et.adresse}`)}`;
    const saved = IFX.pipe.get(et.siret);
    const cs = IFX.pipe.clientStatus(et.siret, co.siren);
    const prods = seg ? (seg.recommended_products || []) : [];
    const html = `
      <div><span class="score"><span class="bar"><i style="width:${r.score}%"></i></span><b>${r.score}/100</b></span>
        ${cs === "site" ? '<span class="badge ok">CLIENT</span>' : cs === "groupe" ? '<span class="badge blue">GROUPE CLIENT</span>' : ""}
        <ul class="tight small muted">${r.parts.filter((p) => p[1]).map((p) => `<li>${esc(p[0])} : +${p[1]}</li>`).join("")}</ul></div>

      <h3>SUIVI</h3>
      <div class="row">
        <select id="sh-status">${IFX.pipe.statusOptions(saved ? saved.status : "a_contacter")}</select>
        <input type="date" id="sh-date" value="${esc(saved ? saved.next_date || "" : "")}" title="Prochaine action" style="width:auto"/>
      </div>
      <textarea id="sh-note" rows="3" placeholder="Notes (contact, besoin, machines vues…)" style="margin-top:6px">${esc(saved ? saved.note || "" : "")}</textarea>
      <div class="row"><button type="button" class="btn primary" id="sh-save">${saved ? "Mettre à jour" : "★ Ajouter à mes prospects"}</button>
        ${saved ? '<button type="button" class="btn" id="sh-remove">Retirer</button>' : ""}</div>

      <h3>ÉTABLISSEMENT</h3>
      <dl class="kv">
        <dt>Adresse</dt><dd>${esc(et.adresse)}</dd>
        <dt>SIRET</dt><dd>${esc(et.siret)}${et.est_siege ? ' <span class="badge">SIÈGE</span>' : ""}</dd>
        <dt>Activité (NAF)</dt><dd>${esc(et.naf)} ${esc(nafLabel(et.naf))}</dd>
        <dt>Effectif du site</dt><dd>${esc(et.tranche ? (REF.tranches[et.tranche] || et.tranche) : "non communiqué")}${et.annee_tranche ? ` <span class="muted">(${esc(et.annee_tranche)})</span>` : ""}</dd>
        <dt>Créé le</dt><dd>${esc(IFX.fmtDate(et.date_creation))}</dd>
      </dl>

      <h3>ENTREPRISE</h3>
      <dl class="kv">
        <dt>Raison sociale</dt><dd>${esc(co.nom)}${co.sigle ? ` (${esc(co.sigle)})` : ""}</dd>
        <dt>SIREN</dt><dd>${esc(co.siren)}</dd>
        <dt>Catégorie</dt><dd>${esc(co.categorie || "n.c.")} · ${esc(co.tranche ? (REF.tranches[co.tranche] || co.tranche) : "effectif n.c.")}</dd>
        <dt>Activité</dt><dd>${esc(co.naf)} ${esc(nafLabel(co.naf))}</dd>
        ${co.nb_etab_ouverts !== undefined && co.nb_etab_ouverts !== null ? `<dt>Établissements</dt><dd>${esc(co.nb_etab_ouverts)} ouverts${co.siege_commune ? ` · siège à ${esc(co.siege_commune)}` : ""}</dd>` : ""}
        <dt>Chiffre d'affaires</dt><dd>${esc(IFX.fmtEur(co.ca))}${co.ca_annee ? ` <span class="muted">(${esc(co.ca_annee)})</span>` : ""}</dd>
      </dl>
      ${co.dirigeants && co.dirigeants.length ? `<h3>DIRIGEANTS (RNE)</h3><ul class="tight">${co.dirigeants.map((d) => `<li>${esc(d.nom)} <span class="muted">· ${esc(d.qualite)}</span></li>`).join("")}</ul>` : ""}

      ${seg ? `<h3>ANGLE INTERFLON · ${esc(seg.label.toUpperCase())}</h3>
        ${seg.pitch_fr ? `<p>${esc(seg.pitch_fr)}</p>` : ""}
        ${seg.typical_applications && seg.typical_applications.length ? `<div class="muted">Points de lubrification typiques :</div><ul class="tight">${seg.typical_applications.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
        ${prods.length ? `<div class="muted">Produits souvent proposés :</div><div class="links">${prods.map((n) => `<a href="#" data-product="${esc(n)}">${esc(n)}</a>`).join("")}</div>` : ""}
        ${seg.case_studies && seg.case_studies.length ? `<div class="muted" style="margin-top:6px">Cas clients :</div><ul class="tight">${seg.case_studies.map((c) => `<li><a href="${esc(IFX.safeUrl(c.url))}" target="_blank" rel="noopener">${esc(c.title)}</a>${c.result ? ` <span class="muted">— ${esc(c.result)}</span>` : ""}</li>`).join("")}</ul>` : ""}
        <div class="row"><button type="button" class="btn" id="sh-selector">Ouvrir le sélecteur pour ce secteur</button></div>` : ""}

      <h3>RECHERCHER</h3>
      <div class="links">
        <a href="https://annuaire-entreprises.data.gouv.fr/etablissement/${q(et.siret)}" target="_blank" rel="noopener">Annuaire des entreprises</a>
        <a href="${esc(mapsUrl)}" target="_blank" rel="noopener">Google Maps</a>
        <a href="https://www.linkedin.com/search/results/people/?keywords=${q(`maintenance ${co.nom}`)}" target="_blank" rel="noopener">LinkedIn : maintenance</a>
        <a href="https://www.google.com/search?q=${q(`"${co.nom}" ${et.commune} responsable maintenance`)}" target="_blank" rel="noopener">Google : resp. maintenance</a>
        <a href="https://www.google.com/search?q=${q(`"${co.nom}" ${et.commune}`)}" target="_blank" rel="noopener">Site web</a>
      </div>`;

    IFX.openDrawer(co.nom, html, (root) => {
      // capture this sheet's own fields: a pending autosave must not read the next sheet's ones
      const fS = $("#sh-status", root);
      const fD = $("#sh-date", root);
      const fN = $("#sh-note", root);
      const bSave = $("#sh-save", root);
      const follow = () => ({ status: fS.value, next_date: fD.value, note: fN.value });
      bSave.addEventListener("click", () => {
        IFX.pipe.add(r, follow());
        IFX.toast("Prospect enregistré");
        IFX.closeDrawer();
        renderResults();
      });
      // Any edit of the follow-up fields is saved at once, so closing the sheet never loses it
      let timer = null;
      const autosave = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const wasSaved = IFX.pipe.has(et.siret);
          IFX.pipe.add(r, follow());
          if (!wasSaved) {
            IFX.toast("Ajouté à mes prospects");
            bSave.textContent = "Mettre à jour";
          }
        }, 400);
      };
      fS.addEventListener("change", autosave);
      fD.addEventListener("change", autosave);
      fN.addEventListener("input", autosave);
      const rm = $("#sh-remove", root);
      if (rm)
        rm.addEventListener("click", () => {
          if (!confirm(`Retirer « ${co.nom} » de tes prospects ? Statut, relance et notes seront perdus.`)) return;
          clearTimeout(timer);
          IFX.pipe.remove(et.siret);
          IFX.closeDrawer();
          renderResults();
        });
      const sel = $("#sh-selector", root);
      if (sel)
        sel.addEventListener("click", () => {
          IFX.closeDrawer();
          IFX.sel.fromSegment(seg);
          IFX.go("sel");
        });
      root.onclick = (e) => {
        const a = e.target.closest("[data-product]");
        if (!a) return;
        e.preventDefault();
        IFX.sel.openProductByName(a.dataset.product);
      };
    });
  }

  // ------------------------------------------------------------------ map
  let map = null;
  let layer = null;
  let centerLayer = null;
  let picking = false;

  function ensureMap() {
    if (map || typeof L === "undefined") return map;
    map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([46.6, 2.4], 6);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    centerLayer = L.layerGroup().addTo(map);
    map.on("click", (e) => {
      if (!picking) return;
      setZone("autour");
      setCenter(e.latlng.lat, e.latlng.lng, "point choisi sur la carte");
    });
    map.on("popupopen", (e) => {
      const btn = e.popup.getElement().querySelector("[data-open]");
      if (btn) btn.addEventListener("click", () => openRow(btn.dataset.open));
    });
    drawCenter();
    return map;
  }

  function drawCenter() {
    if (!centerLayer || !st.center) return;
    centerLayer.clearLayers();
    L.circle([st.center.lat, st.center.lon], { radius: st.radius * 1000, color: "#4fb0ff", weight: 1, fillOpacity: 0.04 }).addTo(centerLayer);
    L.circleMarker([st.center.lat, st.center.lon], { radius: 4, color: "#4fb0ff", fillOpacity: 1 }).addTo(centerLayer);
  }

  function colorFor(score) {
    return score >= 70 ? "#ff8c00" : score >= 45 ? "#ffb84d" : "#8f8f8f";
  }

  function renderMarkers(rows) {
    if (!ensureMap()) return;
    layer.clearLayers();
    const pts = [];
    rows.forEach((r) => {
      if (r.et.lat === null || r.et.lat === undefined) return;
      const lb = r.et.tranche ? TR_MIN[r.et.tranche] : 0;
      const m = L.circleMarker([r.et.lat, r.et.lon], {
        radius: lb >= 250 ? 9 : lb >= 50 ? 7 : lb >= 10 ? 5 : 4,
        color: "#000",
        weight: 1,
        fillColor: colorFor(r.score),
        fillOpacity: 0.9,
      });
      m.bindPopup(`<b>${esc(r.co.nom)}</b><br>${esc(r.et.commune)} · ${esc(trLabel(r.et.tranche))}<br>${r.seg ? esc(r.seg.label) + "<br>" : ""}Score ${r.score}<br><button type="button" class="btn small" data-open="${esc(r.key)}">Fiche</button>`);
      m.addTo(layer);
      pts.push([r.et.lat, r.et.lon]);
    });
    if (st.needFit && pts.length) {
      map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
      st.needFit = false;
    } else if (st.needFit && st.center) map.setView([st.center.lat, st.center.lon], 10);
  }

  function setMode(mode) {
    if (mode !== "map") stopPicking();
    st.mode = mode;
    $$("#res-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("#res-list").classList.toggle("hidden", mode !== "list");
    $("#res-map").classList.toggle("hidden", mode !== "map");
    if (mode === "map") {
      ensureMap();
      setTimeout(() => {
        if (map) map.invalidateSize();
        renderMarkers(sortedRows(visibleRows()));
      }, 30);
    }
  }

  // ------------------------------------------------------------------ export
  function exportCsv() {
    const rows = sortedRows(visibleRows());
    const head = ["Score", "Raison sociale", "Enseigne", "SIRET", "SIREN", "Adresse", "Code postal", "Commune", "Département", "NAF site", "Activité site", "Secteur Interflon", "Effectif site", "Effectif entreprise", "Catégorie", "CA", "Année CA", "Créé le", "Siège", "Dirigeants", "Client", "Suivi", "Latitude", "Longitude"];
    const data = rows.map((r) => [
      r.score, r.co.nom, r.et.enseignes.join(" / "), r.et.siret, r.co.siren, r.et.adresse, r.et.code_postal, r.et.commune, r.et.departement || "",
      r.et.naf, nafLabel(r.et.naf), r.seg ? r.seg.label : "", r.et.tranche ? REF.tranches[r.et.tranche] || r.et.tranche : "",
      r.co.tranche ? REF.tranches[r.co.tranche] || r.co.tranche : "", r.co.categorie || "", r.co.ca ?? "", r.co.ca_annee || "",
      r.et.date_creation || "", r.et.est_siege ? "oui" : "non", (r.co.dirigeants || []).map((d) => `${d.nom} (${d.qualite})`).join(" / "),
      { site: "oui", groupe: "groupe" }[IFX.pipe.clientStatus(r.et.siret, r.co.siren)] || "",
      IFX.pipe.has(r.et.siret) ? IFX.pipe.statusLabel(IFX.pipe.get(r.et.siret).status) : "", r.et.lat ?? "", r.et.lon ?? "",
    ]);
    IFX.download(`prospection-${IFX.today()}.csv`, IFX.csv([head].concat(data)), "text/csv;charset=utf-8");
  }

  // ------------------------------------------------------------------ public API
  P.init = (ref, segments) => {
    REF = ref;
    SEGMENTS = segments;
    NAF2SEG = {};
    SEGMENTS.forEach((s) => s.naf_codes.forEach((c) => (NAF2SEG[c] = NAF2SEG[c] || s)));
    loadFilters();
    renderSegments();
    renderChips();
    setZone(st.zone);
    if (st.center) $("#center-label").textContent = `Centre : ${st.center.label} (${st.center.lat.toFixed(4)}, ${st.center.lon.toFixed(4)})`;
    bindFilters();
    bindResults();
  };

  // Command bar: PROS 29 35 viande lait
  // PROS 29 35 viande lait: the departments and sectors given REPLACE the current ones
  const FOOD_WORDS = ["agro", "agroalimentaire", "alimentaire", "iaa", "food"];
  const STOP_WORDS = ["de", "du", "des", "d", "la", "le", "les", "l", "et", "en", "a", "au", "aux"];
  P.command = (args) => {
    const deps = [];
    const segHits = [];
    const unknown = [];
    args.forEach((a) => {
      const A = a.toUpperCase();
      if (STOP_WORDS.includes(norm(a))) return;
      if (DEP_OK.test(A)) deps.push(A);
      else if (/^\d$/.test(A) && DEP_OK.test("0" + A)) deps.push("0" + A);
      else {
        const n = norm(a);
        const words = (s) => norm(s.key + " " + s.label).split(/[^a-z0-9]+/);
        let hits = FOOD_WORDS.includes(n) ? SEGMENTS.filter((s) => s.food) : n.length >= 3 ? SEGMENTS.filter((s) => words(s).includes(n)) : [];
        if (!hits.length && n.length >= 3) hits = SEGMENTS.filter((s) => words(s).some((w) => w.startsWith(n)));
        if (hits.length) hits.forEach((s) => segHits.push(s.key));
        else unknown.push(a);
      }
    });
    if (unknown.length) {
      IFX.toast(`Non reconnu : « ${unknown.join(" ")} ». Tape un n° de département ou un mot d'un secteur (ex. viande, bois, papier), ou coche les secteurs dans la liste.`, true);
      return;
    }
    if (deps.length) {
      st.deps = Array.from(new Set(deps));
      setZone("dep");
      renderChips();
    }
    if (segHits.length) {
      st.segs = new Set(segHits);
      st.customNaf = [];
      renderSegments();
      renderChips();
    }
    saveFilters();
    if ((deps.length || segHits.length) && selectedNaf().length && (st.deps.length || st.zone !== "dep")) search(true);
  };

  P.onShow = () => {
    if (st.mode === "map" && map) setTimeout(() => map.invalidateSize(), 30);
    renderResults();
  };
  P.refresh = renderResults;
  P.trLabel = trLabel;
  P.nafLabel = nafLabel;
  P.segments = () => SEGMENTS;
  P._scoreRow = scoreRow; // exposed for tests
})();
