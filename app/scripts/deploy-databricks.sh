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

# Free Edition stops an app's compute a day after it starts ("stopped due to workspace or
# account status"), and `apps deploy` refuses to run against a stopped app. Start it and wait.
state() { "${DBX[@]}" apps get "$APP" -o json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("compute_status") or {}).get("state","?"), ((d.get("active_deployment") or {}).get("status") or {}).get("state","NONE"))' 2>/dev/null; }
read -r compute deploy_state <<<"$(state)"
if [ "$compute" != "ACTIVE" ]; then
  echo "Compute is $compute — starting the app..."
  "${DBX[@]}" apps start "$APP" >/dev/null 2>&1 || true
fi
# `apps start` deploys the previously synced source itself, and a second deploy on top of a
# pending one is rejected, so wait for whatever is in flight to finish.
for _ in $(seq 1 80); do
  read -r compute deploy_state <<<"$(state)"
  [ "$compute" = "ACTIVE" ] && { [ "$deploy_state" = "SUCCEEDED" ] || [ "$deploy_state" = "FAILED" ] || [ "$deploy_state" = "NONE" ]; } && break
  sleep 15
done
echo "Compute $compute, last deployment $deploy_state."

# Stage exactly what the server needs, rather than uploading the whole app.
#
# Databricks runs `npm run build` by itself whenever package.json has a build script, and that
# build has no business running here: this app serves the API, the website is on Cloudflare
# Pages. It also cannot succeed — src/ui/InstrumentData.tsx imports
# ../../../wildfire/instruments.json, which lives outside app/ and so is not in the upload, so
# `tsc -b` fails and takes the whole deployment with it. Staging a package.json with no build
# script means the step never runs.
#
# src/ is copied whole because the server imports a dozen modules from it and tsx only
# compiles what it actually loads; public/ (~900 MB of baked map data the API never touches),
# node_modules, dist, tests and the Cloudflare function are all left out.
# Staged outside the repository on purpose: `databricks sync` honours .gitignore, so a staging
# directory inside app/ would have to be either committed or silently excluded from its own
# upload.
STAGE="$(mktemp -d -t firewatch-deploy)"
trap 'rm -rf "$STAGE"' EXIT
echo "Staging the server..."
cp -R "$HERE/server" "$HERE/src" "$STAGE/"
rm -rf "$STAGE/server/.cache"
cp "$HERE/app.yaml" "$HERE/package-lock.json" "$STAGE/"
python3 - "$HERE/package.json" "$STAGE/package.json" <<'PYEOF'
import json, sys
pkg = json.load(open(sys.argv[1]))
pkg["scripts"] = {k: v for k, v in pkg["scripts"].items() if k == "server"}
json.dump(pkg, open(sys.argv[2], "w"), indent=2)
PYEOF

# Clear the target first. `sync` keys its snapshot to the source directory, so pointing it at a
# new one leaves every file from a previous upload behind — including the old package.json,
# which is exactly the build script this staging exists to avoid. The folder is ours and is
# rebuilt on every deploy, so removing it is safe.
echo "Uploading source..."
"${DBX[@]}" workspace delete "$TARGET" --recursive >/dev/null 2>&1 || true
"${DBX[@]}" sync "$STAGE" "$TARGET" --full

echo "Deploying..."
"${DBX[@]}" apps deploy "$APP" --source-code-path "$TARGET"

URL="$("${DBX[@]}" apps get "$APP" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"
echo
echo "Deployed. $URL"
echo "Check it:  curl -H \"Authorization: Bearer \$TOKEN\" $URL/api/health"
echo "Logs:      databricks ${PROFILE:+--profile $PROFILE }apps logs $APP"
