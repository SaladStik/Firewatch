/**
 * Per-community facts for Calgary 311 dispatch, added to public/data/cases/calgary_context.json.
 *
 * Open Calgary publishes 311 locations only to the community's centre point (the address stays in
 * the city's work-order system), so a ticket's "where" is its community. This measures each
 * community (Open Calgary Community District Boundaries, surr-xmvs) from the context's own data:
 * schools, childcare, seniors' homes, hospitals and fire stations inside it, crosswalks, signals and
 * transit stops per km², its population density and how hilly it is.
 *
 * Run after scripts/bake_calgary_311.py:  npx tsx scripts/bake-calgary-communities.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTION } from "../src/config/regions";
import { CityContext, type CityContextFile, type CommunityStats } from "../src/dispatch/cityContext";
import { project, setProjection } from "../src/geo/projection";

setProjection(PROJECTION);
const ROOT = join(import.meta.dirname, "..");
const FILE = join(ROOT, "public/data/cases/calgary_context.json");
const CACHE = join(ROOT, "scripts/.cache/calgary_communities.json");

type Ring = [number, number][];
interface Row { name: string; class: string; multipolygon: { coordinates: Ring[][] } }

const rows: Row[] = existsSync(CACHE)
  ? JSON.parse(readFileSync(CACHE, "utf8"))
  : await (await fetch("https://data.calgary.ca/resource/surr-xmvs.json?$limit=1000")).json();
writeFileSync(CACHE, JSON.stringify(rows));

const file = JSON.parse(readFileSync(FILE, "utf8")) as CityContextFile;
const city = new CityContext(file);

const inRing = (r: Ring, x: number, y: number) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPoly = (polys: Ring[][], lng: number, lat: number) => polys.some((p) => inRing(p[0], lng, lat) && !p.slice(1).some((h) => inRing(h, lng, lat)));
/** Area in km² (projected shoelace). */
const area = (polys: Ring[][]) => polys.reduce((t, p) => t + p.reduce((u, ring, k) => {
  const pts = ring.map(([ln, la]) => project(la, ln));
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z);
  return u + (k === 0 ? 1 : -1) * Math.abs(a / 2);
}, 0), 0);

const communities: Record<string, CommunityStats> = {};
for (const r of rows) {
  const polys = r.multipolygon?.coordinates;
  if (!polys?.length || !r.name) continue;
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of polys) for (const [ln, la] of p[0]) { w = Math.min(w, ln); e = Math.max(e, ln); s = Math.min(s, la); n = Math.max(n, la); }
  const count = (kind: string) => (file.poi[kind] ?? []).filter(([la, ln]) => la >= s && la <= n && ln >= w && ln <= e && inPoly(polys, ln, la)).length;
  // Slope: sample a ~100 m lattice inside the community.
  const slopes: number[] = [];
  for (let la = s; la <= n; la += 0.0009) for (let ln = w; ln <= e; ln += 0.0014) {
    if (!inPoly(polys, ln, la)) continue;
    const v = city.slopeAt(la, ln);
    if (v != null) slopes.push(v);
  }
  slopes.sort((a, b) => a - b);
  const km2 = area(polys), pop = file.population[r.name] ?? 0;
  communities[r.name] = {
    kind: r.class, areaKm2: +km2.toFixed(2), population: pop, density: km2 > 0 ? Math.round(pop / km2) : 0,
    schools: count("school"), childcare: count("childcare"), seniors: count("seniors"), hospitals: count("hospital"), fireStations: count("fire_station"),
    crossingsPerKm2: km2 > 0 ? +((count("crossing") + count("signal")) / km2).toFixed(1) : 0,
    transitPerKm2: km2 > 0 ? +(count("transit") / km2).toFixed(1) : 0,
    slopeMean: slopes.length ? +(slopes.reduce((a, b) => a + b, 0) / slopes.length).toFixed(1) : 0,
    slopeSteepShare: slopes.length ? +(slopes.filter((v) => v >= 8).length / slopes.length).toFixed(2) : 0,
  };
}
file.communities = communities;
writeFileSync(FILE, JSON.stringify(file));
const vals = Object.values(communities);
console.log(`${vals.length} communities · e.g. INGLEWOOD`, communities.INGLEWOOD, "· steepest", Object.entries(communities).sort((a, b) => b[1].slopeMean - a[1].slopeMean).slice(0, 3).map(([k, v]) => `${k} ${v.slopeMean}%`).join(", "));
