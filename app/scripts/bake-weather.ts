/**
 * Bake a weather snapshot: public/data/weather/<region>.json, one grid per region.
 *
 * Used when there is no data server. Open-Meteo bills every coordinate in a request, and a
 * province is up to ~90 of them over a 22-day series, so one browser asking for all thirteen
 * provinces is thousands of billed calls in a few seconds — far past the free tier's
 * per-minute ceiling. The data server gets away with it by retrying over about fifteen
 * minutes; the pitch page, which reveals the whole country, cannot wait that long.
 *
 *   npm run bake:weather              every region, from Open-Meteo
 *   npm run bake:weather -- alberta   just one
 *
 * Open-Meteo's free tier also has a daily ceiling, and baking thirteen provinces a few times
 * reaches it — after which nothing more can be baked from that network until it resets. A
 * running data server has already fetched every grid, so it can be copied from there instead
 * at no cost to the quota:
 *
 *   FROM_SERVER=https://my-data-server npm run bake:weather
 *   FROM_SERVER=https://…databricksapps.com SERVER_TOKEN=$(databricks auth token -p … | jq -r .access_token) npm run bake:weather
 *
 * Re-bake it the morning of a demo: it is a snapshot, so it ages. The app prefers live weather
 * and only falls back to this, so a stale file never overrides a working source.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGIONS, WORKSPACE } from "../src/config/regions";
import { fetchWeatherGrid } from "../src/data/openMeteo";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "weather");
/** Gap between provinces. The ceiling is per minute, and one province is a few hundred calls. */
const GAP_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Copy the grids a running data server already holds, instead of asking Open-Meteo again. */
const FROM_SERVER = (process.env.FROM_SERVER ?? "").trim().replace(/\/+$/, "");
const SERVER_TOKEN = (process.env.SERVER_TOKEN ?? "").trim();

async function fromServer(id: string) {
  const res = await fetch(`${FROM_SERVER}/api/weather/${encodeURIComponent(id)}`, {
    headers: SERVER_TOKEN ? { Authorization: `Bearer ${SERVER_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`data server ${res.status}`);
  const grid = (await res.json()) as { cells?: unknown[] };
  // A server that has not warmed this province yet answers with something unusable, and saving
  // that would be worse than having no snapshot: the app would stop falling back to live.
  if (!Array.isArray(grid.cells) || !grid.cells.length) throw new Error("not warm on the server yet");
  return grid as never;
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : [...WORKSPACE.regions];
mkdirSync(OUT, { recursive: true });

let done = 0, failed: string[] = [];
for (const [i, id] of ids.entries()) {
  const region = REGIONS[id];
  if (!region) { console.warn(`  ${id}: not a region, skipping`); continue; }
  if (i && !FROM_SERVER) await sleep(GAP_MS); // a server's copies are already paid for
  try {
    // No FWI seed here on purpose: the seed comes from stations that change hourly, and the app
    // re-seeds from live stations when it has them. The snapshot is the weather, not the codes.
    const grid = FROM_SERVER ? await fromServer(id) : await fetchWeatherGrid(region.bbox);
    const path = join(OUT, `${id}.json`);
    writeFileSync(path, JSON.stringify(grid));
    done++;
    console.log(`  ${id}: ${grid.cells.length} cells, ${grid.dates.length} days`);
  } catch (e) {
    failed.push(id);
    console.warn(`  ${id}: ${(e as Error).message}`);
  }
}
console.log(`\n${done}/${ids.length} baked into public/data/weather/.`);
if (failed.length) {
  console.warn(`Rate-limited or failed: ${failed.join(", ")}. Re-run for just those in a few minutes:`);
  console.warn(`  npm run bake:weather -- ${failed.join(" ")}`);
  process.exit(1);
}
