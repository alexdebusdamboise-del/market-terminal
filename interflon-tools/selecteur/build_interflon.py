#!/usr/bin/env python3
"""Build a single-file, Interflon-styled copy of the product selector.

    python3 build_interflon.py [--logo chemin/vers/logo.svg|png]

Output: ../dist/selecteur-interflon.html, a standalone page (white and red,
products and logic embedded) that opens by double-click, without a server.
Without --logo, the header shows the company name as text until the official
logo file is supplied.
"""
import argparse
import base64
import json
import mimetypes
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "dist", "selecteur-interflon.html")

# Brand red sampled from the official logo (rgb 226, 32, 20); a slightly darker
# shade is used for small red text so it keeps enough contrast on white.
BRAND_TOKENS = """:root{
  color-scheme: light;
  --bg:#ffffff; --surface:#ffffff; --sunken:#f4f4f4; --line:#e1e1e1; --ink:#1d1d1b; --ink-2:#5d5d5d;
  --accent:#e22014; --accent-text:#c41a0f; --accent-ink:#ffffff; --accent-soft:#fde9e7;
  --ok:#1b7a43; --ok-soft:#e1f2e8; --warn:#8f6400; --warn-soft:#fbf0d4; --bad:#b0122a; --bad-soft:#fde8eb;
  --info:#3a4651; --info-soft:#eff1f3; --need:#1d1d1b;
  --display:"Archivo", "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  --body:"Source Sans 3", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono:"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --r:6px;
}"""

BRAND_CSS = """
/* white and red identity */
.top{border-bottom:4px solid var(--accent)}
.brand{gap:10px}
.logo{display:flex;align-items:center;min-height:40px}
.logo img{height:46px;width:auto;max-width:100%;display:block}
.logo-word{font:800 28px/1 var(--display);font-stretch:100%;letter-spacing:.08em;color:var(--accent)}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink)}
.btn{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.ghost{background:var(--surface);color:var(--ink);border-color:var(--line)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent)}
.q h2 .n,.rank,.sheet h3{color:var(--accent-text)}
.btn.ghost:hover{color:var(--accent-text)}
.badge.h1{background:var(--ok-soft);color:var(--ok)}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--logo", help="fichier du logo officiel (SVG, PNG ou JPG)")
    args = ap.parse_args()

    page = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    core = open(os.path.join(APP, "public", "js", "selector-core.js"), encoding="utf-8").read()
    data = json.load(open(os.path.join(APP, "public", "data", "produits.json"), encoding="utf-8"))

    # palette: one light white/red look instead of the light/dark pair
    page = re.sub(r":root\{\n  --bg:.*?\n\}\n@media \(prefers-color-scheme: dark\)\{.*?\n\}\}\n:root\[data-theme=\"dark\"\]\{.*?\n\}\n",
                  BRAND_TOKENS + "\n", page, count=1, flags=re.S)
    assert "prefers-color-scheme" not in page, "palette block not replaced"
    page = page.replace("</style>", BRAND_CSS + "</style>", 1)

    if args.logo:
        mime = mimetypes.guess_type(args.logo)[0] or "image/png"
        uri = f"data:{mime};base64," + base64.b64encode(open(args.logo, "rb").read()).decode()
        logo = f'<img src="{uri}" alt="Interflon">'
    else:
        logo = '<span class="logo-word" aria-label="Interflon">INTERFLON</span>'
    page = page.replace('<span class="eyebrow">Interflon · aide au choix</span>',
                        f'<div class="logo">{logo}</div>', 1)

    # embed logic and data so the file works offline, by double-click
    page = page.replace('<script src="js/selector-core.js"></script>', f"<script>\n{core}\n</script>", 1)
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    page = page.replace("<script>\n(function () {",
                        f'<script type="application/json" id="produits-data">{blob}</script>\n<script>\n(function () {{', 1)
    page = page.replace('const doc = await (await fetch("data/produits.json")).json();',
                        'const doc = JSON.parse(document.getElementById("produits-data").textContent);', 1)
    assert "fetch(" not in page and 'src="js/' not in page

    html = ('<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            f"{page}\n</html>\n")
    # the page body starts after the head elements (title, fonts, style)
    html = html.replace("</style>\n\n<div class=\"wrap\">", "</style>\n</head>\n<body>\n<div class=\"wrap\">", 1)
    html = html.replace("\n</html>\n", "\n</body>\n</html>\n")
    assert "<body>" in html
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(html)
    print(f"{OUT} ({len(html) // 1024} Ko){' avec logo' if args.logo else ' (logo en attente)'}")


if __name__ == "__main__":
    main()
