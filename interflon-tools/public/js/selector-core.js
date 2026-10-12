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
    liquide: "Liquide (≤ 1 L)",
    vrac: "Bidon / fût (≥ 5 L)",
    graisse: "Cartouche / pot de graisse",
    automatique: "Graisseur automatique",
  };

  // Free-text packaging -> format categories
  function formatKinds(formats) {
    const kinds = new Set();
    (formats || []).forEach((f) => {
      const s = String(f).toLowerCase();
      if (/a[ée]rosol|spray|bombe/.test(s)) {
        kinds.add("aerosol");
        return;
      }
      if (/lubrificateur|graisseur|automatique|dispenser|ampoule/.test(s)) {
        kinds.add("automatique");
        return;
      }
      if (/cartouche|tube|pot|\bkg\b|\d\s*g\b/.test(s)) kinds.add("graisse");
      const m = s.match(/(\d+(?:[.,]\d+)?)\s*(ml|l|litres?)\b/);
      if (m) {
        let litres = parseFloat(m[1].replace(",", "."));
        if (m[2] === "ml") litres /= 1000;
        kinds.add(litres >= 5 ? "vrac" : "liquide");
      } else if (/f[uû]t|bidon|vrac|ibc|container|seau/.test(s)) kinds.add("vrac");
    });
    return kinds;
  }

  // "H1", "3H, H1", "K1/K3"… -> ["H1"], ["3H","H1"], ["K1","K3"]
  const nsfList = (p) =>
    String((p && p.nsf) || "")
      .toUpperCase()
      .split(/[\s,;/+]+/)
      .filter(Boolean);

  // Release agents for food may be 3H; cleaners carry A/C/K categories.
  function foodOk(product, application) {
    const l = nsfList(product);
    if (!l.length) return false;
    if (application === "nettoyage_degraissage") return l.some((x) => /^(A\d|C\d|K\d|H1)$/.test(x));
    if (application === "demoulage") return l.some((x) => x === "3H" || x === "H1");
    return l.includes("H1");
  }

  const num = (x) => (x === null || x === undefined || x === "" || isNaN(+x) ? null : +x);
  const fmtT = (x) => (x === null ? "?" : `${x > 0 ? "+" : ""}${x} °C`);

  function evaluate(p, c) {
    c = c || {};
    const reasons = [];
    const blockers = [];
    let score = 0;
    const apps = p.applications || [];
    const props = p.properties || [];

    // 1. Food contact — hard constraint when contact is possible
    if (c.food === "oui") {
      if (foodOk(p, c.application)) {
        score += 30;
        reasons.push({ s: "y", t: `NSF ${p.nsf} (contact alimentaire fortuit)` });
      } else {
        blockers.push(p.nsf ? `NSF ${p.nsf} : pas adapté au contact alimentaire fortuit` : "Pas d'homologation NSF H1");
      }
    } else if (c.food === "nsp") {
      if (foodOk(p, c.application)) {
        score += 15;
        reasons.push({ s: "y", t: `NSF ${p.nsf} : sûr en cas de contact alimentaire` });
      } else reasons.push({ s: "u", t: "Pas NSF H1 : vérifier l'absence de contact alimentaire" });
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
        else {
          score += 20;
          reasons.push({ s: "y", t: `Plage ${fmtT(pmin)} → ${fmtT(pmax)} couvre ${need}` });
        }
      }
    }

    // 5. Environment — soft
    (c.env || []).forEach((e) => {
      const ok = (ENV_MATCH[e] || [e]).some((x) => props.includes(x));
      const label = PROPERTIES[e] || e;
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
          reasons.push({ s: "y", t: `Existe en ${FORMATS[f].toLowerCase()}` });
        } else if (!(p.formats || []).length) reasons.push({ s: "u", t: "Conditionnements non renseignés" });
        else reasons.push({ s: "n", t: `Pas de format ${FORMATS[f].toLowerCase()} référencé` });
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

  return { APPLICATIONS, PROPERTIES, FORMATS, ENV_MATCH, RELATED, REPLACE_TYPES, nsfList, formatKinds, foodOk, evaluate, rank, matchesQuery };
});
