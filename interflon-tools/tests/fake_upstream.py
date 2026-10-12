#!/usr/bin/env python3
"""
Fake "API Recherche d'entreprises" + geocoder used by the tests (no network).

Payloads follow the upstream OpenAPI schema (app/doc/open-api.yml of
github.com/annuaire-entreprises-data-gouv-fr/search-api): latitude/longitude
are strings, finances are keyed by year, dirigeants mix "personne physique"
and "personne morale", matching_etablissements may contain closed sites.

Special switches (query string) to exercise error paths:
  q=ratelimit -> 429 with Retry-After: 30
  q=bad       -> 400 {"erreur": "..."}
  q=boom      -> 500
Run standalone for manual / browser testing:
  python3 tests/fake_upstream.py --port 8799
"""

import argparse
import json
import random
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAFS = ["10.11Z", "10.13A", "10.51C", "10.71A", "11.07A", "16.10A", "17.21A", "25.62B", "28.29B", "70.10Z"]
TRANCHES = ["01", "03", "11", "12", "21", "22", "32", "41", None]
CITIES = [("29232", "QUIMPER", "29000", 47.996, -4.102), ("29019", "BREST", "29200", 48.390, -4.486),
          ("29103", "LANDERNEAU", "29800", 48.450, -4.250), ("29150", "MORLAIX", "29600", 48.577, -3.828),
          ("56121", "LORIENT", "56100", 47.750, -3.366), ("35238", "RENNES", "35000", 48.111, -1.680)]


def etab(siren, i, naf, tranche, city, etat="A", siege=False, created="2004-05-01"):
    code, lib, cp, lat, lon = city
    return {
        "activite_principale": naf,
        "activite_principale_naf25": naf[:-1] + "Y",
        "annee_tranche_effectif_salarie": "2023" if tranche else None,
        "adresse": f"{10 + i} RUE DE L'INDUSTRIE {cp} {lib}",
        "caractere_employeur": "O",
        "code_postal": cp,
        "commune": code,
        "date_creation": created,
        "date_debut_activite": created,
        "date_fermeture": None if etat == "A" else "2022-12-31",
        "epci": "242900314",
        "est_siege": siege,
        "etat_administratif": etat,
        "geo_id": f"{code}_0000_{i:05d}",
        "latitude": f"{lat + i * 0.003:.5f}",
        "libelle_commune": lib,
        "liste_enseignes": [f"USINE {lib}"] if i % 3 == 0 else None,
        "liste_finess": None,
        "liste_id_bio": None,
        "liste_idcc": ["7001"],
        "liste_id_organisme_formation": None,
        "liste_rge": None,
        "liste_uai": None,
        "longitude": f"{lon + i * 0.003:.5f}",
        "nom_commercial": None,
        "region": "53",
        "siret": f"{siren}{i:05d}",
        "statut_diffusion_etablissement": "O",
        "tranche_effectif_salarie": tranche,
    }


def company(n, rnd):
    siren = f"{100000000 + n * 7919:09d}"
    naf = NAFS[n % len(NAFS)]
    city = CITIES[n % len(CITIES)]
    tranche = TRANCHES[n % len(TRANCHES)]
    siege = etab(siren, 1, naf, tranche, city, siege=True)
    matching = [siege]
    if n % 4 == 0:   # a second, newer plant
        matching.append(etab(siren, 2, naf, "21", CITIES[(n + 1) % len(CITIES)], created="2025-09-01"))
    if n % 5 == 0:   # a closed site that must be filtered out
        matching.append(etab(siren, 3, naf, "11", city, etat="F"))
    return {
        "siren": siren,
        "siren_conserve": None,
        "nom_complet": f"ENTREPRISE TEST {n} <SAS>" if n == 3 else f"ENTREPRISE TEST {n}",
        "nom_raison_sociale": f"ENTREPRISE TEST {n}",
        "sigle": "ET" if n % 6 == 0 else None,
        "nombre_etablissements": len(matching) + 2,
        "nombre_etablissements_ouverts": len(matching),
        "siege": siege,
        "activite_principale": naf,
        "activite_principale_naf25": naf[:-1] + "Y",
        "categorie_entreprise": ["PME", "ETI", "GE", None][n % 4],
        "caractere_employeur": "O",
        "annee_categorie_entreprise": "2022",
        "date_creation": "1998-03-01",
        "date_fermeture": None,
        "date_mise_a_jour": "2026-10-01T03:00:00",
        "date_mise_a_jour_insee": "2026-10-01T03:00:00",
        "date_mise_a_jour_rne": "2026-09-30T02:00:00",
        "dirigeants": [
            {"nom": "DUPONT", "prenoms": "MARIE", "annee_de_naissance": "1970", "date_de_naissance": "1970-02",
             "qualite": "Président", "nationalite": "Française", "type_dirigeant": "personne physique"},
            {"siren": "784824153", "denomination": "CABINET AUDIT", "qualite": "Commissaire aux comptes titulaire",
             "type_dirigeant": "personne morale"},
        ],
        "etat_administratif": "A",
        "nature_juridique": "5710",
        "section_activite_principale": "C",
        "tranche_effectif_salarie": tranche,
        "annee_tranche_effectif_salarie": "2023",
        "statut_diffusion": "O",
        "matching_etablissements": matching,
        "finances": {"2022": {"ca": 1000000 * (n + 1), "resultat_net": 50000},
                     "2023": {"ca": 1200000 * (n + 1), "resultat_net": 60000}} if n % 3 else None,
        "complements": {"est_ess": False},
    }


ONLY_CLOSED = {   # a company whose only matching site is closed -> must disappear
    "siren": "999999999", "nom_complet": "FERMEE SA", "nom_raison_sociale": "FERMEE SA",
    "activite_principale": "10.11Z", "section_activite_principale": "C", "siege": {},
    "matching_etablissements": [etab("999999999", 1, "10.11Z", "12", CITIES[0], etat="F")],
    "finances": None, "dirigeants": [],
}

ND = "[NON-DIFFUSIBLE]"
NON_DIFFUSIBLE = dict(company(1000, None), siren="888888888", nom_complet="SOCIETE DISCRETE",
                      statut_diffusion="P", sigle=ND)
NON_DIFFUSIBLE["matching_etablissements"] = [dict(etab("888888888", 1, "10.11Z", "21", CITIES[0]),
                                                  adresse=ND, code_postal=ND, latitude=ND, longitude=ND)]
NON_DIFFUSIBLE["dirigeants"] = [{"nom": ND, "prenoms": ND, "qualite": "Gérant", "type_dirigeant": "personne physique"}]

TOTAL = 60


def search_payload(page, per_page):
    rnd = random.Random(42)
    all_cos = [company(n, rnd) for n in range(TOTAL)]
    start = (page - 1) * per_page
    results = all_cos[start:start + per_page]
    if page == 1:
        results = [ONLY_CLOSED, NON_DIFFUSIBLE] + results[:-2]
    total_pages = (TOTAL + per_page - 1) // per_page
    return {"results": results, "total_results": TOTAL, "page": page, "per_page": per_page, "total_pages": total_pages}


class FakeHandler(BaseHTTPRequestHandler):
    calls = []          # (path, params) of every request
    lock = threading.Lock()

    def log_message(self, *a):
        pass

    def _json(self, obj, status=200, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        with FakeHandler.lock:
            FakeHandler.calls.append((u.path, qs))
        q = qs.get("q", "")
        if q == "ratelimit":
            return self._json({"erreur": "Too many requests"}, 429, {"Retry-After": "30"})
        if q == "negretry":
            return self._json({"erreur": "Too many requests"}, 429, {"Retry-After": "-1"})
        if q == "html":
            body = b"<html>maintenance</html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if q == "bad":
            return self._json({"erreur": "Veuillez indiquer au moins un paramètre de recherche."}, 400)
        if q == "boom" or u.path.startswith("/broken"):
            return self._json({"erreur": "internal"}, 500)
        page = int(qs.get("page", 1))
        per_page = int(qs.get("per_page", 10))
        if u.path in ("/search", "/near_point"):
            return self._json(search_payload(page, per_page))
        if u.path.startswith("/limited"):
            return self._json({"erreur": "Too many requests"}, 429, {"Retry-After": "30"})
        if u.path.endswith("/geocode"):
            return self._json({"type": "FeatureCollection", "features": [
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-4.102, 47.996]},
                 "properties": {"label": "Quimper", "postcode": "29000", "citycode": "29232",
                                "context": "29, Finistère, Bretagne", "type": "municipality"}}]})
        return self._json({"erreur": "not found"}, 404)


def start(port=0):
    srv = ThreadingHTTPServer(("127.0.0.1", port), FakeHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8799)
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), FakeHandler)
    print(f"fake upstream on http://127.0.0.1:{a.port}")
    srv.serve_forever()
