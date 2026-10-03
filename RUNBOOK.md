# Runbook

How to run FIRE//WATCH from scratch.

## 1. Install

You need [Node.js](https://nodejs.org/) 22 or newer and Git.

```bash
git clone https://github.com/SaladStik/Firewatch.git
cd Firewatch/app
npm install
```

## 2. Run

```bash
npm run dev
```

Open http://localhost:5173. Your browser fetches the live fire and weather data itself.

## 3. Run with the data server (optional)

The data server fetches the live data once, caches it and gives the same copy to every visitor. This avoids the weather API's rate limits.

Terminal 1 (the server, http://localhost:8787):

```bash
npm run server
```

Terminal 2 (the app, pointed at the server):

```bash
# macOS / Linux / Git Bash
VITE_DATA_SERVER=http://localhost:8787 npm run dev

# Windows PowerShell
$env:VITE_DATA_SERVER="http://localhost:8787"; npm run dev
```

Without `VITE_DATA_SERVER`, the app ignores the server.

Check the server at http://localhost:8787/api/health.

### Firefly's AI model (optional)

Typed questions go to a model on Databricks Model Serving through the data server. Set these before `npm run server`:

```bash
# macOS / Linux / Git Bash
DATABRICKS_HOST=https://<workspace>.cloud.databricks.com DATABRICKS_TOKEN=<token> npm run server

# Windows PowerShell
$env:DATABRICKS_HOST="https://<workspace>.cloud.databricks.com"; $env:DATABRICKS_TOKEN="<token>"; npm run server
```

The endpoint defaults to `databricks-meta-llama-3-3-70b-instruct`. Set `FIREWATCH_AI_ENDPOINT` for another one. Check it at http://localhost:8787/api/ai.

## 4. Let other devices connect (optional)

Start the app with `--host`:

```bash
VITE_DATA_SERVER=http://localhost:8787 npm run dev -- --host
```

On the other devices, open the `Network:` address Vite prints, e.g. `http://192.168.1.144:5173`.

Those devices get their data through that same address, so they don't need to reach the data server themselves.

If Windows asks, allow Node.js through the firewall on private networks.

## 5. Build for production (optional)

One machine serves both the site and the data:

```bash
VITE_DATA_SERVER=same-origin npm run build   # the site and the data share one address
npm run server                               # devices open the "Other devices" address it prints (port 8787)
```

To host `dist/` somewhere else, build with the data server's public address instead, e.g. `VITE_DATA_SERVER=https://data.example.com`. Leave the variable out to build without the data server.

Server settings (environment variables):
- `PORT`: the port to listen on (default `8787`).
- `FIREWATCH_PREWARM`: the provinces whose weather is kept fresh (default `alberta`).

To run the data server on Databricks instead, see **[DEPLOY-DATABRICKS.md](DEPLOY-DATABRICKS.md)**.
