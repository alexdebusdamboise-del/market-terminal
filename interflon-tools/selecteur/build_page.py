#!/usr/bin/env python3
"""Build the claude.ai page of the selector into dist/selecteur-page/.

Same page, colours and features as selecteur/index.html, without the company
logo: a published page must not pass for an official Interflon page. The version
with the logo is the single file built by build_interflon.py.
Run: python3 selecteur/build_page.py
"""
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "dist", "selecteur-page")



def main():
    page = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    # no logo: header keeps its titles, print sheet keeps its kicker
    page, n = re.subn(r'\s*<img class="logo" src="img/logo-interflon.png"[^>]*>', "", page)
    assert n == 1, "header logo not found"
    page = page.replace('<header class="pr-head"><img src="img/logo-interflon.png" alt="Interflon">', '<header class="pr-head">', 1)
    page = page.replace("</style>", ".titles{padding-left:0;border-left:0}\n</style>", 1)
    assert "logo-interflon" not in page
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "js"))
    os.makedirs(os.path.join(OUT, "data"))
    open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(page)
    shutil.copy(os.path.join(APP, "public", "js", "selector-core.js"), os.path.join(OUT, "js"))
    for f in ("produits.json", "equivalences.json"):
        shutil.copy(os.path.join(APP, "public", "data", f), os.path.join(OUT, "data"))
    print(OUT, "ready")


if __name__ == "__main__":
    main()
