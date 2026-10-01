/**
 * Bakes Alberta open data into a single raster the browser can sample fast.
 *
 *   Elevation  : AWS Terrain Tiles (Terrarium, Mapzen/Tilezen)  — public, no key
 *   Land cover : ESA WorldCover 2021 v200 (10 m COG on AWS)     — CC-BY 4.0
 *   Boundary   : Alberta provincial boundary GeoJSON
 *
 * Output: public/data/<region>/terrain.png  (R,G = elevation m, B = land class, A = 255)
 *         public/data/<region>/terrain.json (raster metadata + projected border)
 *
 * Run: npm run bake -- <region-id>     (default: alberta; tiles cached in scripts/.cache)
 * Regions are defined in src/config/regions.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { fromUrl } from "geotiff";
import { project, setProjectionCenter, unproject } from "../src/geo/projection.ts";
import { PROJECTION, REGIONS } from "../src/config/regions.ts";
import { LandClass } from "../src/geo/landClass.ts";

const ROOT = join(import.meta.dirname, "..");
const CACHE = join(ROOT, "scripts/.cache");
const regionId = process.argv[2] ?? "alberta";
const REGION = REGIONS[regionId];
if (!REGION) throw new Error(`Unknown region "${regionId}". Known: ${Object.keys(REGIONS).join(", ")}`);
setProjectionCenter(PROJECTION.lat0, PROJECTION.lng0); // shared by every region
const OUT = join(ROOT, "public/data", REGION.id);
mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });


const PROVINCES_URL = "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/canada.geojson";
const provinces = JSON.parse((await cached(PROVINCES_URL, "canada-provinces.geojson")).toString("utf8"));
type Ring = [number, number][];

async function cached(url: string, file: string): Promise<Buffer> {
  const p = join(CACHE, file);
  if (existsSync(p)) return readFileSync(p);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(p, buf);
  return buf;
}

// ESA WorldCover code -> our LandClass
const WC: Record<number, LandClass> = {
  10: LandClass.Forest, 20: LandClass.Shrub, 30: LandClass.Grass, 40: LandClass.Crop,
  50: LandClass.Urban, 60: LandClass.Rock, 70: LandClass.Snow, 80: LandClass.Water,
  90: LandClass.Wetland, 95: LandClass.Wetland, 100: LandClass.Tundra,
};

interface RasterSpec {
  outName: string;
  boundaryNames: string[];
  bbox: [number, number, number, number];
  PX_KM: number;
  DEM_ZOOM: number;
  /** WorldCover sampling step in degrees. */
  wcDeg: number;
}

async function bakeRaster({ outName, boundaryNames, bbox, PX_KM, DEM_ZOOM, wcDeg }: RasterSpec) {
  const [W0, S0, E0, N0] = bbox;

  // ---------------------------------------------------------------- boundary
  const rings: { x: number; z: number }[][] = [];
  for (const name of boundaryNames) {
    const feature = provinces.features.find((f: { properties: { name: string } }) => f.properties.name === name);
    if (!feature) throw new Error(`Boundary "${name}" not found in provinces GeoJSON`);
    const polys: Ring[][] = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [feature.geometry.coordinates];
    rings.push(...polys.flat().map((r) => r.map(([lng, lat]) => project(lat, lng))));
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) for (const p of r) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const PAD = 4;
  minX = Math.floor(minX - PAD); minZ = Math.floor(minZ - PAD);
  maxX = Math.ceil(maxX + PAD); maxZ = Math.ceil(maxZ + PAD);
  const W = Math.ceil((maxX - minX) / PX_KM);
  const H = Math.ceil((maxZ - minZ) / PX_KM);
  console.log(`${outName}: raster ${W}x${H} @ ${PX_KM} km`);

  const inside = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const z = minZ + (j + 0.5) * PX_KM;
    const xs: number[] = [];
    for (const r of rings) for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
      const a = r[i], b = r[k];
      if ((a.z > z) !== (b.z > z)) xs.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
    }
    xs.sort((a, b) => a - b);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - minX) / PX_KM - 0.5));
      const i1 = Math.min(W - 1, Math.floor((xs[s + 1] - minX) / PX_KM - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * W + i] = 1;
    }
  }

  // ---------------------------------------------------------------- elevation
  const lng2tx = (lng: number) => ((lng + 180) / 360) * 2 ** DEM_ZOOM;
  const lat2ty = (lat: number) => {
    const r = lat * (Math.PI / 180);
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** DEM_ZOOM;
  };

  const demTiles = new Map<string, Float32Array>();
  async function loadDemTiles() {
    const tx0 = Math.floor(lng2tx(W0 - 0.5)), tx1 = Math.floor(lng2tx(E0 + 0.5));
    const ty0 = Math.floor(lat2ty(N0 + 0.5)), ty1 = Math.floor(lat2ty(S0 - 0.5));
    const jobs: Promise<void>[] = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      jobs.push((async () => {
        const buf = await cached(
          `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_ZOOM}/${tx}/${ty}.png`,
          `dem_${DEM_ZOOM}_${tx}_${ty}.png`,
        );
        const png = PNG.sync.read(buf);
        const e = new Float32Array(256 * 256);
        for (let i = 0; i < e.length; i++) {
          e[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
        }
        demTiles.set(`${tx}/${ty}`, e);
      })());
    }
    await Promise.all(jobs);
    console.log(`dem tiles: ${demTiles.size}`);
  }

  function demAt(lat: number, lng: number): number {
    const fx = lng2tx(lng) * 256 - 0.5, fy = lat2ty(lat) * 256 - 0.5;
    const px = Math.floor(fx), py = Math.floor(fy);
    const tx = fx - px, ty = fy - py;
    const s = (x: number, y: number) => {
      const t = demTiles.get(`${Math.floor(x / 256)}/${Math.floor(y / 256)}`);
      return t ? t[(y & 255) * 256 + (x & 255)] : 0;
    };
    return (
      (s(px, py) * (1 - tx) + s(px + 1, py) * tx) * (1 - ty) +
      (s(px, py + 1) * (1 - tx) + s(px + 1, py + 1) * tx) * ty
    );
  }

  // ---------------------------------------------------------------- land cover
  const lcVotes = new Uint8Array(W * H * 16); // per pixel, per class counts (max 16 classes)

  async function loadLandCover() {
    const DEG_PER_SAMPLE = wcDeg;
    const tiles: [number, number][] = [];
    // WorldCover tiles are 3°×3°, named by their SW corner.
    for (let lat = Math.floor(S0 / 3) * 3; lat < N0; lat += 3) for (let lng = Math.floor(W0 / 3) * 3; lng < E0; lng += 3) tiles.push([lat, lng]);
    for (const [lat, lng] of tiles) {
      const cacheFile = join(CACHE, wcDeg === 0.00125 ? `wc_${lat}_${lng}.bin` : `wc_${lat}_${lng}_${wcDeg}.bin`);
      const n = Math.round(3 / DEG_PER_SAMPLE);
      let data: Uint8Array;
      if (existsSync(cacheFile)) {
        data = new Uint8Array(readFileSync(cacheFile));
      } else {
        const name = `N${String(lat).padStart(2, "0")}${lng < 0 ? "W" : "E"}${String(Math.abs(lng)).padStart(3, "0")}`;
        const url = `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;
        process.stdout.write(`worldcover ${name} ... `);
        try {
          const tiff = await fromUrl(url);
          const r = await tiff.readRasters({
            bbox: [lng, lat, lng + 3, lat + 3], width: n, height: n, resampleMethod: "nearest", interleave: true,
          });
          data = new Uint8Array(r as unknown as ArrayLike<number>);
        } catch {
          // WorldCover has no tiles over open ocean — treat as no data.
          console.log("no tile");
          data = new Uint8Array(n * n);
        }
        writeFileSync(cacheFile, data);
        console.log("ok");
      }
      // Vote into raster pixels.
      for (let j = 0; j < n; j++) {
        const la = lat + 3 - (j + 0.5) * DEG_PER_SAMPLE;
        for (let i = 0; i < n; i++) {
          const cls = WC[data[j * n + i]];
          if (!cls) continue;
          const p = project(la, lng + (i + 0.5) * DEG_PER_SAMPLE);
          const px = Math.floor((p.x - minX) / PX_KM), pz = Math.floor((p.z - minZ) / PX_KM);
          if (px < 0 || pz < 0 || px >= W || pz >= H) continue;
          const v = (pz * W + px) * 16 + cls;
          if (lcVotes[v] < 255) lcVotes[v]++;
        }
      }
    }
  }

  function landClassAt(idx: number): LandClass {
    const base = idx * 16;
    let total = 0, best = LandClass.Grass, bestN = -1;
    for (let c = 1; c < 16; c++) {
      const n = lcVotes[base + c];
      total += n;
      if (n > bestN) { bestN = n; best = c; }
    }
    // Settlements are small but matter most for fire response: promote them.
    if (total > 0 && lcVotes[base + LandClass.Urban] / total >= 0.2) return LandClass.Urban;
    return total ? best : LandClass.Grass;
  }

  await loadDemTiles();
  await loadLandCover();

  const png = new PNG({ width: W, height: H });
  let eMin = Infinity, eMax = -Infinity;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const idx = j * W + i;
    const { lat, lng } = unproject(minX + (i + 0.5) * PX_KM, minZ + (j + 0.5) * PX_KM);
    const e = Math.max(0, Math.round(demAt(lat, lng)));
    const cls = inside[idx] ? landClassAt(idx) : LandClass.None;
    if (inside[idx]) { eMin = Math.min(eMin, e); eMax = Math.max(eMax, e); }
    png.data[idx * 4] = e >> 8;
    png.data[idx * 4 + 1] = e & 255;
    png.data[idx * 4 + 2] = cls;
    png.data[idx * 4 + 3] = 255;
  }
  const out = PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
  writeFileSync(join(OUT, `${outName}.png`), out);

  // Simplified projected border for the outline overlay.
  const border = rings.map((r) => r.map((p) => [+p.x.toFixed(2), +p.z.toFixed(2)]));
  writeFileSync(
    join(OUT, `${outName}.json`),
    JSON.stringify({ width: W, height: H, pxKm: PX_KM, minX, minZ, elevMin: eMin, elevMax: eMax, border }),
  );
  console.log(`${outName}.png ${(out.length / 1e6).toFixed(2)} MB, elevation ${eMin}..${eMax} m`);
}

await bakeRaster({ outName: "terrain", boundaryNames: [REGION.boundaryName], bbox: REGION.bbox, PX_KM: REGION.pxKm, DEM_ZOOM: 8, wcDeg: 0.00125 });
