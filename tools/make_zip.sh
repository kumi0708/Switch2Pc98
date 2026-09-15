#!/bin/bash
# Package the Brewser app into dist/<id>.zip (unzip into sd:/switch/brewser/apps/)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID=com.kumi0708.pc98doukyusei
mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/$ID.zip"
rm -f "$OUT"
cd "$ROOT/app"
if command -v zip >/dev/null 2>&1; then
  zip -r -q "$OUT" "$ID"
else
  # Windows without zip: use Python's zipfile (paths in POSIX form)
  python -c "import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', '.', sys.argv[2])" "$OUT" "$ID"
fi
ls -la "$OUT"
