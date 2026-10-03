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

# `databricks auth login` names the profile after the workspace, not DEFAULT, so pass it
# through rather than relying on the CLI picking the right one:
#   PROFILE=dbc-xxxxxxxx-xxxx npm run deploy:databricks
DBX=(databricks)
[ -n "${PROFILE:-}" ] && DBX+=(--profile "$PROFILE")

command -v databricks >/dev/null || { echo "The Databricks CLI isn't on PATH. See DEPLOY-DATABRICKS.md."; exit 1; }
"${DBX[@]}" current-user me >/dev/null 2>&1 || {
  echo "Not authenticated. Run:  databricks auth login --host https://<your-workspace-host>"
  echo "Already logged in? The profile may not be DEFAULT; pass it: PROFILE=<name> npm run deploy:databricks"
  exit 1; }

USER_NAME="$("${DBX[@]}" current-user me -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["userName"])')"
TARGET="${TARGET:-/Workspace/Users/$USER_NAME/$APP}"
echo "App:    $APP"
echo "Source: $TARGET"

# Create on the first run; leave an existing app alone.
if ! "${DBX[@]}" apps get "$APP" >/dev/null 2>&1; then
  echo "Creating the app..."
  "${DBX[@]}" apps create "$APP" --description "FIRE//WATCH data server"
fi

# The server needs server/ and the handful of files it imports from src/. public/ is ~900 MB of
# baked map data the API never touches, and node_modules/dist are rebuilt on the other side.
echo "Uploading source..."
"${DBX[@]}" sync "$HERE" "$TARGET" --full \
  --exclude "public/**" \
  --exclude "node_modules/**" \
  --exclude "dist/**" \
  --exclude "tests/**" \
  --exclude "scripts/.cache/**" \
  --exclude "server/.cache/**" \
  --exclude "functions/**" \
  --exclude "wrangler.toml"

echo "Deploying..."
"${DBX[@]}" apps deploy "$APP" --source-code-path "$TARGET"

URL="$("${DBX[@]}" apps get "$APP" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"
echo
echo "Deployed. $URL"
echo "Check it:  curl -H \"Authorization: Bearer \$TOKEN\" $URL/api/health"
echo "Logs:      databricks ${PROFILE:+--profile $PROFILE }apps logs $APP"
