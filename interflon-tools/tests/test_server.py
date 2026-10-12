#!/usr/bin/env python3
"""Server tests — stdlib unittest, no network (fake upstream on localhost).

Run from interflon-tools/:  python3 -m unittest discover -s tests -v
"""

import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import server  # noqa: E402
import fake_upstream  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = fake_upstream.start()
        cls.fake_url = f"http://127.0.0.1:{cls.fake.server_address[1]}"
        server.API_BASE = cls.fake_url
        server.GEOCODE_URLS = [f"{cls.fake_url}/broken/geocode", f"{cls.fake_url}/geocode"]
        server.LIMITER = server.RateLimiter(1000)
        cls.app = server.make_server("127.0.0.1", 0)
        threading.Thread(target=cls.app.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.app.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown()
        cls.fake.shutdown()

    def setUp(self):
        server.CACHE.clear()
        fake_upstream.FakeHandler.calls.clear()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=30) as r:
                return r.status, json.loads(r.read() or b"null"), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                body = json.loads(body)
            except ValueError:
                pass
            return e.code, body, dict(e.headers)

    def last_call(self):
        return fake_upstream.FakeHandler.calls[-1]

    # ------------------------------------------------------------ /api/entreprises
    def test_search_maps_parameters_to_upstream(self):
        st, body, _ = self.get("/api/entreprises?naf=10.11Z,10.13a,10.11Z&departement=29,2a&tranche=12,21&page=2")
        self.assertEqual(st, 200, body)
        path, qs = self.last_call()
        self.assertEqual(path, "/search")
        self.assertEqual(qs["activite_principale"], "10.11Z,10.13A")  # upper-cased, de-duplicated
        self.assertEqual(qs["departement"], "29,2A")
        self.assertEqual(qs["tranche_effectif_salarie"], "12,21")
        self.assertEqual(qs["etat_administratif"], "A")
        self.assertEqual(qs["per_page"], "25")
        self.assertEqual(qs["page"], "2")
        self.assertEqual(qs["limite_matching_etablissements"], "100")
        self.assertNotIn("q", qs)

    def test_region_and_postcode_filters(self):
        st, _, _ = self.get("/api/entreprises?naf=16.10A&region=53&code_postal=29000,29200")
        self.assertEqual(st, 200)
        _, qs = self.last_call()
        self.assertEqual(qs["region"], "53")
        self.assertEqual(qs["code_postal"], "29000,29200")

    def test_normalisation(self):
        st, body, _ = self.get("/api/entreprises?naf=10.11Z&departement=29")
        self.assertEqual(st, 200)
        sirens = [r["siren"] for r in body["results"]]
        self.assertNotIn("999999999", sirens, "company with only closed sites must be dropped")
        self.assertEqual(body["total_results"], 60)
        self.assertEqual(body["total_pages"], 3)
        co0 = next(r for r in body["results"] if r["nom"] == "ENTREPRISE TEST 0")
        # n=0: siege + new plant + closed site -> 2 active establishments
        self.assertEqual(len(co0["etablissements"]), 2)
        self.assertTrue(all(isinstance(e["lat"], float) for e in co0["etablissements"]))
        self.assertEqual(co0["etablissements"][0]["departement"], "29")
        self.assertEqual(co0["etablissements"][0]["commune"], "QUIMPER")
        self.assertIsNone(co0["ca"])  # n % 3 == 0 -> no finances
        co1 = next(r for r in body["results"] if r["nom"] == "ENTREPRISE TEST 1")
        self.assertEqual(co1["ca"], 2400000)   # latest year (2023) kept
        self.assertEqual(co1["ca_annee"], "2023")
        self.assertEqual(co1["dirigeants"][0], {"nom": "MARIE DUPONT", "qualite": "Président", "type": "pp"})
        self.assertEqual(co1["dirigeants"][1]["type"], "pm")
        self.assertNotIn("annee_de_naissance", json.dumps(co1["dirigeants"]))

    def test_validation_errors(self):
        bad = [
            "/api/entreprises?departement=29",                       # no sector
            "/api/entreprises?naf=10.11&departement=29",             # malformed NAF
            "/api/entreprises?naf=10.11Z&departement=20",            # not a departement
            "/api/entreprises?naf=10.11Z&departement=975",           # not accepted upstream
            "/api/entreprises?naf=10.11Z&region=99",
            "/api/entreprises?naf=10.11Z&code_postal=2900",
            "/api/entreprises?naf=10.11Z&tranche=99",
            "/api/entreprises?naf=10.11Z&per_page=26",
            "/api/entreprises?naf=10.11Z&page=0",
            "/api/entreprises?naf=10.11Z&page=401&per_page=25",
            "/api/entreprises?naf=10.11Z&page=abc",
        ]
        for path in bad:
            with self.subTest(path=path):
                st, body, _ = self.get(path)
                self.assertEqual(st, 400, body)
                self.assertIn("error", body)
        self.assertEqual(fake_upstream.FakeHandler.calls, [], "invalid requests must not reach the API")

    def test_page_limit_10000_is_allowed(self):
        st, _, _ = self.get("/api/entreprises?naf=10.11Z&departement=29&page=400&per_page=25")
        self.assertEqual(st, 200)

    def test_upstream_errors(self):
        st, body, headers = self.get("/api/entreprises?naf=10.11Z&q=ratelimit")
        self.assertEqual(st, 429)
        self.assertEqual(body["retry_after"], 30.0)
        self.assertEqual(headers.get("Retry-After"), "30")
        st, body, _ = self.get("/api/entreprises?naf=10.11Z&q=bad")
        self.assertEqual(st, 400)
        self.assertIn("au moins un paramètre", body["error"])
        st, body, _ = self.get("/api/entreprises?naf=10.11Z&q=boom")
        self.assertEqual(st, 502)
        self.assertEqual(sum(1 for c in fake_upstream.FakeHandler.calls if c[1].get("q") == "boom"), 2,
                         "a 5xx is retried exactly once")

    def test_cache(self):
        self.get("/api/entreprises?naf=10.11Z&departement=29")
        self.get("/api/entreprises?naf=10.11Z&departement=29")
        self.assertEqual(len(fake_upstream.FakeHandler.calls), 1)

    # ------------------------------------------------------------ /api/autour
    def test_near_point(self):
        st, body, _ = self.get("/api/autour?lat=47.996&lon=-4.102&radius=30&naf=10.11Z,16.10A")
        self.assertEqual(st, 200, body)
        path, qs = self.last_call()
        self.assertEqual(path, "/near_point")
        self.assertEqual(qs["lat"], "47.996000")
        self.assertEqual(qs["long"], "-4.102000")
        self.assertEqual(qs["radius"], "30")
        self.assertEqual(qs["activite_principale"], "10.11Z,16.10A")
        self.assertTrue(body["results"])

    def test_near_point_validation(self):
        for path in ["/api/autour?lat=47&naf=10.11Z", "/api/autour?lat=47&lon=-4&radius=51&naf=10.11Z",
                     "/api/autour?lat=147&lon=-4&naf=10.11Z", "/api/autour?lat=x&lon=-4&naf=10.11Z"]:
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 400)

    # ------------------------------------------------------------ /api/geocode
    def test_geocode_with_fallback(self):
        st, body, _ = self.get("/api/geocode?q=Quimper")
        self.assertEqual(st, 200, body)
        self.assertEqual(body["results"][0]["label"], "Quimper")
        self.assertAlmostEqual(body["results"][0]["lat"], 47.996)
        self.assertAlmostEqual(body["results"][0]["lon"], -4.102)
        paths = [c[0] for c in fake_upstream.FakeHandler.calls]
        self.assertEqual(paths, ["/broken/geocode", "/broken/geocode", "/geocode"])

    def test_geocode_validation(self):
        self.assertEqual(self.get("/api/geocode?q=a")[0], 400)

    # ------------------------------------------------------------ static files
    def test_static_and_traversal(self):
        with urllib.request.urlopen(self.base + "/", timeout=10) as r:
            self.assertIn(b"Terminal Interflon", r.read())
        with urllib.request.urlopen(self.base + "/data/referentiels.json", timeout=10) as r:
            self.assertIn("application/json", r.headers["Content-Type"])
        for p in ["/../server.py", "/%2e%2e/server.py", "/..%2fserver.py", "/data/../../server.py"]:
            with self.subTest(path=p):
                try:
                    with urllib.request.urlopen(self.base + p, timeout=10) as r:
                        self.assertNotIn(b"import argparse", r.read())
                except urllib.error.HTTPError as e:
                    self.assertIn(e.code, (403, 404))

    def test_optional_password(self):
        import base64
        server.APP_PASSWORD = "s3cret"
        try:
            st, _, headers = self.get("/")
            self.assertEqual(st, 401)
            self.assertIn("Basic", headers.get("WWW-Authenticate", ""))
            self.assertEqual(self.get("/api/health")[0], 200, "health check stays open")
            for pw, expected in (("s3cret", 200), ("wrong", 401)):
                req = urllib.request.Request(self.base + "/", headers={
                    "Authorization": "Basic " + base64.b64encode(f"vendeur:{pw}".encode()).decode()})
                try:
                    with urllib.request.urlopen(req, timeout=10) as r:
                        code = r.status
                except urllib.error.HTTPError as e:
                    code = e.code
                self.assertEqual(code, expected, pw)
        finally:
            server.APP_PASSWORD = ""

    def test_unknown_api(self):
        self.assertEqual(self.get("/api/nope")[0], 404)
        self.assertEqual(self.get("/api/health")[0], 200)


class UnitTest(unittest.TestCase):
    def test_rate_limiter_spacing(self):
        lim = server.RateLimiter(20)  # 50 ms apart
        t0 = time.monotonic()
        for _ in range(4):
            lim.wait()
        self.assertGreaterEqual(time.monotonic() - t0, 0.14)

    def test_dep_from(self):
        self.assertEqual(server._dep_from("2A004", "20000"), "2A")
        self.assertEqual(server._dep_from("97411", "97400"), "974")
        self.assertEqual(server._dep_from("29232", "29000"), "29")
        self.assertEqual(server._dep_from(None, "20290"), "2B")
        self.assertEqual(server._dep_from(None, "97100"), "971")

    def test_latest_finances_skips_years_without_ca(self):
        ca, year, rn = server._latest_finances({"2023": {"ca": None, "resultat_net": 1}, "2022": {"ca": 5, "resultat_net": 2}})
        self.assertEqual((ca, year, rn), (5, "2022", 2))
        self.assertEqual(server._latest_finances(None), (None, None, None))

    def test_cache_eviction(self):
        c = server.TTLCache(max_items=2)
        c.set("a", 1, 10)
        c.set("b", 2, 20)
        c.set("c", 3, 30)
        self.assertIsNone(c.get("a"))
        self.assertEqual(c.get("c"), 3)


if __name__ == "__main__":
    unittest.main()
