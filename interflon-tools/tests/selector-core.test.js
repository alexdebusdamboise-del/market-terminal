// Selector logic tests — run from interflon-tools/:  node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../public/js/selector-core.js");

const P = (o) =>
  Object.assign(
    { id: "x", name: "X", family: "huile", nsf: null, temp_min_c: null, temp_max_c: null, applications: [], properties: [], formats: [], confidence: "medium" },
    o
  );

const foodChain = P({ id: "fl", name: "Food Lube", nsf: "H1", temp_min_c: -20, temp_max_c: 250, applications: ["chaines", "convoyeurs"], properties: ["film_sec", "resistant_eau"], formats: ["Aérosol 400 ml", "1 L", "5 L"] });
const indusChain = P({ id: "tf", name: "Lube TF", nsf: "H2", temp_min_c: -40, temp_max_c: 250, applications: ["chaines"], properties: ["film_sec", "environnement_poussiereux"], formats: ["Aérosol 400 ml", "20 L"] });
const ht = P({ id: "ht", name: "Lube HT", nsf: "H2", temp_min_c: 0, temp_max_c: 270, applications: ["chaines"], formats: ["5 L"] });
const unknown = P({ id: "u", name: "Mystère", applications: [] });
const grease = P({ id: "g", name: "Grease MP2", family: "graisse", nlgi: "2", temp_min_c: -30, temp_max_c: 140, applications: ["roulements"], formats: ["cartouche 400 g"] });
const cleaner = P({ id: "c", name: "Foam Clean", family: "nettoyant", nsf: "A1", applications: ["nettoyage_degraissage"] });
const k1 = P({ id: "k", name: "Degreaser EM30+", family: "degraissant", nsf: "K1, K3", applications: ["nettoyage_degraissage"] });
const release = P({ id: "r", name: "Food Lube 3H", family: "agent_demoulage", nsf: "3H", applications: ["demoulage"] });

test("food contact = oui excludes products without NSF H1", () => {
  const r = C.rank([foodChain, indusChain, unknown], { food: "oui", application: "chaines" });
  assert.equal(r[0].product.id, "fl");
  assert.equal(r[0].eligible, true);
  const tf = r.find((x) => x.product.id === "tf");
  assert.equal(tf.eligible, false);
  assert.match(tf.blockers[0], /NSF H2/);
  assert.equal(r.find((x) => x.product.id === "u").eligible, false, "unknown NSF can never pass a food-contact requirement");
});

test("food plants: cleaners need A1/A7/H1, release agents 3H/H1; K1/K3 is not accepted", () => {
  const ok = C.evaluate(cleaner, { food: "oui", application: "nettoyage_degraissage" });
  assert.equal(ok.eligible, true);
  assert.match(ok.reasons[0].t, /A1/);
  assert.equal(C.evaluate(P({ nsf: "A7", applications: ["nettoyage_degraissage"] }), { food: "oui", application: "nettoyage_degraissage" }).eligible, true);
  assert.equal(C.evaluate(k1, { food: "oui", application: "nettoyage_degraissage" }).eligible, false);
  assert.equal(C.evaluate(release, { food: "oui", application: "demoulage" }).eligible, true);
  assert.equal(C.evaluate(cleaner, { food: "oui", application: "chaines" }).eligible, false, "A1 is not a lubricant category");
});

test("'je ne sais pas' never excludes but favours H1", () => {
  const r = C.rank([indusChain, foodChain], { food: "nsp", application: "chaines" });
  assert.ok(r.every((x) => x.eligible));
  assert.equal(r[0].product.id, "fl");
  assert.ok(r[1].reasons.some((x) => x.s === "a" && /contact alimentaire/.test(x.t)));
});

test("temperature: hard on known limits, flagged when unknown", () => {
  const c = { tmin: -10, tmax: 260 };
  assert.equal(C.evaluate(ht, c).eligible, false, "0 °C min does not cover -10 °C");
  assert.equal(C.evaluate(foodChain, c).eligible, false, "250 °C max does not cover 260 °C");
  assert.equal(C.evaluate(P({ temp_min_c: -40, temp_max_c: 300 }), c).eligible, true);
  const u = C.evaluate(unknown, c);
  assert.equal(u.eligible, true);
  assert.ok(u.reasons.some((x) => x.s === "u" && /température/.test(x.t)));
  // only an upper bound requested
  assert.equal(C.evaluate(ht, { tmax: 265 }).eligible, true);
  assert.equal(C.evaluate(ht, { tmin: "", tmax: "" }).reasons.length, 0, "empty strings mean no constraint");
});

test("application: exact, related, unrelated, unknown", () => {
  assert.equal(C.evaluate(foodChain, { application: "chaines" }).eligible, true);
  const related = C.evaluate(P({ applications: ["chaines"] }), { application: "convoyeurs" });
  assert.equal(related.eligible, true);
  assert.ok(related.reasons.some((x) => x.s === "r" && /voisine/.test(x.t)));
  assert.equal(C.evaluate(grease, { application: "chaines" }).eligible, false);
  const unk = C.evaluate(unknown, { application: "chaines" });
  assert.equal(unk.eligible, true);
  assert.equal(unk.reasons[0].s, "u");
});

test("environment and formats are soft and add score", () => {
  const a = C.evaluate(indusChain, { application: "chaines", env: ["environnement_poussiereux"], formats: ["aerosol"] });
  const b = C.evaluate(ht, { application: "chaines", env: ["environnement_poussiereux"], formats: ["aerosol"] });
  assert.equal(b.eligible, true);
  assert.ok(a.score > b.score);
  assert.ok(b.reasons.some((x) => x.s === "n" && /poussiéreux/i.test(x.t)));
  // dusty environment is satisfied by a dry film
  assert.ok(C.evaluate(foodChain, { env: ["environnement_poussiereux"] }).reasons.some((x) => x.s === "y"));
});

test("replacement: family filter and viscosity / NLGI matching", () => {
  const r = C.rank([foodChain, grease], { families: ["graisse"], nlgi: "2" });
  assert.equal(r[0].product.id, "g");
  assert.equal(r[1].eligible, false);
  const vg = C.evaluate(P({ viscosity_iso_vg: "220" }), { iso_vg: "VG 220" });
  assert.ok(vg.reasons.some((x) => x.s === "y" && /220/.test(x.t)));
  const vg2 = C.evaluate(P({ viscosity_iso_vg: "150" }), { iso_vg: "220" });
  assert.ok(vg2.reasons.some((x) => x.s === "n"));
});

test("formatKinds classifies free-text packagings", () => {
  const k = (f) => Array.from(C.formatKinds([f])).sort().join(",");
  assert.equal(k("Aérosol 400 ml"), "aerosol");
  assert.equal(k("spray 300 ml"), "aerosol");
  assert.equal(k("1 L"), "liquide");
  assert.equal(k("500 ml"), "liquide");
  assert.equal(k("5 L"), "vrac");
  assert.equal(k("20 litres"), "vrac");
  assert.equal(k("Fût 200 L"), "vrac");
  assert.equal(k("cartouche 400 g"), "graisse");
  assert.equal(k("seau 18 kg"), "graisse,vrac");
  assert.equal(k("Lubrificateur automatique 125 ml"), "automatique");
});

test("matchesQuery is accent and case insensitive, all words required", () => {
  assert.ok(C.matchesQuery(foodChain, "food chaines"));
  assert.ok(C.matchesQuery(foodChain, "CHAÎNES"));
  assert.ok(!C.matchesQuery(foodChain, "food graisse"));
});

test("rank puts eligible first then by score then by name", () => {
  const r = C.rank([ht, indusChain, foodChain], { application: "chaines", tmax: 240, env: ["film_sec"] });
  assert.deepEqual(r.map((x) => x.eligible), [true, true, true]);
  assert.ok(r[0].score >= r[1].score && r[1].score >= r[2].score);
});

test("combined NSF categories ('3H, H1', 'K1/K3') are understood", () => {
  assert.deepEqual(C.nsfList({ nsf: "3H, H1" }), ["3H", "H1"]);
  assert.equal(C.evaluate(P({ nsf: "3H, H1", applications: ["chaines"] }), { food: "oui", application: "chaines" }).eligible, true);
  assert.equal(C.evaluate(P({ nsf: "K1/K3", applications: ["nettoyage_degraissage"] }), { food: "oui", application: "nettoyage_degraissage" }).eligible, false);
  assert.equal(C.evaluate(P({ nsf: "NSF H1", applications: ["chaines"] }), { food: "oui", application: "chaines" }).eligible, true);
  assert.equal(C.evaluate(P({ nsf: "H2", applications: ["chaines"] }), { food: "oui", application: "chaines" }).eligible, false);
});

test("NSF mentions that are not plain categories fail closed", () => {
  for (const nsf of ["Non H1", "H1 (en cours)", "pas H1", "H1 pending", "ex-H1"]) {
    const r = C.evaluate(P({ nsf, applications: ["chaines"] }), { food: "oui", application: "chaines" });
    assert.equal(r.eligible, false, nsf);
    assert.match(r.blockers[0], /illisible|non adapté/, nsf);
  }
  assert.equal(C.nsfParse({ nsf: "Non H1" }), null);
});

test("unconfirmed NSF or temperature data is shown as '?' not as a green check", () => {
  const p = P({ nsf: "H1", temp_min_c: -30, temp_max_c: 120, applications: ["chaines"], uncertain_fields: ["nsf (déduit de la gamme)", "temp_max_c (source unique)"] });
  const r = C.evaluate(p, { food: "oui", application: "chaines", tmin: 0, tmax: 100 });
  assert.equal(r.eligible, true);
  assert.ok(r.reasons.some((x) => x.s === "u" && /NSF H1.*confirmer/.test(x.t)));
  assert.ok(r.reasons.some((x) => x.s === "u" && /couvrirait/.test(x.t)));
  assert.ok(!r.reasons.some((x) => x.s === "y" && /NSF|Plage/.test(x.t)));
  // nsf_reg_no uncertainty alone does not downgrade the category
  const q = C.evaluate(P({ nsf: "H1", applications: ["chaines"], uncertain_fields: ["nsf_reg_no"] }), { food: "oui", application: "chaines" });
  assert.ok(q.reasons.some((x) => x.s === "y" && /NSF H1/.test(x.t)));
});

test("'exigé' requirements (sans PFAS, biodégradable) are hard constraints", () => {
  const ptfe = P({ applications: ["chaines"], properties: ["contient_ptfe", "sans_pfas"] });
  const free = P({ applications: ["chaines"], properties: ["sans_pfas"] });
  const unknownProps = P({ applications: ["chaines"], properties: [] });
  const c = { application: "chaines", env: ["sans_pfas"] };
  assert.equal(C.evaluate(ptfe, c).eligible, false);
  assert.equal(C.evaluate(free, c).eligible, true);
  const u = C.evaluate(unknownProps, c);
  assert.equal(u.eligible, true);
  assert.ok(u.reasons.some((x) => x.s === "u"));
  assert.equal(C.evaluate(P({ properties: ["resistant_eau"] }), { env: ["biodegradable"] }).eligible, false);
});

test("formatKinds handles French thousands separators and grease cartridges", () => {
  const k = (f) => Array.from(C.formatKinds([f])).sort().join(",");
  assert.equal(k("IBC 1 000 L"), "vrac");
  assert.equal(k("Fût 1\u00a0000 litres"), "vrac");
  assert.equal(k("Cartouche 400 g pour graisseur manuel"), "graisse");
  assert.equal(k("Bidon 4 L"), "liquide");
  assert.equal(k("Interflon Single Point Lubricator 125 ml"), "automatique");
});

test("temp_na products are not judged on temperature", () => {
  const r = C.evaluate(P({ family: "nettoyant", temp_na: true, applications: ["nettoyage_degraissage"] }), { application: "nettoyage_degraissage", tmin: 5, tmax: 60 });
  assert.equal(r.eligible, true);
  assert.ok(!r.reasons.some((x) => /température/i.test(x.t)));
});

test("viscosity: ISO grade, measured cSt within ±10 %, irrelevant families", () => {
  const c = { iso_vg: "ISO VG 220" };
  assert.ok(C.evaluate(P({ family: "huile", viscosity_iso_vg: "220" }), c).reasons.some((x) => x.s === "y"));
  // 24 cSt at 40 °C falls in ISO VG 22 (19.8 to 24.2), 120 cSt in no grade
  assert.ok(C.evaluate(P({ family: "huile", viscosity_cst40: 24 }), { iso_vg: "22" }).reasons.some((x) => x.s === "y" && /classe ISO VG 22/.test(x.t)));
  assert.ok(C.evaluate(P({ family: "huile", viscosity_cst40: 120 }), { iso_vg: "100" }).reasons.some((x) => x.s === "n"));
  assert.ok(C.evaluate(P({ family: "huile" }), c).reasons.some((x) => x.s === "u"));
  // a cleaner or a grease has no ISO VG: nothing to flag
  assert.ok(!C.evaluate(P({ family: "nettoyant" }), c).reasons.some((x) => x.s === "u"));
  assert.ok(!C.evaluate(P({ family: "huile" }), { nlgi: "2" }).reasons.some((x) => x.s === "u"));
  assert.ok(C.evaluate(P({ family: "graisse" }), { nlgi: "2" }).reasons.some((x) => x.s === "u"));
});

test("gearbox minimum applies only to closed gears", () => {
  const p = P({ family: "graisse", temp_min_c: -25, temp_min_gearbox_c: 0, temp_max_c: 145, applications: ["engrenages_fermes", "roulements"] });
  assert.equal(C.evaluate(p, { application: "engrenages_fermes", tmin: -10 }).eligible, false);
  assert.equal(C.evaluate(p, { application: "roulements", tmin: -10 }).eligible, true);
  assert.ok(C.evaluate(p, { application: "engrenages_fermes", tmin: 5 }).reasons.some((x) => x.s === "y" && /en réducteur/.test(x.t)));
});

test("temperature status is shown on its own; gaps say what a sheet lacks", () => {
  const ev = [{ field: "temp_min_c", quote: "q", url: "u" }, { field: "temp_max_c", quote: "q", url: "u" }];
  assert.equal(C.tempStatus(P({ temp_min_c: -10, temp_max_c: 100, evidence: ev })), "ok");
  assert.equal(C.tempStatus(P({ temp_min_c: -10, temp_max_c: 100, evidence: ev, uncertain_fields: ["temp_max_c (source unique)"] })), "doubt");
  assert.equal(C.tempStatus(P({ temp_min_c: -10, temp_max_c: 100, evidence: [] })), "doubt");
  assert.equal(C.tempStatus(P({ temp_min_c: -10 })), "missing");
  assert.equal(C.tempStatus(P({ family: "nettoyant", temp_na: true })), "na");
  const p = P({ formats: [], nlgi: null, properties: ["sans_pfas"], uncertain_fields: ["formats", "nlgi", "properties (sans PFAS : produit absent du bilan PFAS interne d'avril 2025, à confirmer)"] });
  assert.deepEqual(C.gaps(p).map((g) => [g.label, g.missing]), [["conditionnements", true], ["grade NLGI", true], ["sans PFAS", false]]);
  assert.equal(C.gapsText(p), "conditionnements, grade NLGI à compléter · sans PFAS à confirmer");
  assert.equal(C.gapsText(P({ uncertain_fields: [] })), "");
});

test("matches missing a datum on a hard criterion rank after fully checked ones", () => {
  const ev = [{ field: "temp_min_c" }, { field: "temp_max_c" }];
  const known = P({ name: "A known", nsf: "H1", temp_min_c: -20, temp_max_c: 270, applications: ["chaines"], evidence: ev });
  const noMax = P({ name: "B no max", nsf: "H1", temp_min_c: -10, applications: ["chaines"] });
  const empty = P({ name: "C empty", nsf: "H1" });
  const c = { food: "oui", application: "chaines", tmin: 50, tmax: 250 };
  const r = C.rank([empty, noMax, known], c);
  assert.deepEqual(r.map((x) => [x.product.name, x.eligible, x.verified]), [["A known", true, true], ["B no max", true, false], ["C empty", true, false]]);
  assert.deepEqual(r[1].unchecked, ["température"]);
  assert.deepEqual(r[2].unchecked, ["application", "température"]);
  // soft criteria (packaging, viscosity) never make a match "unchecked"
  const r2 = C.evaluate(P({ family: "huile", applications: ["chaines"], formats: [] }), { application: "chaines", formats: ["vrac"], iso_vg: "220" });
  assert.equal(r2.verified, true);
});

// ---------------------------------------------------------------- ranking that follows the criteria
test("additives go apart: never a lubricant choice, temperature left to the base oil", () => {
  const add = P({ name: "Interflon Fin Gear Additive", family: "autre", temp_na: true, applications: ["engrenages_fermes"] });
  const oil = P({ name: "Gear Oil", family: "huile", temp_min_c: -10, temp_max_c: 100, applications: ["engrenages_fermes"] });
  const r = C.rank([add, oil], { application: "engrenages_fermes", tmin: 20, tmax: 80 });
  assert.equal(r[0].product.name, "Gear Oil");
  const a = r.find((x) => x.product === add);
  assert.equal(a.group, "additive");
  assert.equal(a.verified, true, "an additive runs at its oil's temperature: nothing to check on its sheet");
  assert.ok(a.reasons.some((x) => x.s === "a" && /Additif/.test(x.t)));
  assert.equal(C.isAdditive(P({ family: "autre", name: "Interflon Film WB" })), false);
});

test("a neighbouring organ is listed apart from the products made for the organ", () => {
  const near = C.evaluate(P({ applications: ["convoyeurs"] }), { application: "chaines" });
  assert.equal(near.group, "related");
  assert.equal(C.evaluate(P({ applications: ["chaines"] }), { application: "chaines" }).group, "main");
  assert.equal(C.evaluate(P({ applications: ["chaines"] }), {}).group, "main");
});

test("a cleaner is not checked on temperature for cleaning, but is for another job", () => {
  const dry = P({ family: "nettoyant", temp_na: true, applications: ["nettoyage_degraissage", "protection_anticorrosion"] });
  assert.equal(C.evaluate(dry, { application: "nettoyage_degraissage", tmax: 60 }).verified, true);
  const prot = C.evaluate(dry, { application: "protection_anticorrosion", tmin: 50, tmax: 250 });
  assert.equal(prot.eligible, true);
  assert.deepEqual(prot.unchecked, ["température"]);
});

test("each criterion moves the ranking: food contact 'non', conditions, organ family, heat", () => {
  const h1 = P({ name: "A Food", nsf: "H1", applications: ["chaines"] });
  const ind = P({ name: "B Indus", nsf: "H2", applications: ["chaines"] });
  assert.equal(C.rank([h1, ind], { application: "chaines", food: "non" })[0].product.name, "B Indus", "no food contact: industrial equivalent first");
  assert.equal(C.rank([h1, ind], { application: "chaines" })[0].tie, true, "nothing to tell them apart: ex aequo");
  // the stated condition counts more than a neighbouring property
  const direct = P({ name: "B direct", applications: ["chaines"], properties: ["environnement_poussiereux"] });
  const film = P({ name: "A film", applications: ["chaines"], properties: ["film_sec"] });
  assert.equal(C.rank([film, direct], { application: "chaines", env: ["environnement_poussiereux"] })[0].product.name, "B direct");
  // usual family for the organ at equal suitability
  const oil = P({ name: "B oil", family: "huile", applications: ["chaines", "roulements"] });
  const grease = P({ name: "A grease", family: "graisse", applications: ["chaines", "roulements"] });
  assert.equal(C.rank([grease, oil], { application: "chaines" })[0].product.name, "B oil");
  assert.equal(C.rank([oil, grease], { application: "roulements" })[0].product.name, "A grease");
  // heat specialities first only for a hot need
  const std = P({ name: "B std", temp_min_c: -20, temp_max_c: 180, applications: ["chaines"] });
  const hot = P({ name: "A hot", temp_min_c: -20, temp_max_c: 270, applications: ["chaines"], properties: ["haute_temperature"] });
  assert.equal(C.rank([hot, std], { application: "chaines" })[0].product.name, "B std");
  assert.equal(C.rank([hot, std], { application: "chaines", tmin: 20, tmax: 80 })[0].product.name, "B std");
  assert.equal(C.rank([std, hot], { application: "chaines", tmin: 20, tmax: 170 })[0].product.name, "A hot");
  // a cold need favours the product made for the cold, a wide margin a little
  const cold = P({ name: "B cold", temp_min_c: -45, temp_max_c: 120, applications: ["roulements"], properties: ["basse_temperature"] });
  const just = P({ name: "A just", temp_min_c: -30, temp_max_c: 120, applications: ["roulements"] });
  assert.equal(C.rank([just, cold], { application: "roulements", tmin: -28, tmax: 0 })[0].product.name, "B cold");
});

test("ties are said, not hidden behind the alphabet", () => {
  const a = P({ name: "Alpha", applications: ["chaines"] });
  const b = P({ name: "Beta", applications: ["chaines"] });
  const c = P({ name: "Gamma", applications: ["chaines"], properties: ["resistant_eau"] });
  const r = C.rank([b, a, c], { application: "chaines", env: ["resistant_eau"] });
  assert.equal(r[0].product.name, "Gamma");
  assert.equal(r[0].tie, false);
  assert.deepEqual(r.slice(1).map((x) => x.tie), [true, true]);
  assert.equal(C.compare(r[1], r[2]), 0);
  assert.ok(C.compare(r[0], r[1]) < 0);
});

test("NLGI and ISO VG: a neighbouring grade counts, less than the same grade", () => {
  assert.equal(C.nlgiIndex("1/2"), 3.5);
  assert.equal(C.nlgiIndex("NLGI 000"), 0);
  assert.equal(C.nlgiIndex("x"), null);
  const g = (nlgi) => C.evaluate(P({ family: "graisse", nlgi }), { nlgi: "1" }).score;
  assert.ok(g("1") > g("1/2") && g("1/2") > g("2") && g("2") === g("3"));
  const v = (iso) => C.evaluate(P({ family: "huile", viscosity_iso_vg: iso }), { iso_vg: "220" }).score;
  assert.ok(v("220") > v("150") && v("150") === v("320") && v("320") > v("68"));
});

test("real catalogue: the first choice follows the organ and the conditions", () => {
  const prods = require("../public/data/produits.json").products.filter((p) => !["lubrificateur_automatique", "accessoire"].includes(p.family));
  const first = (c) => C.rank(prods, c).filter((r) => r.verified && r.group === "main").map((r) => r.product);
  const LUBE = ["chaines", "convoyeurs", "glissieres_guides", "engrenages_fermes", "engrenages_ouverts", "roulements", "cables", "verins_pneumatique", "hydraulique", "compresseurs", "mecanismes_articulations", "moteurs_electriques"];
  const tops = new Set();
  for (const application of LUBE) {
    for (const food of ["", "oui", "non"]) {
      for (const [tmin, tmax] of [["", ""], [5, 40], [20, 120], [50, 250], [-40, -18]]) {
        const ok = first({ application, food, tmin, tmax });
        ok.forEach((p) => {
          assert.ok(!C.isAdditive(p), `${p.name} recommended as a lubricant for ${application}`);
          assert.ok(!["nettoyant", "degraissant"].includes(p.family), `${p.name} recommended for ${application}`);
        });
        if (ok.length && food === "non") tops.add(application + ":" + ok[0].name);
      }
    }
  }
  // different organs give different first choices (the original complaint)
  const byOrgan = (a) => first({ application: a, food: "non" })[0].name;
  assert.equal(new Set(["chaines", "roulements", "glissieres_guides", "hydraulique", "engrenages_fermes", "verins_pneumatique"].map(byOrgan)).size, 6);
  // an oven chain in a food plant: the one H1 chain oil whose sheet covers 250 °C
  assert.equal(first({ application: "chaines", food: "oui", tmin: 50, tmax: 250 })[0].name, "Interflon Food Lube HT");
  // adding a condition changes the answer for chains
  const plain = first({ application: "chaines", food: "non" });
  const dusty = first({ application: "chaines", food: "non", env: ["environnement_poussiereux"] });
  assert.ok(dusty[0].properties.includes("environnement_poussiereux"));
  assert.notDeepEqual(plain.slice(0, 3).map((p) => p.name), dusty.slice(0, 3).map((p) => p.name));
});
