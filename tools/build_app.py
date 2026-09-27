"""Bundle src/ into a single self-contained index.html in the app directory.

Brewser's documented app shape is one HTML file with inline <style> and
<script> ("One HTML file, from Chrome to the Brewser catalogue"), and every
published catalogue app follows it. Shipping the emulator as a dozen separate
<script src> files relies on classic scripts sharing one global lexical scope
across files, which the runtime is not documented to guarantee — so the build
concatenates everything into a single inline script instead.

Usage:  python tools/build_app.py
Output: app/com.kumi0708.pc98doukyusei/index.html
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "app" / "com.kumi0708.pc98doukyusei" / "index.html"

# Load order matters: pc98.js wires the devices together, app.js drives them.
JS_ORDER = [
    "js/mem.js",
    "js/io.js",
    "js/cpu.js",
    "js/pic.js",
    "js/pit.js",
    "js/fdi.js",
    "js/fdc.js",
    "js/video.js",
    "js/kbd.js",
    "js/mouse.js",
    "js/bios.js",
    "js/pc98.js",
    "app.js",
]


def read(rel):
    p = SRC / rel
    if not p.is_file():
        sys.exit(f"missing source: {p}")
    return p.read_text(encoding="utf-8")


def main():
    template = read("index.template.html")
    style = read("style.css")

    parts = []
    for rel in JS_ORDER:
        body = read(rel)
        # Each source carries its own 'use strict'; one directive for the whole
        # bundle is enough and a stray directive mid-script is just a no-op
        # expression, so strip them and emit a single one at the top.
        body = body.replace("'use strict';\n", "", 1)
        parts.append(f"// ===== {rel} =====\n{body.strip()}\n")
    script = "'use strict';\n\n" + "\n".join(parts)

    for marker, payload in (("/*__STYLE__*/", style), ("/*__SCRIPT__*/", script)):
        if marker not in template:
            sys.exit(f"template is missing {marker}")
        template = template.replace(marker, payload)

    if "</script>" in script:
        sys.exit("a source file contains '</script>', which would close the inline block early")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(template, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
