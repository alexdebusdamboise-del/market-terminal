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
const cleaner = P({ id: "c", name: "Metal Clean F", family: "degraissant", nsf: "K1", applications: ["nettoyage_degraissage"] });
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

test("cleaners accept K/A/C categories and release agents accept 3H in food plants", () => {
  assert.equal(C.evaluate(cleaner, { food: "oui", application: "nettoyage_degraissage" }).eligible, true);
  assert.equal(C.evaluate(release, { food: "oui", application: "demoulage" }).eligible, true);
  assert.equal(C.evaluate(cleaner, { food: "oui", application: "chaines" }).eligible, false);
});

test("'je ne sais pas' never excludes but favours H1", () => {
  const r = C.rank([indusChain, foodChain], { food: "nsp", application: "chaines" });
  assert.ok(r.every((x) => x.eligible));
  assert.equal(r[0].product.id, "fl");
  assert.ok(r[1].reasons.some((x) => x.s === "u" && /H1/.test(x.t)));
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
  assert.ok(related.reasons.some((x) => x.s === "u" && /voisine/.test(x.t)));
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
  assert.equal(C.evaluate(P({ nsf: "K1/K3", applications: ["nettoyage_degraissage"] }), { food: "oui", application: "nettoyage_degraissage" }).eligible, true);
  assert.equal(C.evaluate(P({ nsf: "H2", applications: ["chaines"] }), { food: "oui", application: "chaines" }).eligible, false);
});
