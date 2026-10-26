#!/usr/bin/env bash
# Renders every still for the tc3d-osm-types-floors canvas (run from .tmp/driver, dev API on :5175).
set -u
rc=0
for p in m1-koak ksfo-final m3-KOAK m3-KSFO; do
  node run.mjs "plans/$p.json" > "run-$p.log" 2>&1 || { echo "$p FAILED"; rc=1; }
  grep -E "^totals" "run-$p.log" | sed "s/^/$p /"
done
for a in KSFO KOAK; do
  for s in A-poly B-poly C-poly; do uv run --no-project --with pillow python annotate.py "m3-$a-$s"; done
  uv run --no-project --with pillow python annotate.py "m3-$a-B-radius" --radius
done
uv run --no-project --with pillow python annotate4.py
exit $rc
