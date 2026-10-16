/* Company and place data, fetched straight from the browser (both services
 * allow cross-origin calls), so the local server only has to serve files.
 *   /api/entreprises  -> Recherche d'entreprises /search      (zone = departements or region)
 *   /api/autour       -> Recherche d'entreprises /near_point  (radius around a point, 50 km max)
 *   /api/geocode      -> Geoplateforme IGN, api-adresse.data.gouv.fr as fallback
 * Results are normalised to the shape prospect.js reads (company + its matching sites). */
(function () {
  "use strict";
  const IFX = window.IFX;

  const ENTREPRISES = "https://recherche-entreprises.api.gouv.fr";
  const GEOCODERS = ["https://data.geopf.fr/geocodage/search", "https://api-adresse.data.gouv.fr/search/"];
  const MAX_SITES = 100; // sites returned per company (API default is 10)

  const list = (v) => (Array.isArray(v) ? v.join(",") : v);
  const num = (x) => {
    const n = parseFloat(x);
    return isFinite(n) ? n : null;
  };

  async function getJson(url, signal) {
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Connexion impossible : vérifie ta connexion internet, puis relance.");
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const msg = (body && (body.erreur || body.error || body.message)) || `Erreur HTTP ${res.status}`;
      const err = new Error(res.status === 429 ? "Trop de requêtes vers l'API : nouvel essai dans quelques secondes." : `API Recherche d'entreprises : ${msg}`);
      err.status = res.status;
      err.retryAfter = num(res.headers.get("Retry-After")) || 2;
      throw err;
    }
    return body;
  }

  function query(base, params) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      v = list(v);
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    return `${base}?${qs.toString()}`;
  }

  // INSEE commune code -> departement ("29232" -> "29", "2A004" -> "2A", "97105" -> "971")
  function departementOf(commune, codePostal) {
    const c = String(commune || codePostal || "");
    return c.startsWith("97") ? c.slice(0, 3) : c.slice(0, 2);
  }

  function lastTurnover(finances) {
    const years = Object.keys(finances || {}).sort().reverse();
    for (const y of years) {
      const ca = num(finances[y] && finances[y].ca);
      if (ca !== null) return { ca, annee: y };
    }
    return { ca: null, annee: "" };
  }

  // Decision makers first, auditors dropped: they are not prospecting contacts
  const KEY_ROLE = /pr[ée]sident|directeur|g[ée]rant|dirigeant/i;
  const firstName = (p) => String(p || "").split(/\s+/)[0].toLowerCase().replace(/(^|[-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  function dirigeants(arr) {
    return (arr || [])
      .filter((d) => d && !/commissaire aux comptes/i.test(d.qualite || ""))
      .map((d) => ({
        nom: d.type_dirigeant === "personne morale" ? String(d.denomination || "") : `${firstName(d.prenoms)} ${d.nom || ""}`.trim(),
        qualite: String(d.qualite || ""),
        key: KEY_ROLE.test(d.qualite || ""),
      }))
      .filter((d) => d.nom)
      .sort((a, b) => b.key - a.key)
      .slice(0, 8)
      .map(({ nom, qualite }) => ({ nom, qualite }));
  }

  function site(e) {
    return {
      siret: String(e.siret || ""),
      adresse: e.adresse || "",
      code_postal: e.code_postal || "",
      commune: e.libelle_commune || "",
      departement: departementOf(e.commune, e.code_postal),
      naf: e.activite_principale || "",
      tranche: e.tranche_effectif_salarie || null,
      annee_tranche: e.annee_tranche_effectif_salarie || "",
      lat: num(e.latitude),
      lon: num(e.longitude),
      enseignes: Array.isArray(e.liste_enseignes) ? e.liste_enseignes : [],
      nom_commercial: e.nom_commercial || "",
      date_creation: e.date_creation || "",
      est_siege: !!e.est_siege,
    };
  }

  function company(r) {
    const fin = lastTurnover(r.finances);
    return {
      siren: String(r.siren || ""),
      nom: r.nom_complet || r.nom_raison_sociale || "",
      sigle: r.sigle || "",
      naf: r.activite_principale || "",
      tranche: r.tranche_effectif_salarie || null,
      categorie: r.categorie_entreprise || "",
      ca: fin.ca,
      ca_annee: fin.annee,
      dirigeants: dirigeants(r.dirigeants),
      nb_etab_ouverts: r.nombre_etablissements_ouverts,
      siege_commune: (r.siege && r.siege.libelle_commune) || "",
      // closed sites still match the search: keep only open ones with a SIRET
      etablissements: (r.matching_etablissements || []).filter((e) => e && e.siret && e.etat_administratif !== "F").map(site),
    };
  }

  function normalise(data) {
    return {
      total_pages: data.total_pages || 0,
      total_results: data.total_results || 0,
      results: (data.results || []).map(company).filter((c) => c.siren && c.etablissements.length),
    };
  }

  const page = (p) => ({ page: p.page || 1, per_page: p.per_page || 25, limite_matching_etablissements: MAX_SITES });

  IFX.sources = {
    "/api/entreprises": async (p, signal) =>
      normalise(
        await getJson(
          query(`${ENTREPRISES}/search`, Object.assign(
            { activite_principale: p.naf, departement: p.departement, region: p.region, tranche_effectif_salarie: p.tranche, etat_administratif: "A" },
            page(p)
          )),
          signal
        )
      ),

    "/api/autour": async (p, signal) =>
      normalise(
        await getJson(
          query(`${ENTREPRISES}/near_point`, Object.assign(
            { activite_principale: p.naf, lat: p.lat, long: p.lon, radius: Math.min(50, +p.radius || 20), etat_administratif: "A" },
            page(p)
          )),
          signal
        )
      ),

    "/api/geocode": async (p, signal) => {
      let lastErr;
      for (const base of GEOCODERS) {
        try {
          const data = await getJson(query(base, { q: p.q, type: "municipality", limit: 8, index: base.includes("geopf") ? "address" : "" }), signal);
          return {
            results: (data.features || []).map((f) => ({
              label: f.properties.label || f.properties.city || "",
              postcode: f.properties.postcode || "",
              context: f.properties.context || "",
              lat: f.geometry.coordinates[1],
              lon: f.geometry.coordinates[0],
            })),
          };
        } catch (e) {
          if (e.name === "AbortError") throw e;
          lastErr = e;
        }
      }
      throw lastErr;
    },
  };

  IFX._normalise = normalise; // exposed for tests
})();
