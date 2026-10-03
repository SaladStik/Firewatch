#!/usr/bin/env bash
# Deploy the FIRE//WATCH data server to Databricks Apps. See DEPLOY-DATABRICKS.md.
#
#   npm run deploy:databricks                 # app "firewatch-data" under your own user folder
#   APP=my-name npm run deploy:databricks     # a different app name
#
# Needs the Databricks CLI, authenticated once with:
#   databricks auth login --host https://<your-workspace-host>
set -euo pipefail

APP="${APP:-firewatch-data}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v databricks >/dev/null || { echo "The Databricks CLI isn't on PATH. See DEPLOY-DATABRICKS.md."; exit 1; }
databricks current-user me >/dev/null 2>&1 || {
  echo "Not authenticated. Run:  databricks auth login --host https://<your-workspace-host>"; exit 1; }

USER_NAME="$(databricks current-user me -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["userName"])')"
TARGET="${TARGET:-/Workspace/Users/$USER_NAME/$APP}"
echo "App:    $APP"
echo "Source: $TARGET"

# Create on the first run; leave an existing app alone.
if ! databricks apps get "$APP" >/dev/null 2>&1; then
  echo "Creating the app..."
  databricks apps create "$APP" --description "FIRE//WATCH data server"
fi

# The server needs server/ and the handful of files it imports from src/. public/ is ~900 MB of
# baked map data the API never touches, and node_modules/dist are rebuilt on the other side.
echo "Uploading source..."
databricks sync "$HERE" "$TARGET" --full \
  --exclude "public/**" \
  --exclude "node_modules/**" \
  --exclude "dist/**" \
  --exclude "tests/**" \
  --exclude "scripts/.cache/**" \
  --exclude "server/.cache/**"

echo "Deploying..."
databricks apps deploy "$APP" --source-code-path "$TARGET"

URL="$(databricks apps get "$APP" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"
echo
echo "Deployed. $URL"
echo "Check it:  curl -H \"Authorization: Bearer \$TOKEN\" $URL/api/health"
echo "Logs:      databricks apps logs $APP"
