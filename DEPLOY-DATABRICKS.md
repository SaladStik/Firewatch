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

Then authenticate once, which opens a browser:

```bash
databricks auth login --host https://<your-workspace-host>
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
npm run deploy:databricks          # or: APP=another-name npm run deploy:databricks
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

## 4. A service principal for the proxy

Create one, give it `CAN_USE` on the app, and keep its client id and secret. Tokens last about
an hour:

```bash
curl -X POST https://<workspace-host>/oidc/v1/token \
  -u "<client-id>:<client-secret>" \
  -d 'grant_type=client_credentials&scope=all-apis'
```

Use the Databricks SDK in the proxy rather than this by hand, so refreshing is taken care of.

## 5. The proxy, and pointing the site at it

One function at the site's own address, mounted on `/api/*`:

```js
export default async function handler(req, res) {
  const token = await getDatabricksToken();            // cache until ~5 min before it expires
  const upstream = `${process.env.APP_URL}${req.url}`; // req.url already starts with /api
  const r = await fetch(upstream, { headers: { Authorization: `Bearer ${token}` } });
  res.status(r.status);
  for (const h of ["content-type", "etag", "x-fetched-at", "content-encoding"]) {
    const v = r.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.send(Buffer.from(await r.arrayBuffer()));
}
```

Pass `etag` through in both directions and forward the browser's `if-none-match`: the data
server's bodyless 304s are most of what keeps it cheap, and a proxy that drops them throws that
away. Don't add a second cache with its own lifetime either — the server already serves stale
data instantly while one refresh runs behind it.

Then build the site so the page calls its own `/api`, which is now the proxy:

```bash
VITE_DATA_SERVER=same-origin npm run build
```

Visitors never see Databricks, there's no CORS, and the server's own ETag and
stale-while-revalidate behaviour is untouched.

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
