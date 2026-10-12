#!/usr/bin/env python3
"""
TERMINAL INTERFLON — outils commerciaux : prospection d'usines + sélecteur produit.

Python standard library only (no pip installs), same philosophy as the market
terminal at the root of this repo. The server:
  - serves the single-page app in public/
  - proxies the French government's free, key-less company directory
    (API Recherche d'entreprises, https://recherche-entreprises.api.gouv.fr)
    with validation, normalisation, caching and rate limiting (the API allows
    max 7 requests/second per IP)
  - proxies a city geocoder (Géoplateforme IGN, then api-adresse as fallback)
    for the "autour de" search

Run:  python3 server.py [--port 8766]
Then open http://127.0.0.1:8766
"""

import argparse
import base64
import gzip
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")

# Upstreams are overridable so tests can point them at a local fake server.
API_BASE = os.environ.get("RECHERCHE_ENTREPRISES_URL",
                          "https://recherche-entreprises.api.gouv.fr").rstrip("/")
GEOCODE_URLS = [u for u in os.environ.get(
    "GEOCODE_URLS",
    "https://data.geopf.fr/geocodage/search,https://api-adresse.data.gouv.fr/search",
).split(",") if u.strip()]

# Optional shared password (HTTP Basic auth, any user name) for public hosting.
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")

# The API docs ask for an explicit, descriptive User-Agent.
UA = "TerminalInterflon/1.0 (outil interne de prospection; python-urllib)"

CACHE_TTL = 6 * 3600        # the directory is refreshed daily upstream
CACHE_MAX = 600
UPSTREAM_RPS = 5.0          # stay under the documented 7 req/s per IP


# ---------------------------------------------------------------------------
# Referentials (shared with the frontend) — used to validate parameters
# ---------------------------------------------------------------------------
with open(os.path.join(PUBLIC, "data", "referentiels.json"), encoding="utf-8") as _f:
    REF = json.load(_f)

TRANCHES = set(REF["tranches"])
REGIONS = set(REF["regions"])
SECTIONS = set(REF["sections"])
CATEGORIES = {"PME", "ETI", "GE"}
NAF_RE = re.compile(r"^\d{2}\.\d{2}[A-Z]$")
# Departements accepted by the upstream API (metropole, Corse, DROM except 975)
DEP_RE = re.compile(r"^(0[1-9]|1\d|2[1-9]|[3-8]\d|9[0-5]|2A|2B|97[12346])$")
CP_RE = re.compile(r"^\d{5}$")


# ---------------------------------------------------------------------------
# Tiny TTL cache + upstream rate limiter
# ---------------------------------------------------------------------------
class TTLCache:
    def __init__(self, max_items=CACHE_MAX):
        self._d = {}
        self._lock = threading.Lock()
        self._max = max_items

    def get(self, key):
        with self._lock:
            v = self._d.get(key)
            if not v:
                return None
            exp, data = v
            if time.time() > exp:
                self._d.pop(key, None)
                return None
            return data

    def set(self, key, data, ttl):
        with self._lock:
            if len(self._d) >= self._max and key not in self._d:
                # evict the entry that expires first
                oldest = min(self._d, key=lambda k: self._d[k][0])
                self._d.pop(oldest, None)
            self._d[key] = (time.time() + ttl, data)

    def clear(self):
        with self._lock:
            self._d.clear()


class RateLimiter:
    """Spaces upstream calls at least 1/rps seconds apart (thread-safe)."""

    def __init__(self, rps):
        self.interval = 1.0 / rps
        self._next = 0.0
        self._lock = threading.Lock()

    def wait(self):
        with self._lock:
            now = time.monotonic()
            at = max(now, self._next)
            self._next = at + self.interval
        delay = at - now
        if delay > 0:
            time.sleep(delay)


CACHE = TTLCache()
LIMITER = RateLimiter(UPSTREAM_RPS)


class UpstreamError(Exception):
    def __init__(self, status, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


def _read_body(resp):
    raw = resp.read()
    if resp.headers.get("Content-Encoding") == "gzip":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", "replace")


def fetch_json(url, timeout=20):
    """GET JSON from an upstream, cached, rate-limited, with one polite retry
    on short 429s and transient 5xx/network errors."""
    cached = CACHE.get(url)
    if cached is not None:
        return cached
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
    })
    for attempt in (1, 2):
        LIMITER.wait()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(_read_body(resp))
            CACHE.set(url, data, CACHE_TTL)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                try:
                    retry_after = float(e.headers.get("Retry-After") or 2)
                except ValueError:
                    retry_after = 2.0
                if attempt == 1 and retry_after <= 3:
                    time.sleep(retry_after)
                    continue
                raise UpstreamError(429, "Limite de requêtes de l'API atteinte, "
                                         "réessayez dans quelques secondes.", retry_after)
            if e.code == 400:
                try:
                    msg = json.loads(_read_body(e)).get("erreur") or "requête refusée"
                except Exception:
                    msg = "requête refusée"
                raise UpstreamError(400, f"API : {msg}")
            if e.code >= 500 and attempt == 1:
                time.sleep(1.0)
                continue
            raise UpstreamError(502, f"API indisponible (HTTP {e.code})")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt == 1:
                time.sleep(0.5)
                continue
            raise UpstreamError(502, f"API injoignable ({getattr(e, 'reason', e)})")
    raise UpstreamError(502, "API indisponible")


# ---------------------------------------------------------------------------
# Parameter validation
# ---------------------------------------------------------------------------
class BadRequest(Exception):
    pass


def _one(qs, key, default=""):
    return (qs.get(key, [default])[0] or "").strip()


def _list(qs, key, valid, label, max_items=200, upper=True):
    raw = _one(qs, key)
    if not raw:
        return []
    items = [x.strip() for x in raw.split(",") if x.strip()]
    if upper:
        items = [x.upper() for x in items]
    if len(items) > max_items:
        raise BadRequest(f"{label} : {max_items} valeurs maximum")
    for x in items:
        ok = valid(x) if callable(valid) else x in valid
        if not ok:
            raise BadRequest(f"{label} invalide : {x}")
    # de-duplicate, keep order
    return list(dict.fromkeys(items))


def _int(qs, key, default, lo, hi, label):
    raw = _one(qs, key)
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        raise BadRequest(f"{label} doit être un entier")
    if not lo <= v <= hi:
        raise BadRequest(f"{label} doit être entre {lo} et {hi}")
    return v


def _float(qs, key, lo, hi, label, default=None):
    raw = _one(qs, key)
    if not raw:
        if default is None:
            raise BadRequest(f"{label} requis")
        return default
    try:
        v = float(raw)
    except ValueError:
        raise BadRequest(f"{label} doit être un nombre")
    if not lo <= v <= hi:
        raise BadRequest(f"{label} doit être entre {lo} et {hi}")
    return v


def _paging(qs):
    page = _int(qs, "page", 1, 1, 400, "page")
    per_page = _int(qs, "per_page", 25, 1, 25, "per_page")
    if page * per_page > 10000:   # hard limit of the upstream API
        raise BadRequest("au-delà de 10 000 résultats : affinez la recherche")
    return page, per_page


def build_search_params(qs):
    """Query string of /api/entreprises -> upstream /search parameters."""
    naf = _list(qs, "naf", NAF_RE.match, "Code NAF")
    section = _list(qs, "section", SECTIONS, "Section NAF", 21)
    dep = _list(qs, "departement", DEP_RE.match, "Département", 30)
    region = _list(qs, "region", REGIONS, "Région", 18)
    cp = _list(qs, "code_postal", CP_RE.match, "Code postal", 50)
    tranche = _list(qs, "tranche", TRANCHES, "Tranche d'effectif", 16)
    cat = _list(qs, "categorie", CATEGORIES, "Catégorie", 3)
    q = _one(qs, "q")[:100]
    if not (naf or section or q):
        raise BadRequest("indiquez au moins un secteur (code NAF) ou un nom")
    page, per_page = _paging(qs)
    params = {
        "etat_administratif": "A",
        "page": page,
        "per_page": per_page,
        "limite_matching_etablissements": 100,
    }
    if q:
        params["q"] = q
    if naf:
        params["activite_principale"] = ",".join(naf)
    if section:
        params["section_activite_principale"] = ",".join(section)
    if dep:
        params["departement"] = ",".join(dep)
    if region:
        params["region"] = ",".join(region)
    if cp:
        params["code_postal"] = ",".join(cp)
    if tranche:
        params["tranche_effectif_salarie"] = ",".join(tranche)
    if cat:
        params["categorie_entreprise"] = ",".join(cat)
    return params


def build_near_params(qs):
    """Query string of /api/autour -> upstream /near_point parameters."""
    lat = _float(qs, "lat", -90, 90, "lat")
    lon = _float(qs, "lon", -180, 180, "lon")
    radius = _float(qs, "radius", 0.5, 50, "rayon (km)", default=20)
    naf = _list(qs, "naf", NAF_RE.match, "Code NAF")
    section = _list(qs, "section", SECTIONS, "Section NAF", 21)
    page, per_page = _paging(qs)
    params = {
        "lat": f"{lat:.6f}",
        "long": f"{lon:.6f}",
        "radius": f"{radius:g}",
        "page": page,
        "per_page": per_page,
        "limite_matching_etablissements": 100,
    }
    if naf:
        params["activite_principale"] = ",".join(naf)
    if section:
        params["section_activite_principale"] = ",".join(section)
    return params


# ---------------------------------------------------------------------------
# Normalisation of upstream payloads (keeps only what the UI needs)
# ---------------------------------------------------------------------------
def _num(x):
    try:
        return float(x) if x not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _dep_from(commune, code_postal):
    c = commune or ""
    if c[:2] in ("2A", "2B"):
        return c[:2]
    if c.startswith("97"):
        return c[:3]
    if c[:2].isdigit():
        return c[:2]
    cp = code_postal or ""
    if cp.startswith("97"):
        return cp[:3]
    if cp.startswith("20"):
        return "2A" if cp < "20200" else "2B"
    return cp[:2] or None


def _norm_etab(e):
    lat, lon = _num(e.get("latitude")), _num(e.get("longitude"))
    if lat is None or lon is None or (lat == 0 and lon == 0):
        lat = lon = None
    return {
        "siret": e.get("siret"),
        "est_siege": bool(e.get("est_siege")),
        "adresse": e.get("adresse") or "",
        "code_postal": e.get("code_postal") or "",
        "commune": e.get("libelle_commune") or "",
        "departement": _dep_from(e.get("commune"), e.get("code_postal")),
        "lat": lat,
        "lon": lon,
        "naf": e.get("activite_principale"),
        "tranche": e.get("tranche_effectif_salarie"),
        "annee_tranche": e.get("annee_tranche_effectif_salarie"),
        "date_creation": e.get("date_creation"),
        "enseignes": [x for x in (e.get("liste_enseignes") or []) if x],
        "nom_commercial": e.get("nom_commercial"),
    }


def _latest_finances(fin):
    if not isinstance(fin, dict):
        return None, None, None
    years = sorted((y for y in fin if isinstance(fin.get(y), dict)), reverse=True)
    for y in years:
        ca = fin[y].get("ca")
        if ca is not None:
            return ca, y, fin[y].get("resultat_net")
    return None, None, None


def _norm_dirigeants(lst):
    out = []
    for d in (lst or [])[:8]:
        if d.get("type_dirigeant") == "personne morale":
            nom = d.get("denomination") or ""
            kind = "pm"
        else:
            nom = " ".join(x for x in (d.get("prenoms"), d.get("nom")) if x)
            kind = "pp"
        if nom:
            out.append({"nom": nom, "qualite": d.get("qualite") or "", "type": kind})
    return out


def normalize_results(payload):
    results = []
    for r in payload.get("results") or []:
        siege = r.get("siege") or {}
        etabs = r.get("matching_etablissements") or []
        if not etabs and siege:
            # no establishment filter (e.g. France entière): only the HQ is known
            etabs = [siege]
        active = [_norm_etab(e) for e in etabs if e.get("etat_administratif") != "F"]
        if not active:
            continue
        ca, ca_annee, rn = _latest_finances(r.get("finances"))
        results.append({
            "siren": r.get("siren"),
            "nom": r.get("nom_complet") or r.get("nom_raison_sociale") or "",
            "sigle": r.get("sigle"),
            "naf": r.get("activite_principale"),
            "section": r.get("section_activite_principale"),
            "categorie": r.get("categorie_entreprise"),
            "tranche": r.get("tranche_effectif_salarie"),
            "annee_tranche": r.get("annee_tranche_effectif_salarie"),
            "date_creation": r.get("date_creation"),
            "nb_etab_ouverts": r.get("nombre_etablissements_ouverts"),
            "nature_juridique": r.get("nature_juridique"),
            "ca": ca,
            "ca_annee": ca_annee,
            "resultat_net": rn,
            "dirigeants": _norm_dirigeants(r.get("dirigeants")),
            "siege_commune": siege.get("libelle_commune") or "",
            "siege_siret": siege.get("siret"),
            "etablissements": active,
        })
    return {
        "total_results": payload.get("total_results", 0),
        "total_pages": payload.get("total_pages", 0),
        "page": payload.get("page", 1),
        "per_page": payload.get("per_page", 25),
        "results": results,
    }


def search_entreprises(qs):
    params = build_search_params(qs)
    url = f"{API_BASE}/search?{urllib.parse.urlencode(params)}"
    return normalize_results(fetch_json(url))


def search_autour(qs):
    params = build_near_params(qs)
    url = f"{API_BASE}/near_point?{urllib.parse.urlencode(params)}"
    return normalize_results(fetch_json(url))


def geocode(qs):
    q = _one(qs, "q")
    if not 2 <= len(q) <= 80:
        raise BadRequest("indiquez une ville (2 à 80 caractères)")
    last = None
    for base in GEOCODE_URLS:
        url = f"{base.strip()}?{urllib.parse.urlencode({'q': q, 'type': 'municipality', 'limit': 6})}"
        try:
            data = fetch_json(url, timeout=10)
        except UpstreamError as e:
            last = e
            continue
        out = []
        for f in data.get("features") or []:
            p = f.get("properties") or {}
            coords = (f.get("geometry") or {}).get("coordinates") or []
            if len(coords) < 2:
                continue
            out.append({
                "label": p.get("label") or p.get("city") or p.get("name") or q,
                "postcode": p.get("postcode") or "",
                "citycode": p.get("citycode") or "",
                "context": p.get("context") or "",
                "lat": coords[1],
                "lon": coords[0],
            })
        return {"results": out}
    raise last or UpstreamError(502, "géocodage indisponible")


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

API_ROUTES = {
    "/api/entreprises": search_entreprises,
    "/api/autour": search_autour,
    "/api/geocode": geocode,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "TerminalInterflon/1.0"

    def log_message(self, fmt, *args):
        pass  # quiet

    def _send_json(self, obj, status=200, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        try:
            with open(path, "rb") as f:
                body = f.read()
        except (FileNotFoundError, IsADirectoryError):
            self.send_error(404, "Not Found")
            return
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        # data files change when the team edits them: always revalidate
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, path):
        if not APP_PASSWORD or path == "/api/health":
            return True
        h = self.headers.get("Authorization", "")
        if not h.startswith("Basic "):
            return False
        try:
            _, _, pw = base64.b64decode(h[6:]).decode("utf-8").partition(":")
        except Exception:
            return False
        return hmac.compare_digest(pw.encode("utf-8"), APP_PASSWORD.encode("utf-8"))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not self._authorized(path):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="Terminal Interflon", charset="UTF-8"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path.startswith("/api/"):
            return self._handle_api(path, urllib.parse.parse_qs(parsed.query))

        if path in ("", "/"):
            path = "/index.html"
        full = os.path.realpath(os.path.join(PUBLIC, urllib.parse.unquote(path).lstrip("/")))
        if os.path.commonpath([full, os.path.realpath(PUBLIC)]) != os.path.realpath(PUBLIC):
            self.send_error(403, "Forbidden")
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        self._send_file(full)

    def _handle_api(self, path, qs):
        if path == "/api/health":
            return self._send_json({"ok": True, "api": API_BASE})
        fn = API_ROUTES.get(path)
        if not fn:
            return self._send_json({"error": "endpoint inconnu"}, 404)
        try:
            return self._send_json(fn(qs))
        except BadRequest as e:
            return self._send_json({"error": str(e)}, 400)
        except UpstreamError as e:
            headers = {"Retry-After": str(int(e.retry_after + 0.999))} if e.retry_after else None
            return self._send_json({"error": e.message, "retry_after": e.retry_after},
                                   e.status, headers)
        except Exception as e:  # never leak a stack trace to the browser
            return self._send_json({"error": f"erreur interne : {e.__class__.__name__}"}, 500)


def make_server(host, port):
    return ThreadingHTTPServer((host, port), Handler)


def main():
    ap = argparse.ArgumentParser()
    # PORT/HOST env vars let cloud hosts (Render, Railway…) configure it
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8766")))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    args = ap.parse_args()
    httpd = make_server(args.host, args.port)
    print(f"TERMINAL INTERFLON running at http://{args.host}:{args.port}")
    if APP_PASSWORD:
        print("Access protected by APP_PASSWORD (HTTP Basic auth).")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
