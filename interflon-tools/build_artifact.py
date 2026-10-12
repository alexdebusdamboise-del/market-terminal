#!/usr/bin/env python3
"""Build the claude.ai page version of the Terminal Interflon into dist/claude-ai/.

That page has no Python server behind it, so it runs in "static" mode:
selector, catalogue and prospect follow-up work; company search (PROS) shows
how to use the installed version instead. Run: python3 build_artifact.py
"""
import os
import re
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
OUT = os.path.join(ROOT, "dist", "claude-ai")


def main():
    html = open(os.path.join(PUBLIC, "index.html"), encoding="utf-8").read()
    css = open(os.path.join(PUBLIC, "styles.css"), encoding="utf-8").read()
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    # no map in the static page (external tiles are blocked there)
    body = re.sub(r'\s*<script src="vendor/leaflet/leaflet.js"></script>', "", body)
    page = (
        "<title>Terminal Interflon</title>\n"
        f"<style>\n{css}\n</style>\n"
        "<script>window.IFX_STATIC = true;</script>\n"
        f"{body.strip()}\n"
    )
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(page)
    for sub in ("js", "data"):
        shutil.copytree(os.path.join(PUBLIC, sub), os.path.join(OUT, sub))
    files = sorted(os.path.relpath(os.path.join(d, f), OUT) for d, _, fs in os.walk(OUT) for f in fs)
    print(f"{OUT}: {len(files)} files")
    for f in files:
        print("  ", f)


if __name__ == "__main__":
    main()
