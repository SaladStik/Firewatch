/**
 * Scores the live Calgary 311 queue's sites in a worker thread, so the data server's event loop
 * keeps answering requests while ~25,000 tickets are placed on Calgary's street network and
 * checked against schools, crossings, slope and 311 history (server/index.ts).
 * The street network and context are built once and kept for every refresh.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import { PROJECTION } from "../src/config/regions";
import { CityContext, type CityContextFile, type Site } from "../src/dispatch/cityContext";
import { loadLive311, type Row311 } from "../src/dispatch/ops311";
import { RoadGraph } from "../src/dispatch/router";
import { setProjection } from "../src/geo/projection";

setProjection(PROJECTION);
const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
let scorer: { city: CityContext; roads: RoadGraph } | null = null;

function build() {
  const city = new CityContext(JSON.parse(readFileSync(join(pub, "cases", "calgary_context.json"), "utf8")) as CityContextFile);
  const idx = JSON.parse(readFileSync(join(pub, "alberta", "lines", "index.json"), "utf8")) as { q: number; tiles: string[] };
  const tiles = ["50_-115", "50_-114", "51_-115", "51_-114"].filter((n) => idx.tiles.includes(n)).map((n) => JSON.parse(readFileSync(join(pub, "alberta", "lines", `${n}.json`), "utf8")));
  return { city, roads: new RoadGraph(tiles, idx.q, [-114.40, 50.80, -113.80, 51.26]) };
}

parentPort!.on("message", (m: { id: number; rows: Row311[]; fetchedAt: string }) => {
  try {
    scorer ??= build();
    const { city, roads } = scorer;
    const sites: Record<string, Site> = {};
    for (const t of loadLive311(m.rows, m.fetchedAt).open) sites[t.id] = city.site(t, t.approx ? null : (la, ln) => roads.roadAt(la, ln));
    parentPort!.postMessage({ id: m.id, sites });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: (e as Error).message });
  }
});
