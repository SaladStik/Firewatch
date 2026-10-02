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

## 4. Build for production (optional)

```bash
VITE_DATA_SERVER=https://your-server.example npm run build   # leave the variable out to skip the server
npm run server                                               # serves dist/ and the data at http://localhost:8787
```

Or host the `dist/` folder on any static host.

Server settings (environment variables):
- `PORT`: the port to listen on (default `8787`).
- `FIREWATCH_PREWARM`: the provinces whose weather is kept fresh (default `alberta`).
