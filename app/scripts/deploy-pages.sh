#!/usr/bin/env bash
# Build the site for Cloudflare Pages and upload it. See DEPLOY-DATABRICKS.md section 5.
#
#   npm run deploy:pages
#
# VITE_DATA_SERVER=same-origin is what makes the page call its own /api, which is the Pages
# Function in functions/api/ forwarding to the Databricks app. Building here rather than in
# Pages' build container is deliberate: public/data is about 900 MB, so a clone-and-build
# remotely is slow and close to the build time limit for no benefit.
set -euo pipefail

PROJECT="${PROJECT:-firewatch}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -f .env ] || echo "note: no app/.env, so the firefly will be offline on the deployed site."

echo "Building (VITE_DATA_SERVER=same-origin)..."
VITE_DATA_SERVER=same-origin npm run build

# Sanity: without VITE_DATA_SERVER the data-server branch is tree-shaken out, so the presence
# of one of its paths is what proves the build will call /api. (Don't test for the string
# "same-origin" — it is in the bundle either way, from a dependency.)
grep -roq -- "/cwfis/hotspots" dist/assets/*.js || {
  echo "Build is not wired to /api — VITE_DATA_SERVER did not take. Not uploading."; exit 1; }

echo "Uploading to Cloudflare Pages project '$PROJECT'..."
npx wrangler pages deploy dist --project-name "$PROJECT"
