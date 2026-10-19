/* Product selector — pure ranking logic (no DOM), testable with Node.
 *
 * rank(products, criteria) returns every product with:
 *   eligible  — false when a HARD constraint fails (food contact without the
 *               required NSF category, temperature range not covered, wrong
 *               application or product family)
 *   verified  — eligible and every hard criterion checked on sourced data
 *   group     — "main" (made for the requested organ, or no organ asked),
 *               "related" (made for a neighbouring organ), "additive" (MicPol
 *               additive added to the oil in place, not a lubricant on its own)
 *   score     — soft relevance used to order eligible products
 *   tie       — same rank as a neighbour on every criterion (only the name differs)
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
  const PFAS_UNSURE = /pfas/i;

  // "Fiche vérifiée": NSF and temperature confirmed by an Interflon source.
  // Cleaners have no operating range to confirm, so only their NSF counts.
  const CLEANERS = ["nettoyant", "degraissant"];
  const isVerified = (p) => p.confidence === "high" && !unsure(p, NSF_UNSURE) && (CLEANERS.includes(p.family) || !unsure(p, TEMP_UNSURE));

  // Temperature on its own, so a sheet that only lacks its packaging still shows a
  // verified range: "ok" (both limits quoted from a source), "doubt", "missing", "na".
  const hasEvidence = (p, field) => (p.evidence || []).some((e) => e && e.field === field);
  function tempStatus(p) {
    if (p.temp_na) return "na";
    if (p.temp_min_c === null || p.temp_min_c === undefined || p.temp_max_c === null || p.temp_max_c === undefined) return "missing";
    if (unsure(p, TEMP_UNSURE) || !hasEvidence(p, "temp_min_c") || !hasEvidence(p, "temp_max_c")) return "doubt";
    return "ok";
  }

  // What keeps a sheet from "fiche vérifiée", in plain words:
  // [{label, missing}] — missing = no value at all, otherwise a value to confirm.
  const GAP_LABEL = { formats: "conditionnements", nsf: "NSF", nsf_reg_no: "n° NSF", temp_min_c: "température", temp_max_c: "température",
    viscosity_iso_vg: "viscosité", nlgi: "grade NLGI", applications: "applications", properties: "propriétés", base: "huile de base" };
  const EMPTY = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  function gaps(p) {
    const out = [];
    (p.uncertain_fields || []).forEach((f) => {
      const key = (String(f).match(/^[a-z_]+/) || [""])[0];
      const label = PFAS_UNSURE.test(String(f)) ? "sans PFAS" : GAP_LABEL[key] || key;
      const value = key === "viscosity_iso_vg" ? p.viscosity_iso_vg || p.viscosity_cst40 : p[key];
      const missing = !PFAS_UNSURE.test(String(f)) && EMPTY(value);
      if (label && !out.some((g) => g.label === label)) out.push({ label, missing });
    });
    return out;
  }
  // "conditionnements à compléter", "sans PFAS à confirmer", "NLGI, viscosité à compléter"…
  function gapsText(p) {
    const g = gaps(p);
    const part = (list, verb) => (list.length ? `${list.map((x) => x.label).join(", ")} ${verb}` : "");
    return [part(g.filter((x) => x.missing), "à compléter"), part(g.filter((x) => !x.missing), "à confirmer")].filter(Boolean).join(" · ");
  }

  // Requirements the customer states as mandatory ("exigé"): hard constraints
  const REQUIRED_ENV = {
    biodegradable: (props) => props.includes("biodegradable"),
    sans_pfas: (props) => props.includes("sans_pfas") && !props.includes("contient_ptfe"),
  };

  const num = (x) => (x === null || x === undefined || x === "" || isNaN(+x) ? null : +x);
  const fmtT = (x) => (x === null ? "?" : `${x > 0 ? "+" : ""}${x} °C`);

  // MicPol additives (Finnoly Additive, Fin Gear Additive…): dosed into the customer's
  // own oil, so they complement a lubricant and never stand in for one
  const isAdditive = (p) => p.family === "autre" && /\badditive\b/i.test(String(p.name || ""));

  // ISO 3448 viscosity grades and NLGI consistency classes, in order, to score "close" grades
  const VG_GRADES = [2, 3, 5, 7, 10, 15, 22, 32, 46, 68, 100, 150, 220, 320, 460, 680, 1000, 1500];
  const vgStep = (v) => {
    if (!(v > 0)) return null;
    let best = 0;
    VG_GRADES.forEach((g, i) => { if (Math.abs(Math.log(g / v)) < Math.abs(Math.log(VG_GRADES[best] / v))) best = i; });
    return best;
  };
  const NLGI_CLASSES = ["000", "00", "0", "1", "2", "3", "4", "5", "6"];
  // "2", "NLGI 1/2", "2-3" -> class index (half classes for "1/2"), null when unreadable
  function nlgiIndex(x) {
    const parts = String(x || "").toUpperCase().replace(/NLGI|\s/g, "").split(/[/-]/).filter(Boolean);
    const idx = parts.map((t) => NLGI_CLASSES.indexOf(t));
    return idx.length && idx.every((i) => i >= 0) ? idx.reduce((a, b) => a + b, 0) / idx.length : null;
  }

  // Usual product family per organ, at equal suitability: an oil for chains and
  // conveyors, a grease for bearings, electric motors and open gears (sprays in between).
  // A soft preference: stated conditions and the temperature still decide.
  const CHAIN_FIT = { huile: 6, aerosol: 3 };
  const GREASE_FIT = { graisse: 6, aerosol: 3 };
  const FAMILY_FIT = { chaines: CHAIN_FIT, convoyeurs: CHAIN_FIT, roulements: GREASE_FIT, moteurs_electriques: GREASE_FIT, engrenages_ouverts: GREASE_FIT };

  // Temperature needs that call for a product claiming the matching property
  const HOT_NEED_C = 150;
  const COLD_NEED_C = -15;

  function evaluate(p, c) {
    c = c || {};
    const reasons = [];
    const blockers = [];
    // hard criteria that missing data kept from checking: the product may suit, not proven
    const unchecked = [];
    let score = 0;
    const apps = p.applications || [];
    const props = p.properties || [];
    const additive = isAdditive(p);
    let group = additive ? "additive" : "main";
    let primary = false;

    // 1. Food contact — hard constraint when contact is possible (fails closed)
    if (c.food === "non" && nsfList(p).includes("H1")) score -= 5; // no food contact: the industrial equivalent first
    if (c.food === "oui" || c.food === "nsp") {
      const parsed = nsfParse(p);
      const match = foodMatch(p, c.application);
      const doubt = match && unsure(p, NSF_UNSURE);
      if (match) {
        if (doubt) unchecked.push("homologation NSF");
        score += doubt ? 10 : c.food === "oui" ? 30 : 15;
        reasons.push(doubt ? { s: "u", t: `${FOOD_REASON[match]} : homologation à confirmer (NSF White Book)` } : { s: "y", t: FOOD_REASON[match] });
      } else {
        const why = parsed === null ? `Mention NSF illisible « ${p.nsf} » : à vérifier` : p.nsf ? `NSF ${p.nsf} : non adapté au contact alimentaire` : "Pas d'homologation NSF H1";
        if (c.food === "oui") blockers.push(why);
        // "a" = attention for the rep (customer situation unknown), not a data doubt
        else reasons.push({ s: "a", t: `${why} : vérifier l'absence de contact alimentaire chez le client` });
      }
    }

    // 2. Application — hard when the product sheet lists its applications
    if (c.application) {
      const label = APPLICATIONS[c.application] || c.application;
      if (!apps.length) {
        unchecked.push("application");
        reasons.push({ s: "u", t: `Applications non renseignées : vérifier pour « ${label} »` });
      } else if (apps.includes(c.application)) {
        // main use named by the product's own source ("developed for…") beats a use it merely lists
        primary = (p.primary_applications || []).includes(c.application);
        score += primary ? 52 : 40;
        reasons.push({ s: "y", t: primary ? `Conçu pour : ${label}` : `Prévu pour : ${label}` });
      } else {
        const near = (RELATED[c.application] || []).filter((a) => apps.includes(a));
        if (near.length) {
          score += 15;
          if (!additive) group = "related";
          // "r" = related application: eligible, close to the requested use
          reasons.push({ s: "r", t: `Application voisine : ${near.map((a) => APPLICATIONS[a] || a).join(", ")}` });
        } else blockers.push(`Non prévu pour : ${label}`);
      }
    } else if (apps.length && apps.every((a) => a === "autre")) score -= 10; // niche product (rail buffers, welding): not a generic answer
    if (additive) reasons.push({ s: "a", t: "Additif : s'ajoute à l'huile en place, ne la remplace pas" });

    // 3. Product family: usual family for the organ (soft); in replacement mode, the
    // family of the product in place (oil vs grease…, hard)
    if (c.application && FAMILY_FIT[c.application] && group === "main") score += FAMILY_FIT[c.application][p.family] || 0;
    if (c.families && c.families.length) {
      if (!p.family) {
        unchecked.push("famille");
        reasons.push({ s: "u", t: "Famille non renseignée" });
      }
      else if (c.families.includes(p.family)) score += 10;
      else blockers.push(`Famille « ${p.family} » ≠ ${c.families.join(" / ")}`);
    }

    // 4. Temperature — hard constraint on known limits
    const tmin = num(c.tmin);
    const tmax = num(c.tmax);
    // some semi-fluid greases have a higher minimum in gearboxes (data sheet: "for gearboxes: 0 °C")
    const gearMin = c.application === "engrenages_fermes" ? num(p.temp_min_gearbox_c) : null;
    const pmin = gearMin !== null ? gearMin : num(p.temp_min_c);
    const pmax = num(p.temp_max_c);
    // temp_na: no service-temperature spec for this kind of product. An additive runs at
    // the temperature of its base oil; a cleaner used as a cleaner needs none. A cleaner
    // used for another job (protection…) at a stated temperature cannot be checked.
    const cleaningJob = !c.application || c.application === "nettoyage_degraissage";
    if ((tmin !== null || tmax !== null) && p.temp_na && !additive && !(CLEANERS.includes(p.family) && cleaningJob)) {
      unchecked.push("température");
      reasons.push({ s: "u", t: `Pas de plage d'utilisation sur la fiche (besoin ${fmtT(tmin)} → ${fmtT(tmax)})` });
    }
    if ((tmin !== null || tmax !== null) && !p.temp_na) {
      const need = `${fmtT(tmin)} → ${fmtT(tmax)}`;
      let unknown = false;
      if (tmin !== null) {
        if (pmin === null) unknown = true;
        else if (pmin > tmin) blockers.push(`Mini produit${gearMin !== null ? " en réducteur" : ""} ${fmtT(pmin)} > besoin ${fmtT(tmin)}`);
      }
      if (tmax !== null) {
        if (pmax === null) unknown = true;
        else if (pmax < tmax) blockers.push(`Maxi produit ${fmtT(pmax)} < besoin ${fmtT(tmax)}`);
      }
      const failed = blockers.some((b) => b.startsWith("Mini produit") || b.startsWith("Maxi produit"));
      if (!failed) {
        if (unknown) {
          unchecked.push("température");
          reasons.push({ s: "u", t: `Plage de température à vérifier (besoin ${need})` });
        } else if (unsure(p, TEMP_UNSURE)) {
          unchecked.push("température");
          score += 8;
          reasons.push({ s: "u", t: `Plage ${fmtT(pmin)} → ${fmtT(pmax)} couvrirait ${need} : donnée à confirmer` });
        } else {
          // a comfortable margin counts a little: a range that just covers the need is a weaker fit
          const margin = Math.min(tmin !== null ? tmin - pmin : Infinity, tmax !== null ? pmax - tmax : Infinity);
          score += 20 + Math.min(4, Math.floor(margin / 10));
          reasons.push({ s: "y", t: `Plage ${fmtT(pmin)} → ${fmtT(pmax)}${gearMin !== null ? " (en réducteur)" : ""} couvre ${need}` });
        }
        // a hot or cold need favours the products made for it (their own claim)
        const env = c.env || [];
        if (tmax !== null && tmax >= HOT_NEED_C && props.includes("haute_temperature") && !env.includes("haute_temperature")) {
          score += 8;
          reasons.push({ s: "y", t: PROPERTIES.haute_temperature });
        }
        if (tmin !== null && tmin <= COLD_NEED_C && props.includes("basse_temperature") && !env.includes("basse_temperature")) {
          score += 8;
          reasons.push({ s: "y", t: PROPERTIES.basse_temperature });
        }
      }
    }
    // a high-temperature speciality is proposed first for a hot need only: for an ordinary
    // or unstated temperature, the standard product comes first
    if (props.includes("haute_temperature") && !(tmax !== null && tmax >= HOT_NEED_C) && !(c.env || []).includes("haute_temperature")) score -= 4;

    // 5. Environment — soft, except explicit requirements (biodegradable, PFAS-free)
    (c.env || []).forEach((e) => {
      const label = PROPERTIES[e] || e;
      if (REQUIRED_ENV[e]) {
        if (REQUIRED_ENV[e](props)) {
          const doubt = e === "sans_pfas" && unsure(p, PFAS_UNSURE);
          if (doubt) unchecked.push(label);
          score += doubt ? 3 : 8;
          reasons.push(doubt ? { s: "u", t: `${label} : à confirmer (absent du bilan PFAS Interflon d'avril 2025)` } : { s: "y", t: label });
        } else if (!props.length) {
          unchecked.push(label);
          reasons.push({ s: "u", t: `${label} : non renseigné, à vérifier` });
        } else blockers.push(`${label} : exigé, non revendiqué`);
        return;
      }
      // the condition itself counts more than a neighbouring property (dry film for dust…)
      const near = (ENV_MATCH[e] || []).find((x) => x !== e && props.includes(x));
      if (props.includes(e)) {
        score += 12;
        reasons.push({ s: "y", t: label });
      } else if (near) {
        score += 5;
        reasons.push({ s: "y", t: `${label} (${(PROPERTIES[near] || near).toLowerCase()})` });
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
    // first number only: "ISO VG 220" -> "220" (never glue several numbers together)
    const vg = (x) => (String(x || "").match(/\d+/) || [""])[0];
    if (c.iso_vg) {
      const want = +vg(c.iso_vg);
      const cst = num(p.viscosity_cst40);
      // the next grade up or down still counts a little (ISO grades are ~50 % apart)
      const near = (a, b) => (vgStep(a) !== null && vgStep(b) !== null ? Math.abs(vgStep(a) - vgStep(b)) : 99);
      if (p.viscosity_iso_vg) {
        const d = near(+vg(p.viscosity_iso_vg), want);
        if (vg(p.viscosity_iso_vg) === vg(c.iso_vg)) {
          score += 15;
          reasons.push({ s: "y", t: `Même viscosité ISO VG ${vg(c.iso_vg)}` });
        } else {
          if (d === 1) score += 6;
          reasons.push({ s: "n", t: `ISO VG ${p.viscosity_iso_vg} (actuel : ${c.iso_vg})${d === 1 ? ", grade voisin" : ""}` });
        }
      } else if (cst !== null && want) {
        // measured viscosity outside the ISO grades: ISO 3448 classes span ±10 % around the grade
        if (Math.abs(cst - want) <= want * 0.1) {
          score += 15;
          reasons.push({ s: "y", t: `${cst} cSt à 40 °C : dans la classe ISO VG ${want}` });
        } else {
          const d = near(cst, want);
          if (d === 1) score += 6;
          reasons.push({ s: "n", t: `${cst} cSt à 40 °C (actuel : ISO VG ${want})${d === 1 ? ", grade voisin" : ""}` });
        }
      } else if (p.family === "huile") reasons.push({ s: "u", t: "Viscosité ISO VG non renseignée" });
    }
    if (c.nlgi) {
      const a = nlgiIndex(p.nlgi);
      const b = nlgiIndex(c.nlgi);
      if (!p.nlgi) {
        if (p.family === "graisse") reasons.push({ s: "u", t: "Grade NLGI non renseigné" });
      } else if (a !== null && a === b) {
        score += 10;
        reasons.push({ s: "y", t: `Même grade NLGI ${c.nlgi}` });
      } else if (a !== null && b !== null && Math.abs(a - b) <= 0.5) {
        // "1/2" sits between NLGI 1 and 2
        score += 6;
        reasons.push({ s: "y", t: `NLGI ${p.nlgi}, proche du grade actuel ${c.nlgi}` });
      } else reasons.push({ s: "n", t: `NLGI ${p.nlgi} (actuel : ${c.nlgi})` });
    }

    blockers.forEach((b) => reasons.unshift({ s: "n", t: b }));
    return { eligible: blockers.length === 0, unchecked, verified: blockers.length === 0 && unchecked.length === 0, group, primary, score, reasons, blockers };
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

  const GROUP_ORDER = { main: 0, related: 1, additive: 2 };
  const CONFIDENCE = { high: 2, medium: 1, low: 0 };
  // fully checked matches first, then matches missing a datum, then the excluded; inside
  // each: the requested organ before a neighbouring one and additives, then the score
  const order = (a, b) =>
    (b.eligible - a.eligible) || (b.verified - a.verified) || (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || (b.score - a.score);
  // equal products are listed specialist first (fewer uses on its sheet), then the
  // better-documented sheet, then by name: an order of display, not a ranking
  const display = (a, b) =>
    (((a.product.applications || []).length || 99) - ((b.product.applications || []).length || 99)) ||
    ((CONFIDENCE[b.product.confidence] || 0) - (CONFIDENCE[a.product.confidence] || 0)) ||
    String(a.product.name).localeCompare(String(b.product.name));

  function rank(products, criteria) {
    const out = (products || [])
      .filter((p) => matchesQuery(p, criteria && criteria.query))
      .map((p) => Object.assign({ product: p }, evaluate(p, criteria)))
      .sort((a, b) => order(a, b) || display(a, b));
    // same score on every criterion: shown "ex æquo", never as a ranking
    out.forEach((r, i) => { r.tie = (i > 0 && !order(out[i - 1], r)) || (i < out.length - 1 && !order(r, out[i + 1])); });
    return out;
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

  return { APPLICATIONS, PROPERTIES, FORMATS, ENV_MATCH, RELATED, REPLACE_TYPES, REQUIRED_ENV, NSF_UNSURE, TEMP_UNSURE, PFAS_UNSURE, isVerified, isAdditive, compare: order, tempStatus, gaps, gapsText, nsfList, nsfParse, nlgiIndex, formatKinds, foodOk, foodMatch, unsure, evaluate, rank, matchesQuery };
});
