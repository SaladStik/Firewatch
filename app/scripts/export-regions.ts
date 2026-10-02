/** Writes the region list (from src/config/regions.ts) as JSON for the Python OSM bake. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGIONS, WORKSPACE } from "../src/config/regions.ts";
import { LineKind } from "../src/geo/lineKinds.ts";

const out = join(import.meta.dirname, ".cache");
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "regions.json"),
  JSON.stringify({
    order: WORKSPACE.regions,
    lineKinds: LineKind,
    regions: Object.fromEntries(
      Object.values(REGIONS).map((r) => [r.id, { id: r.id, name: r.name, iso: r.iso, boundaryName: r.boundaryName, bbox: r.bbox, landmarks: r.landmarks.map((l) => l.name) }]),
    ),
  }),
);
console.log(`regions.json: ${Object.keys(REGIONS).length} regions`);
