#!/usr/bin/env python3
"""Consistency check of the editable data files (run after every edit).

    python3 tests/check_data.py

Exit code 1 if an error is found; warnings are printed but do not fail.
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
CORE = os.path.join(ROOT, "public", "js", "selector-core.js")

FAMILIES = {"huile", "graisse", "aerosol", "nettoyant", "degraissant", "agent_demoulage",
            "lubrificateur_automatique", "accessoire", "autre"}
PRIORITIES = {"haute", "moyenne", "basse"}
CONFIDENCE = {"high", "medium", "low"}
NSF_TOKEN = re.compile(r"^(H1|H2|H3|3H|HT1|A\d|C\d|K\d|P1|M1|R\d|N\d)$")


def enum_keys(js, const):
    """Keys of `const NAME = { key: "...", ... }` in selector-core.js (single source of truth)."""
    m = re.search(r"const %s = \{(.*?)\n  \};" % const, js, re.S)
    return set(re.findall(r"^\s+(\w+):", m.group(1), re.M)) if m else set()


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").lower().replace("interflon ", "")).strip()


def main():
    errors, warnings = [], []
    err = errors.append
    warn = warnings.append
    load = lambda f: json.load(open(os.path.join(DATA, f), encoding="utf-8"))

    js = open(CORE, encoding="utf-8").read()
    apps, props = enum_keys(js, "APPLICATIONS"), enum_keys(js, "PROPERTIES")
    if not apps or not props:
        err("impossible de lire APPLICATIONS/PROPERTIES dans selector-core.js")
    ref = load("referentiels.json")

    # ---------------------------------------------------------------- produits
    prods = load("produits.json").get("products", [])
    if not prods:
        err("produits.json : aucun produit")
    ids, names = set(), {}
    for i, p in enumerate(prods):
        where = f"produits.json[{i}] {p.get('name', '?')}"
        for k in ("id", "name", "family", "description_fr"):
            if not p.get(k):
                err(f"{where} : champ '{k}' manquant")
        if p.get("id") in ids:
            err(f"{where} : id en double '{p.get('id')}'")
        ids.add(p.get("id"))
        if p.get("id") and not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", p["id"]):
            err(f"{where} : id '{p['id']}' doit être en minuscules-avec-tirets")
        if norm(p.get("name")) in names:
            err(f"{where} : nom en double")
        names[norm(p.get("name"))] = p
        if p.get("family") not in FAMILIES:
            err(f"{where} : famille inconnue '{p.get('family')}'")
        if p.get("nsf"):
            for tok in re.split(r"[\s,;/+]+", str(p["nsf"]).upper()):
                if tok and not NSF_TOKEN.match(tok):
                    err(f"{where} : catégorie NSF inconnue '{tok}'")
        tmin, tmax = p.get("temp_min_c"), p.get("temp_max_c")
        for k, v in (("temp_min_c", tmin), ("temp_max_c", tmax)):
            if v is not None and not isinstance(v, (int, float)):
                err(f"{where} : {k} doit être un nombre ou null")
            if isinstance(v, (int, float)) and not -100 <= v <= 1500:
                err(f"{where} : {k} = {v} hors plage plausible")
        if isinstance(tmin, (int, float)) and isinstance(tmax, (int, float)) and tmin >= tmax:
            err(f"{where} : temp_min_c ({tmin}) >= temp_max_c ({tmax})")
        for a in p.get("applications") or []:
            if a not in apps:
                err(f"{where} : application inconnue '{a}'")
        for a in p.get("properties") or []:
            if a not in props:
                err(f"{where} : propriété inconnue '{a}'")
        if p.get("confidence") not in CONFIDENCE:
            err(f"{where} : confidence doit être high/medium/low")
        for u in p.get("source_urls") or []:
            if not re.match(r"^https?://", u):
                err(f"{where} : URL de source invalide '{u}'")
        if not p.get("source_urls"):
            warn(f"{where} : aucune source")
        if p.get("family") in ("huile", "graisse", "aerosol") and not p.get("applications"):
            warn(f"{where} : applications non renseignées (le sélecteur le signalera « à vérifier »)")

    def resolve(name):
        n = norm(name)
        return names.get(n) or next((p for k, p in names.items() if k.startswith(n)), None)

    # ---------------------------------------------------------------- secteurs
    segs = load("secteurs.json").get("secteurs", [])
    if not segs:
        err("secteurs.json : aucun secteur")
    keys, seen_naf = set(), {}
    for i, s in enumerate(segs):
        where = f"secteurs.json[{i}] {s.get('key', '?')}"
        if not s.get("key") or not re.match(r"^[a-z0-9_]+$", s["key"]):
            err(f"{where} : 'key' manquante ou invalide (minuscules, chiffres, _)")
        if s.get("key") in keys:
            err(f"{where} : key en double")
        keys.add(s.get("key"))
        if not s.get("label"):
            err(f"{where} : 'label' manquant")
        if s.get("priority") not in PRIORITIES:
            err(f"{where} : priority doit être haute/moyenne/basse")
        if not isinstance(s.get("food"), bool):
            err(f"{where} : 'food' doit être true ou false")
        if not s.get("naf_codes"):
            err(f"{where} : aucun code NAF")
        for c in s.get("naf_codes") or []:
            if c not in ref["naf"]:
                err(f"{where} : code NAF inconnu '{c}'")
            if c in seen_naf:
                warn(f"{where} : code NAF {c} déjà dans '{seen_naf[c]}' (le premier secteur l'emporte)")
            seen_naf.setdefault(c, s.get("key"))
        for a in s.get("applications") or []:
            if a not in apps:
                err(f"{where} : application inconnue '{a}'")
        for n in s.get("recommended_products") or []:
            if not resolve(n):
                err(f"{where} : produit recommandé introuvable dans produits.json '{n}'")
        for c in s.get("case_studies") or []:
            if not re.match(r"^https?://", c.get("url", "")) or not c.get("title"):
                err(f"{where} : cas client sans titre ou URL valide")

    # ---------------------------------------------------------------- équivalences
    for i, e in enumerate(load("equivalences.json").get("equivalences", [])):
        where = f"equivalences.json[{i}]"
        if not e.get("marque") or not e.get("reference"):
            err(f"{where} : 'marque' et 'reference' obligatoires")
        if not resolve(e.get("interflon")):
            err(f"{where} : produit Interflon introuvable '{e.get('interflon')}'")

    for w in warnings:
        print("ATTENTION", w)
    for e in errors:
        print("ERREUR   ", e)
    print(f"\n{len(prods)} produits, {len(segs)} secteurs : {len(errors)} erreur(s), {len(warnings)} avertissement(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
