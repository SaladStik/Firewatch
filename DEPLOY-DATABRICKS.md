# Deploying the data server to Databricks

How to run the FIRE//WATCH data server (`app/server/index.ts`) as a Databricks App and point the
website at it. For the ordinary case — one machine serving both the site and the data — see
[RUNBOOK.md](RUNBOOK.md) instead; this is only worth the extra parts if Databricks is the
compute you have to use, or you need stable egress IPs.

## The shape of it

```
browser → your site's address ──/api/*──→ Databricks App (data server)
          static site + one proxy           service-principal token
```

Two facts decide this layout.

**A Databricks App can't be reached anonymously.** Every first request starts an OAuth exchange
with the control plane; anonymous access and bypassing SSO aren't supported. A browser on a
public site can't complete that — it has no Databricks session, and you don't control CORS on
the login endpoints. So something server-side has to hold the credential and forward: the proxy
in step 5. Putting the credential in front-end JavaScript would hand your workspace identity to
every visitor.

**The site itself is too big to go there.** The neat version would be to serve the site from the
same app — the data server already serves `dist/`, so one login would cover both and there'd be
no CORS at all. But `app/public/data` is about 900 MB of baked terrain and line tiles, which
would all have to sync into a Workspace folder. So the app carries the API only.

If every viewer is a signed-in Databricks user in your workspace, you can skip the proxy and let
them hit the app URL directly. Otherwise you need it.

## Before the first deploy

Install the Databricks CLI. Homebrew's `databricks/tap` is the documented route, but on a Mac
whose Xcode Command Line Tools are out of date `brew install` fails and asks you to reinstall
them; the release binary avoids that entirely:

```bash
ver=$(curl -s https://api.github.com/repos/databricks/cli/releases/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')
curl -sL -o /tmp/dbx.zip \
  "https://github.com/databricks/cli/releases/download/${ver}/databricks_cli_${ver#v}_darwin_arm64.zip"
unzip -oj /tmp/dbx.zip databricks -d ~/.local/bin && chmod +x ~/.local/bin/databricks
databricks --version
```

Then authenticate once, which opens a browser. Quote the host if it has a `?` in it:

```bash
databricks auth login --host "https://<your-workspace-host>?o=<workspace-id>"
```

It saves a profile named after the workspace (e.g. `dbc-16e256ad-ebf8`), **not** `DEFAULT`, so
pass that name to the deploy script or the CLI may not find the credentials:

```bash
PROFILE=dbc-16e256ad-ebf8 npm run deploy:databricks
```

## 1. What is already set up

Nothing in the server needs editing — these are in the repo:

- **`app/app.yaml`** — the start command and environment. `DATABRICKS_APP_PORT` is the only
  variable Databricks injects and is substituted into `command` at run time, so it becomes the
  server's `PORT`. It deliberately does **not** set `NODE_ENV=production`: `npm run server` runs
  through `tsx`, which is a devDependency, and Databricks skips devDependencies when `NODE_ENV`
  is production.
- **`FIREWATCH_CACHE_DIR`** — the disk cache is pointed at `/tmp/firewatch-cache`, because a
  container's app directory isn't a safe place to write. The cache is ephemeral: after a
  redeploy the server refetches each source once and is warm again.
- **`app/scripts/deploy-databricks.sh`** — creates the app on first run, uploads the source and
  deploys, behind `npm run deploy:databricks`.

## 2. Deploy

```bash
cd app
PROFILE=<your-profile> npm run deploy:databricks     # APP=another-name to rename it
```

It uploads `server/` and the handful of files the server imports from `src/`, leaving out
`public/` (~900 MB of baked map data the API never touches), `node_modules/`, `dist/` and
`tests/`. On success it prints the app's address; its output is on the **Logs** tab in the
workspace, or:

```bash
databricks apps logs firewatch-data
```

`/api/health` is the thing to check first — with a token, since the app is not anonymous:

```bash
curl -H "Authorization: Bearer $TOKEN" https://<app-url>/api/health
```

## 3. Let it reach its sources

The server fetches two hosts and nothing else. Allow them in a network policy:

- `cwfis.cfs.nrcan.gc.ca`
- `api.open-meteo.com`

Deploy it as an ordinary app, **not** in an App Space: those have no public internet egress at
all, so every source would fail.

### Firefly's AI model

The server also forwards Firefly's typed questions to a Model Serving endpoint (`server/ai.ts`).
On Databricks Apps it uses the app's own service principal (Databricks sets `DATABRICKS_HOST`,
`DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` for it), so nothing needs storing:

1. Serving → pick the endpoint (default `databricks-meta-llama-3-3-70b-instruct`; set
   `FIREWATCH_AI_ENDPOINT` in `app.yaml` for another, e.g. a Claude endpoint) → Permissions → give
   the app's service principal **Can query**. Or add it as an app resource (Serving endpoint,
   Can query) under the app's settings.
2. Redeploy, then check `<app url>/api/ai`: `{"available": true, ...}`.

The Pages proxy forwards `POST /api/ai/chat` like any other API call.

## 4. A service principal for the proxy

`terraform/` does this — service principal, OAuth secret, and the `CAN_USE` grant on the app —
so the account console is not needed:

```bash
cd terraform
terraform init
terraform apply
terraform output -raw databricks_client_id
terraform output -raw databricks_client_secret
```

Everything in it is workspace-level, so the `databricks auth login` from the top of this file is
enough: no account id, no second login. That works because
`databricks_service_principal_secret` accepts `api = "workspace"`.

Two things that are easy to get wrong, both of which produce a bare `401` that looks like a
broken token:

- **The principal needs `workspace_access`.** A freshly created service principal has no
  entitlements at all and cannot reach the workspace, so the app rejects it even with `CAN_USE`
  granted and a perfectly valid token. The Terraform sets it.
- **It needs `CAN_USE` on the app itself**, which is separate from the entitlement.

Terraform state holds the secret in plaintext, so `terraform/.gitignore` excludes the state
files. Re-running `apply` on a fresh checkout issues a new secret.

### Doing it by hand instead

Create one, give it `CAN_USE` on the app, and keep its client id and secret. Tokens last about
an hour:

```bash
curl -X POST https://<workspace-host>/oidc/v1/token \
  -u "<client-id>:<client-secret>" \
  -d 'grant_type=client_credentials&scope=all-apis'
```

**A personal access token will not work.** Databricks Apps reject PATs with a bare `401` and
accept only OAuth tokens, so the `client_credentials` exchange above is the only route — there
is no simpler credential to substitute.

To exercise the proxy before the service principal exists, set `DATABRICKS_TOKEN` to the output
of `databricks auth token` and run it locally:

```bash
cd app
npx wrangler pages dev dist \
  --binding DATABRICKS_APP_URL=https://<app-url> \
  --binding DATABRICKS_TOKEN="$(databricks auth token -p <profile> | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
curl -s localhost:8788/api/health
```

That is local-only: those tokens last about an hour, so the environment variable is no use in
production.

## 5. The website on Cloudflare Pages

The site is static, so Pages serves it directly, and a single Pages Function forwards `/api/*`
to the app. The browser only ever talks to its own origin: no CORS, no login, and the data
server's ETags still work end to end.

`app/functions/api/[[path]].ts` is that function and is already in the repo. It mints a
service-principal token, caches it at module scope (they last about an hour, so no KV namespace
is needed), forwards `if-none-match` up and `etag` back, and deliberately does **not** pass
`content-encoding` or `content-length` through — the Workers runtime has already decompressed
the body, so repeating those headers would describe it wrongly.

### It fits, but only just worth checking

| | This site | Pages limit (free) |
|---|---|---|
| Files | 2,846 | 20,000 |
| Largest file | 6.3 MB (`british-columbia/terrain.png`) | 25 MiB |
| Total | ~916 MB | no documented cap |

### Build and upload it yourself

Prefer this over Pages' git integration: the baked map data makes the repo about a gigabyte, so
a clone-and-build in Pages' build container is slow and close to its time limit, and there is
nothing to gain from rebuilding remotely.

```bash
cd app
npm run deploy:pages               # PROJECT=another-name to rename it
```

That builds with `VITE_DATA_SERVER=same-origin` — which is what makes the page call its own
`/api` instead of the sources directly — checks the build actually came out that way, and
uploads `dist` with wrangler. Subsequent deploys only send files whose hashes changed, so the
first one is the slow one.

The check is worth knowing about: without `VITE_DATA_SERVER` the data-server branch is tree-shaken
out of the bundle entirely, so the script greps for one of its paths rather than for the string
`same-origin`, which is in the bundle either way and would pass on a wrong build.

If you would rather connect the git repository instead, the settings are: root directory `app`,
build command `npm run build`, output directory `dist`, and environment variables
`VITE_DATA_SERVER=same-origin`, `NODE_VERSION=22` (the project needs Node 22 or newer) and
`VITE_ELEVENLABS_AGENT_ID` — `app/.env` is gitignored, so a remote build has no other way to
learn the firefly's agent id.

### Secrets

In **Pages → Settings → Variables and Secrets**, for the production environment:

| Name | Value | Secret? |
|---|---|---|
| `DATABRICKS_HOST` | the workspace, e.g. `https://dbc-16e256ad-ebf8.cloud.databricks.com` | no |
| `DATABRICKS_APP_URL` | the app, e.g. `https://firewatch-data-7474655220625705.aws.databricksapps.com` | no |
| `DATABRICKS_CLIENT_ID` | the service principal's id | no |
| `DATABRICKS_CLIENT_SECRET` | the service principal's secret | **yes** |

### Two things to do once the domain exists

- **Lock the ElevenLabs agent down.** `app/.env` is gitignored, which keeps the agent id out of
  the repository but does *not* keep it private: Vite inlines it into the shipped JavaScript, so
  anyone can read it out of the deployed site. The host allowlist is the actual protection — add
  the Pages domain to the agent in the ElevenLabs dashboard, or anyone can run sessions on your
  account.
- **Check the whole chain**, not just the site: `/api/health` through the proxy should return
  `ok: true` with every source `fresh`. If the sources show errors, the app can reach the
  internet but not its upstreams — that is the egress policy in step 3, not the proxy.

## What to expect

- **Free Edition stops an app 24 hours after it starts**, which kills the background refresh. A
  long-running data server needs a paid tier.
- **The cache doesn't survive a redeploy.** `/tmp` is ephemeral, so a cold start means one round
  of upstream fetches before it's warm again. Nothing breaks.
- **2 vCPU and 6 GB** is the default compute, far more than this server uses.
- **Weather is fetched per province when first requested.** `FIREWATCH_PREWARM` lists the ones
  kept warm in the background; the default is `alberta`.

## Reference

[Databricks Apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/) ·
[deploy](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/deploy) ·
[app.yaml](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/app-runtime) ·
[dependencies](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/dependencies) ·
[sync](https://docs.databricks.com/aws/en/dev-tools/cli/reference/sync-commands) ·
[networking](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/networking) ·
[authorization](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth) ·
[permissions](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/permissions)
