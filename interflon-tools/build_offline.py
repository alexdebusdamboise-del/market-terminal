#!/usr/bin/env python3
"""Build the offline, single-file version of the Terminal Interflon, with the
company logo: dist/terminal-interflon.html. Opens by double-click, no server.

Selector, catalogue and prospect follow-up work; company search (PROS) needs
the installed version (python3 server.py). Run: python3 build_offline.py
"""
import base64
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
OUT = os.path.join(ROOT, "dist", "terminal-interflon.html")
JS = ["util.js", "selector-core.js", "prospect.js", "pipeline.js", "selector.js", "app.js"]
DATA = ["referentiels.json", "secteurs.json", "produits.json", "equivalences.json"]


def read(*p):
    return open(os.path.join(PUBLIC, *p), encoding="utf-8").read()


def main():
    html = read("index.html")
    order = re.findall(r'<script src="js/([\w.-]+)"></script>', html)
    assert sorted(order) == sorted(JS), f"scripts de index.html inattendus : {order}"
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    # no map offline (tiles come from the internet and PROS needs the server anyway)
    body = re.sub(r'\s*<script src="vendor/leaflet/leaflet.js"></script>', "", body)
    logo = "data:image/png;base64," + base64.b64encode(open(os.path.join(PUBLIC, "img", "logo-interflon.png"), "rb").read()).decode()
    body = body.replace('src="img/logo-interflon.png"', f'src="{logo}"', 1)
    data = {f"data/{f}": json.load(open(os.path.join(PUBLIC, "data", f), encoding="utf-8")) for f in DATA}
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    boot = f"<script>window.IFX_STATIC = true; window.IFX_OFFLINE = true; window.IFX_DATA = {blob};</script>"
    for name in order:
        code = read("js", name).replace("</script", "<\\/script")
        body = body.replace(f'<script src="js/{name}"></script>', f"<script>/* {name} */\n{code}\n</script>", 1)
    assert 'src="js/' not in body and "img/logo-interflon" not in body
    head = re.search(r"<head>(.*)</head>", html, re.S).group(1)
    head = re.sub(r'\s*<link rel="stylesheet" href="vendor/leaflet/leaflet.css" />', "", head)
    head = head.replace('<link rel="stylesheet" href="styles.css" />', f"<style>\n{read('styles.css')}\n</style>")
    page = f'<!DOCTYPE html>\n<html lang="fr">\n<head>{head}</head>\n<body>\n{boot}\n{body.strip()}\n</body>\n</html>\n'
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(page)
    print(f"{OUT} ({len(page) // 1024} Ko)")


if __name__ == "__main__":
    main()
