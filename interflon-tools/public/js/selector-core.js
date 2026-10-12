/* Product selector — pure ranking logic (no DOM), testable with Node.
 *
 * rank(products, criteria) returns every product with:
 *   eligible  — false when a HARD constraint fails (food contact without the
 *               required NSF category, temperature range not covered, wrong
 *               application or product family)
 *   score     — soft relevance used to order eligible products
 *   reasons   — [{s: "y"|"n"|"u", t: text}]  y = OK, n = not OK, u = unknown / to check
 *
 * Unknown data never disqualifies a product: it is kept and flagged "à vérifier",
 * because the product sheet may simply be incomplete.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SelectorCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const APPLICATIONS = {
    chaines: "Chaînes",
    convoyeurs: "Convoyeurs",
    glissieres_guides: "Glissières / guides",
    engrenages_fermes: "Engrenages fermés / réducteurs",
    engrenages_ouverts: "Engrenages ouverts / crémaillères",
    roulements: "Roulements / paliers",
    cables: "Câbles",
    verins_pneumatique: "Vérins / pneumatique",
    hydraulique: "Hydraulique",
    compresseurs: "Compresseurs",
    filetages_montage: "Filetages / montage",
    mecanismes_articulations: "Mécanismes / articulations",
    moteurs_electriques: "Moteurs électriques",
    degrippage: "Dégrippage",
    protection_anticorrosion: "Protection anticorrosion",
    nettoyage_degraissage: "Nettoyage / dégraissage",
    demoulage: "Démoulage",
    contacts_electriques: "Contacts électriques",
    autre: "Autre",
  };

  // Close-enough applications: kept as eligible but flagged "voisine"
  const RELATED = {
    chaines: ["convoyeurs"],
    convoyeurs: ["chaines", "glissieres_guides"],
    glissieres_guides: ["convoyeurs", "mecanismes_articulations"],
    engrenages_ouverts: ["engrenages_fermes", "chaines"],
    engrenages_fermes: ["engrenages_ouverts"],
    mecanismes_articulations: ["glissieres_guides", "cables"],
    cables: ["mecanismes_articulations", "chaines"],
    verins_pneumatique: ["mecanismes_articulations"],
    degrippage: ["filetages_montage"],
    filetages_montage: ["degrippage"],
  };

  const PROPERTIES = {
    film_sec: "Film sec (n'attire pas la poussière)",
    resistant_eau: "Résiste à l'eau",
    lavage_frequent: "Lavages fréquents",
    anti_corrosion: "Anticorrosion",
    penetrant: "Pénétrant",
    haute_temperature: "Haute température",
    basse_temperature: "Basse température",
    environnement_poussiereux: "Environnement poussiéreux",
    charges_elevees_chocs: "Charges élevées / chocs",
    vitesse_elevee: "Vitesse élevée",
    synthetique: "Synthétique",
    biodegradable: "Biodégradable",
    sans_pfas: "Sans PFAS",
    contient_ptfe: "Contient du PTFE",
    faible_odeur: "Faible odeur",
    sans_silicone: "Sans silicone",
    compatible_plastiques_joints: "Compatible plastiques / joints",
  };

  // A requested environment condition is satisfied by any of these product properties
  const ENV_MATCH = {
    resistant_eau: ["resistant_eau", "lavage_frequent"],
    lavage_frequent: ["lavage_frequent", "resistant_eau"],
    environnement_poussiereux: ["environnement_poussiereux", "film_sec"],
    charges_elevees_chocs: ["charges_elevees_chocs"],
    vitesse_elevee: ["vitesse_elevee"],
    anti_corrosion: ["anti_corrosion"],
    compatible_plastiques_joints: ["compatible_plastiques_joints"],
    biodegradable: ["biodegradable"],
    sans_pfas: ["sans_pfas"],
    faible_odeur: ["faible_odeur"],
    sans_silicone: ["sans_silicone"],
    penetrant: ["penetrant"],
    film_sec: ["film_sec"],
  };

  const FORMATS = {
    aerosol: "Aérosol",
    liquide: "Liquide (< 5 L)",
    vrac: "Bidon / fût (≥ 5 L)",
    graisse: "Cartouche / pot de graisse",
    automatique: "Graisseur automatique",
  };

  // Free-text packaging -> format categories
  function formatKinds(formats) {
    const kinds = new Set();
    (formats || []).forEach((f) => {
      // "1 000 L" -> "1000 L" (French thousands separators)
      const s = String(f).toLowerCase().replace(/(\d)[\s\u00a0\u202f.](?=\d{3}\b)/g, "$1");
      if (/a[ée]rosol|spray|bombe/.test(s)) {
        kinds.add("aerosol");
        return;
      }
      if (/cartouche|tube|pot|\bkg\b|\d\s*g\b/.test(s)) kinds.add("graisse");
      else if (/lubrificateur|automatique|single point|dispenser|ampoule/.test(s)) {
        kinds.add("automatique");
        return;
      }
      const m = s.match(/(\d+(?:[.,]\d+)?)\s*(ml|l|litres?)\b/);
      if (m) {
        let litres = parseFloat(m[1].replace(",", "."));
        if (m[2] === "ml") litres /= 1000;
        kinds.add(litres >= 5 ? "vrac" : "liquide");
      } else if (/f[uû]t|bidon|vrac|ibc|container|seau/.test(s)) kinds.add("vrac");
    });
    return kinds;
  }

  // "H1", "NSF 3H, H1", "K1/K3"… -> ["H1"], ["3H","H1"], ["K1","K3"].
  // Fails closed: any token that is not a known NSF category (e.g. "Non H1",
  // "H1 (en cours)") makes the whole mention unreadable -> null.
  const NSF_TOKEN = /^(H1|H2|H3|3H|HT1|A\d|C\d|K\d|P1|M1|R\d|N\d)$/;
  function nsfParse(p) {
    const raw = String((p && p.nsf) || "").toUpperCase().trim();
    if (!raw) return [];
    const toks = raw.split(/[\s,;/+]+/).filter(Boolean).filter((t, i) => !(i === 0 && t === "NSF"));
    return toks.length && toks.every((t) => NSF_TOKEN.test(t)) ? toks : null;
  }
  const nsfList = (p) => nsfParse(p) || [];

  // Categories accepted per use when food contact is possible. Cleaners: A1
  // (general cleaner in and around food processing areas) and A7 (listed for
  // the food processing industry) only; K1/K3/C1 are not accepted without a
  // check by the technical department. Release agents: 3H (direct contact) or H1.
  const FOOD_OK = {
    nettoyage_degraissage: ["H1", "A1", "A7"],
    demoulage: ["3H", "H1"],
  };
  const FOOD_REASON = {
    H1: "NSF H1 (contact alimentaire fortuit)",
    "3H": "NSF 3H (agent de démoulage, contact direct)",
    A1: "NSF A1 (nettoyant pour zones alimentaires, rinçage selon fiche)",
    A7: "NSF A7 (nettoyant pour l'industrie alimentaire, selon fiche)",
  };
  function foodMatch(product, application) {
    const l = nsfParse(product);
    if (!l) return null;
    return (FOOD_OK[application] || ["H1"]).find((x) => l.includes(x)) || null;
  }
  const foodOk = (product, application) => !!foodMatch(product, application);

  // uncertain_fields entries look like "nsf", "temp_max_c (source unique)"…
  const unsure = (p, re) => (p.uncertain_fields || []).some((f) => re.test(String(f)));
  const NSF_UNSURE = /^nsf\b(?!_)/i;
  const TEMP_UNSURE = /^temp_(min|max)/i;

  // Requirements the customer states as mandatory ("exigé"): hard constraints
  const REQUIRED_ENV = {
    biodegradable: (props) => props.includes("biodegradable"),
    sans_pfas: (props) => props.includes("sans_pfas") && !props.includes("contient_ptfe"),
  };

  const num = (x) => (x === null || x === undefined || x === "" || isNaN(+x) ? null : +x);
  const fmtT = (x) => (x === null ? "?" : `${x > 0 ? "+" : ""}${x} °C`);

  function evaluate(p, c) {
    c = c || {};
    const reasons = [];
    const blockers = [];
    let score = 0;
    const apps = p.applications || [];
    const props = p.properties || [];

    // 1. Food contact — hard constraint when contact is possible (fails closed)
    if (c.food === "oui" || c.food === "nsp") {
      const parsed = nsfParse(p);
      const match = foodMatch(p, c.application);
      const doubt = match && unsure(p, NSF_UNSURE);
      if (match) {
        score += doubt ? 10 : c.food === "oui" ? 30 : 15;
        reasons.push(doubt ? { s: "u", t: `${FOOD_REASON[match]} : homologation à confirmer (NSF White Book)` } : { s: "y", t: FOOD_REASON[match] });
      } else {
        const why = parsed === null ? `Mention NSF illisible « ${p.nsf} » : à vérifier` : p.nsf ? `NSF ${p.nsf} : non adapté au contact alimentaire` : "Pas d'homologation NSF H1";
        if (c.food === "oui") blockers.push(why);
        else reasons.push({ s: "u", t: `${why} : vérifier l'absence de contact alimentaire` });
      }
    }

    // 2. Application — hard when the product sheet lists its applications
    if (c.application) {
      const label = APPLICATIONS[c.application] || c.application;
      if (!apps.length) {
        reasons.push({ s: "u", t: `Applications non renseignées : vérifier pour « ${label} »` });
      } else if (apps.includes(c.application)) {
        score += 40;
        reasons.push({ s: "y", t: `Prévu pour : ${label}` });
      } else {
        const near = (RELATED[c.application] || []).filter((a) => apps.includes(a));
        if (near.length) {
          score += 15;
          reasons.push({ s: "u", t: `Application voisine (${near.map((a) => APPLICATIONS[a] || a).join(", ")}) : à valider` });
        } else blockers.push(`Non prévu pour : ${label}`);
      }
    }

    // 3. Product family (replacement mode: oil vs grease…)
    if (c.families && c.families.length) {
      if (!p.family) reasons.push({ s: "u", t: "Famille non renseignée" });
      else if (c.families.includes(p.family)) score += 10;
      else blockers.push(`Famille « ${p.family} » ≠ ${c.families.join(" / ")}`);
    }

    // 4. Temperature — hard constraint on known limits
    const tmin = num(c.tmin);
    const tmax = num(c.tmax);
    const pmin = num(p.temp_min_c);
    const pmax = num(p.temp_max_c);
    if (tmin !== null || tmax !== null) {
      const need = `${fmtT(tmin)} → ${fmtT(tmax)}`;
      let unknown = false;
      if (tmin !== null) {
        if (pmin === null) unknown = true;
        else if (pmin > tmin) blockers.push(`Mini produit ${fmtT(pmin)} > besoin ${fmtT(tmin)}`);
      }
      if (tmax !== null) {
        if (pmax === null) unknown = true;
        else if (pmax < tmax) blockers.push(`Maxi produit ${fmtT(pmax)} < besoin ${fmtT(tmax)}`);
      }
      const failed = blockers.some((b) => b.startsWith("Mini produit") || b.startsWith("Maxi produit"));
      if (!failed) {
        if (unknown) reasons.push({ s: "u", t: `Plage de température à vérifier (besoin ${need})` });
        else if (unsure(p, TEMP_UNSURE)) {
          score += 8;
          reasons.push({ s: "u", t: `Plage ${fmtT(pmin)} → ${fmtT(pmax)} couvrirait ${need} : donnée à confirmer` });
        } else {
          score += 20;
          reasons.push({ s: "y", t: `Plage ${fmtT(pmin)} → ${fmtT(pmax)} couvre ${need}` });
        }
      }
    }

    // 5. Environment — soft, except explicit requirements (biodegradable, PFAS-free)
    (c.env || []).forEach((e) => {
      const label = PROPERTIES[e] || e;
      if (REQUIRED_ENV[e]) {
        if (REQUIRED_ENV[e](props)) {
          score += 8;
          reasons.push({ s: "y", t: label });
        } else if (!props.length) reasons.push({ s: "u", t: `${label} : non renseigné, à vérifier` });
        else blockers.push(`${label} : exigé, non revendiqué`);
        return;
      }
      const ok = (ENV_MATCH[e] || [e]).some((x) => props.includes(x));
      if (ok) {
        score += 8;
        reasons.push({ s: "y", t: label });
      } else reasons.push({ s: "n", t: `${label} : non revendiqué` });
    });

    // 6. Packaging — soft
    if (c.formats && c.formats.length) {
      const kinds = formatKinds(p.formats);
      c.formats.forEach((f) => {
        if (kinds.has(f)) {
          score += 6;
          reasons.push({ s: "y", t: `Existe en ${(FORMATS[f] || f).toLowerCase()}` });
        } else if (!(p.formats || []).length) reasons.push({ s: "u", t: "Conditionnements non renseignés" });
        else reasons.push({ s: "n", t: `Pas de format ${(FORMATS[f] || f).toLowerCase()} référencé` });
      });
    }

    // 7. Viscosity / consistency of the product being replaced — soft
    const vg = (x) => String(x || "").replace(/[^0-9]/g, "");
    if (c.iso_vg) {
      if (!p.viscosity_iso_vg) reasons.push({ s: "u", t: "Viscosité ISO VG non renseignée" });
      else if (vg(p.viscosity_iso_vg) === vg(c.iso_vg)) {
        score += 15;
        reasons.push({ s: "y", t: `Même viscosité ISO VG ${vg(c.iso_vg)}` });
      } else reasons.push({ s: "n", t: `ISO VG ${p.viscosity_iso_vg} (actuel : ${c.iso_vg})` });
    }
    if (c.nlgi) {
      if (!p.nlgi) reasons.push({ s: "u", t: "Grade NLGI non renseigné" });
      else if (String(p.nlgi).replace(/\s/g, "") === String(c.nlgi).replace(/\s/g, "")) {
        score += 10;
        reasons.push({ s: "y", t: `Même grade NLGI ${c.nlgi}` });
      } else reasons.push({ s: "n", t: `NLGI ${p.nlgi} (actuel : ${c.nlgi})` });
    }

    // 8. Data quality nudges ordering only
    score += p.confidence === "high" ? 4 : p.confidence === "medium" ? 2 : 0;

    blockers.forEach((b) => reasons.unshift({ s: "n", t: b }));
    return { eligible: blockers.length === 0, score, reasons, blockers };
  }

  function matchesQuery(p, q) {
    if (!q) return true;
    const n = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const hay = n(
      [p.name, p.family, p.range, p.description_fr, p.nsf, (p.applications || []).map((a) => APPLICATIONS[a] || a).join(" "),
        (p.industries || []).join(" "), (p.key_claims || []).join(" ")].join(" ")
    );
    return n(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function rank(products, criteria) {
    return (products || [])
      .filter((p) => matchesQuery(p, criteria && criteria.query))
      .map((p) => Object.assign({ product: p }, evaluate(p, criteria)))
      .sort((a, b) => (b.eligible - a.eligible) || (b.score - a.score) || String(a.product.name).localeCompare(String(b.product.name)));
  }

  // "Replace the customer's current product" presets -> criteria
  const REPLACE_TYPES = {
    huile_chaine: { label: "Huile pour chaînes", application: "chaines", families: ["huile", "aerosol"] },
    graisse: { label: "Graisse (roulements, paliers)", application: "roulements", families: ["graisse"] },
    spray_ptfe: { label: "Spray sec / PTFE", env: ["film_sec"], families: ["aerosol", "huile"] },
    degrippant: { label: "Dégrippant / multifonction", application: "degrippage" },
    huile_engrenages: { label: "Huile pour engrenages / réducteurs", application: "engrenages_fermes", families: ["huile"] },
    huile_hydraulique: { label: "Huile hydraulique", application: "hydraulique", families: ["huile"] },
    huile_compresseur: { label: "Huile pour compresseurs", application: "compresseurs", families: ["huile"] },
    huile_pneumatique: { label: "Huile pneumatique / vérins", application: "verins_pneumatique" },
    nettoyant: { label: "Nettoyant / dégraissant", application: "nettoyage_degraissage" },
    demoulant: { label: "Agent de démoulage", application: "demoulage" },
  };

  return { APPLICATIONS, PROPERTIES, FORMATS, ENV_MATCH, RELATED, REPLACE_TYPES, REQUIRED_ENV, NSF_UNSURE, TEMP_UNSURE, nsfList, nsfParse, formatKinds, foodOk, foodMatch, unsure, evaluate, rank, matchesQuery };
});
