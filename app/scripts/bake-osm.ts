/**
 * Bakes OpenStreetMap vector data for a region (ODbL — © OpenStreetMap contributors).
 *
 *   buildings : notable buildings (≥ ~4 storeys) → [lat, lng, heightM, widthKm, depthKm]
 *   lines     : rivers, roads, railways, bridges → simplified polylines
 *   places    : cities + towns with population (labels)        → places.json
 *   landmarks : positions of the region's configured landmarks  → places.json
 *
 * Output: public/data/<region>/{osm,places}.json      Run: npm run bake:osm -- <region-id>
 * Responses are cached in scripts/.cache (delete to refresh).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGIONS } from "../src/config/regions.ts";
import { LineKind } from "../src/geo/lineKinds.ts";

const ROOT = join(import.meta.dirname, "..");
const CACHE = join(ROOT, "scripts/.cache");
mkdirSync(CACHE, { recursive: true });
const regionId = process.argv[2] ?? "alberta";
const REGION = REGIONS[regionId];
if (!REGION) throw new Error(`Unknown region "${regionId}"`);
const AREA = `area["name"="${REGION.boundaryName}"]["admin_level"="4"]->.a;`;

// ---------------------------------------------------------------- overpass
const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

interface OsmElement {
  type: string;
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: { lat: number; lon: number }[];
}

async function overpass(name: string, body: string): Promise<OsmElement[]> {
  const file = join(CACHE, `osm_${REGION.id}_${name}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).elements;
  const query = `[out:json][timeout:600];${AREA}${body}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of MIRRORS) {
      try {
        process.stdout.write(`overpass ${name} @ ${new URL(url).host} ... `);
        const r = await fetch(url, {
          method: "POST",
          headers: { "User-Agent": "embergrid-bake/0.1", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }),
        });
        if (r.ok) {
          const text = await r.text();
          writeFileSync(file, text);
          console.log(`${(text.length / 1e6).toFixed(1)} MB`);
          return JSON.parse(text).elements;
        }
        console.log(r.status);
      } catch (e) {
        console.log(String(e));
      }
    }
    await new Promise((res) => setTimeout(res, 8000 * (attempt + 1)));
  }
  throw new Error(`Overpass failed for ${name}`);
}

// ---------------------------------------------------------------- geometry
const KM_LAT = 110.574;
/** Douglas–Peucker in local km space. */
function simplify(pts: [number, number][], tolKm: number): [number, number][] {
  if (pts.length < 3) return pts;
  const kx = 111.32 * Math.cos((pts[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a][0] * kx, ay = pts[a][1] * KM_LAT, bx = pts[b][0] * kx, by = pts[b][1] * KM_LAT;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bestD = tolKm;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] * kx - ax) * dy - (pts[i][1] * KM_LAT - ay) * dx) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

interface OutLine {
  k: LineKind;
  /** Width in km (rivers). */
  w?: number;
  n?: string;
  /** Flat [lng, lat, lng, lat, ...]. */
  p: number[];
}

function toLines(els: OsmElement[], kindOf: (t: Record<string, string>) => LineKind | null, tolKm: number, widthOf?: (t: Record<string, string>) => number): OutLine[] {
  const out: OutLine[] = [];
  for (const e of els) {
    if (!e.geometry || e.geometry.length < 2) continue;
    const t = e.tags ?? {};
    const k = kindOf(t);
    if (k === null) continue;
    const pts = simplify(e.geometry.map((g) => [g.lon, g.lat] as [number, number]), tolKm);
    const line: OutLine = { k, p: pts.flatMap(([lng, lat]) => [r5(lng), r5(lat)]) };
    if (widthOf) line.w = +widthOf(t).toFixed(3);
    if (t.name && (k === LineKind.RiverMajor || k === LineKind.Bridge)) line.n = t.name;
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- buildings
function heightOf(t: Record<string, string>): number | null {
  const h = parseFloat((t.height ?? "").replace(/[^\d.]/g, ""));
  if (Number.isFinite(h) && h > 0) return h;
  const lv = parseFloat(t["building:levels"] ?? "");
  return Number.isFinite(lv) && lv > 0 ? lv * 3.5 : null;
}

const buildingEls = await overpass("buildings", `(
  way["building"]["building:levels"~"^([4-9]|[1-9][0-9]+)$"](area.a);
  way["building"]["height"~"^([1-9][2-9]|[2-9][0-9]|[1-9][0-9][0-9])"](area.a);
  relation["building"]["building:levels"~"^([4-9]|[1-9][0-9]+)$"](area.a);
  relation["building"]["height"~"^([1-9][2-9]|[2-9][0-9]|[1-9][0-9][0-9])"](area.a);
);out bb tags;`);
const buildings: number[][] = [];
for (const e of buildingEls) {
  const t = e.tags ?? {}, b = e.bounds;
  if (!b || t["man_made"]) continue;
  const h = heightOf(t);
  if (!h || h < 12 || h > 400) continue;
  const lat = (b.minlat + b.maxlat) / 2, lng = (b.minlon + b.maxlon) / 2;
  const w = (b.maxlon - b.minlon) * 111.32 * Math.cos((lat * Math.PI) / 180), d = (b.maxlat - b.minlat) * KM_LAT;
  if (w > 0.6 || d > 0.6) continue;
  buildings.push([r5(lat), r5(lng), Math.round(h), +w.toFixed(3), +d.toFixed(3)]);
}
buildings.sort((a, b) => b[2] - a[2]);

// ---------------------------------------------------------------- lines
const MAJOR_RIVER = /^(Bow|Elbow|Athabasca|Peace|North Saskatchewan|South Saskatchewan|Red Deer|Oldman|Milk|Smoky|Hay|Slave|Wapiti|McLeod|Pembina|Clearwater|Battle|Highwood|Sheep|Belly|St\. Mary|Waterton|Wabasca|Birch|Christina|Beaver|Brazeau|Little Smoky|Berland|Wildhay|Sturgeon|Lesser Slave|Fraser|Thompson|North Thompson|South Thompson|Columbia|Kootenay|Skeena|Nass|Stikine|Liard|Nechako|Kettle|Okanagan|Similkameen|Chilcotin|Quesnel|Churchill|Qu'Appelle|Assiniboine|Souris|Carrot|Saskatchewan|Fond du Lac|Clearwater|Beaver|Red Deer|Frenchman) River$/;

const riverEls = await overpass("rivers", `(way["waterway"="river"](area.a););out geom;`);
const rivers = toLines(
  riverEls,
  (t) => (MAJOR_RIVER.test(t.name ?? "") ? LineKind.RiverMajor : LineKind.River),
  0.04,
  (t) => {
    const w = parseFloat(t.width ?? "");
    if (Number.isFinite(w) && w > 3 && w < 1000) return w / 1000;
    return MAJOR_RIVER.test(t.name ?? "") ? 0.09 : 0.035;
  },
);

const roadEls = await overpass("roads", `(way["highway"~"^(motorway|trunk|primary|secondary)$"](area.a););out geom;`);
const roads = toLines(roadEls, (t) => {
  if (t.bridge && t.bridge !== "no") return LineKind.Bridge;
  if (t.tunnel && t.tunnel !== "no") return null;
  return t.highway === "motorway" || t.highway === "trunk" ? LineKind.Highway : t.highway === "primary" ? LineKind.Primary : LineKind.Secondary;
}, 0.025);

const railEls = await overpass("rail", `(way["railway"="rail"]["usage"~"main|branch"](area.a);way["railway"="light_rail"](area.a););out geom;`);
const rail = toLines(railEls, (t) => (t.bridge && t.bridge !== "no" ? LineKind.Bridge : LineKind.Rail), 0.03);

// Pedestrian / landmark bridges (e.g. Calgary's Peace Bridge) — short, so keep them all.
const footBridgeEls = await overpass("footbridges", `(way["bridge"]["highway"~"^(footway|cycleway|path|pedestrian)$"]["name"](area.a););out geom;`);
const footBridges = toLines(footBridgeEls, () => LineKind.Bridge, 0.005);

const lines = [...rivers, ...roads, ...rail, ...footBridges];

// ---------------------------------------------------------------- places + landmarks
const placeEls = await overpass("places", `(node["place"~"^(city|town)$"]["name"](area.a););out tags center;`);
const places = placeEls
  .map((e) => {
    const el = e as OsmElement & { lat?: number; lon?: number; center?: { lat: number; lon: number } };
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    const pop = parseInt((e.tags?.population ?? "").replace(/[^\d]/g, ""), 10);
    return lat === undefined || lng === undefined ? null : {
      name: e.tags!.name, lat: r5(lat), lng: r5(lng),
      pop: Number.isFinite(pop) ? pop : e.tags!.place === "city" ? 50_000 : 2_000,
    };
  })
  .filter((p): p is { name: string; lat: number; lng: number; pop: number } => !!p)
  .sort((a, b) => b.pop - a.pop);

const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lmNames = REGION.landmarks.map((l) => esc(l.name)).join("|");
const lmEls = lmNames ? await overpass("landmarks", `(nwr["name"~"^(${lmNames})$"](area.a););out tags center;`) : [];
const landmarkPos: Record<string, [number, number]> = {};
for (const e of lmEls) {
  const el = e as OsmElement & { lat?: number; lon?: number; center?: { lat: number; lon: number } };
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon, name = e.tags?.name;
  // Prefer ways/relations (building outlines) over stray nodes.
  if (name && lat !== undefined && lng !== undefined && (!landmarkPos[name] || e.type !== "node")) landmarkPos[name] = [r5(lat), r5(lng)];
}
for (const l of REGION.landmarks) if (!landmarkPos[l.name]) console.warn(`landmark not found in OSM: ${l.name} (using config position)`);
const dir = join(ROOT, "public/data", REGION.id);
mkdirSync(dir, { recursive: true });
const json = JSON.stringify({ attribution: "© OpenStreetMap contributors (ODbL)", buildings, lines });
writeFileSync(join(dir, "osm.json"), json);
writeFileSync(join(dir, "places.json"), JSON.stringify({ attribution: "© OpenStreetMap contributors (ODbL)", places, landmarks: landmarkPos }));
console.log(`places: ${places.length} · landmarks located: ${Object.keys(landmarkPos).length}/${REGION.landmarks.length}`);
const count = (k: LineKind) => lines.filter((l) => l.k === k).length;
console.log(`${REGION.id}: ${buildings.length} buildings · rivers ${count(LineKind.RiverMajor)}+${count(LineKind.River)} · roads ${count(LineKind.Highway)}/${count(LineKind.Primary)}/${count(LineKind.Secondary)} · rail ${count(LineKind.Rail)} · bridges ${count(LineKind.Bridge)} · ${(json.length / 1e6).toFixed(2)} MB`);
