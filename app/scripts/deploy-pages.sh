#!/usr/bin/env bash
# Build the site for Cloudflare Pages and upload it. See DEPLOY-DATABRICKS.md section 5.
#
#   npm run deploy:pages                 through the data server (the default)
#   SERVERLESS=1 npm run deploy:pages     straight from the sources, no data server
#
# With a data server, VITE_DATA_SERVER=same-origin makes the page call its own /api, which is
# the Pages Function in functions/api/ forwarding to the Databricks app.
#
# Serverless leaves the variable out, and every browser then fetches the sources itself — CWFIS,
# Open-Meteo, NRCan's reported fires and Calgary 311 all send `access-control-allow-origin: *`.
# Two things are lost, neither of which the pitch uses: live aircraft (adsb.lol answers browsers
# without a CORS header, so the call is blocked) and Firefly's typed answers (the model needs a
# credential that cannot ship to a page; voice still works, since it is a recorded clip).
#
# Building here rather than in Pages' build container is deliberate: public/data is about 900 MB,
# so a clone-and-build remotely is slow and close to the build time limit for no benefit.
set -euo pipefail

PROJECT="${PROJECT:-firewatch}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -f .env ] || echo "note: no app/.env, so the firefly will be offline on the deployed site."

# The data-server branch is tree-shaken out when VITE_DATA_SERVER is unset, so whether one of
# its request paths survives is what actually proves which build came out. (Don't test for the
# string "same-origin" — it is in the bundle either way, from a dependency.)
if [ -n "${SERVERLESS:-}" ]; then
  echo "Building without a data server..."
  npm run build
  grep -roq -- "/cwfis/hotspots" dist/assets/*.js && {
    echo "Build still calls /api — VITE_DATA_SERVER leaked in from the environment or app/.env. Not uploading."; exit 1; }
  for host in cwfis.cfs.nrcan.gc.ca api.open-meteo.com api.cwfif.nrcan.gc.ca data.calgary.ca; do
    grep -roq -- "$host" dist/assets/*.js || { echo "Build is missing $host, so that source would not load. Not uploading."; exit 1; }
  done
  echo "Sources are fetched directly; no /api needed."
else
  echo "Building (VITE_DATA_SERVER=same-origin)..."
  VITE_DATA_SERVER=same-origin npm run build
  grep -roq -- "/cwfis/hotspots" dist/assets/*.js || {
    echo "Build is not wired to /api — VITE_DATA_SERVER did not take. Not uploading."; exit 1; }
fi

echo "Uploading to Cloudflare Pages project '$PROJECT'..."
npx wrangler pages deploy dist --project-name "$PROJECT"
