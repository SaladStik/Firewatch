# EMBER//GRID

Wildfire risk intelligence on a 3D hex grid, built entirely on open data. Alberta, British Columbia and Saskatchewan load side by side; the provinces in focus render at full strength and the rest are slightly greyed.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ (deploy anywhere; set BASE=/sub/path/ for sub-path hosting)
npm test             # unit tests for the risk math (node:test via tsx)
npm run bake -- alberta       # terrain + land-cover raster for a region
npm run bake:osm -- alberta   # OSM rivers, roads, rail, bridges, buildings, places for a region
```

The baked files for all three provinces ship in `public/data/`, so you only need the bake scripts to add a province or refresh data. Downloads are cached in `scripts/.cache`. The public Overpass servers can be busy; the OSM bake retries across mirrors.

**Controls:**
- Left-drag pans; right-drag, middle-drag or Ctrl+drag rotates and tilts; scroll zooms toward the cursor.
- Click a hex to inspect it. Clicking a greyed province brings it into focus.
- The **Explore** panel has two tabs:
  - **Regions:** choose which provinces are in focus.
  - **Places:** search every community and click one to fly there.
  - It also sets label density. **Auto** (the default) shows major cities from afar and adds smaller towns as you zoom in; All / Some / Major / Off are fixed settings.
- The **Light / Dark** button switches between the dark theme and a government-style light theme.
- The **Forecast** bar switches the map between today and each of the next 7 days, and lists the communities most at risk that day (one per weather cell). Fires stay as observed now.
- `?focus=ab,bc` opens with specific provinces in focus.

## Data sources

All data is openly licensed and free, with no API keys. **Baked** data is downloaded once by the build scripts (`npm run bake`, `npm run bake:osm`) and ships as static files in `public/data/<region>/`. **Live** data is fetched by the browser and refreshed every 10 minutes (weather at most hourly).

### Baked

| Data | Source | Licence | How we use it |
|---|---|---|---|
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Tilezen/Mapzen Terrarium; in Canada built from NRCan CDEM, SRTM and others: [source list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | Open, attribution required ([details](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | Zoom-8 tiles (~350 m) resampled to a 500 m raster; hex heights |
| Land cover | [ESA WorldCover 2021 v200](https://esa-worldcover.org/en) ([AWS mirror](https://registry.opendata.aws/esa-worldcover-vito/)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 10 m classes, majority-voted per 500 m pixel; hex land types |
| Province boundary | [click_that_hood `canada.geojson`](https://github.com/codeforgermany/click_that_hood) | Open-source repository (MIT) | Region mask and border line |
| Buildings, rivers, roads, rail | [OpenStreetMap](https://www.openstreetmap.org/copyright) via the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Rivers become true-width channels on hex tops; roads and rail become hex connections; building heights and footprints become towers |
| Community names and populations | [OpenStreetMap](https://www.openstreetmap.org/copyright) (`place=city/town`) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Map labels and quick-jump |
| Landmark positions | [OpenStreetMap](https://www.openstreetmap.org/copyright), looked up by name | [ODbL](https://opendatacommons.org/licenses/odbl/) | Positions of hand-drawn wireframe landmark models (the shapes are our own) |

### Live

| Data | Source | Licence | How we use it |
|---|---|---|---|
| Satellite fire hotspots (last 24 h) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/), Natural Resources Canada ([datamart](https://cwfis.cfs.nrcan.gc.ca/datamart)); detections from MODIS/VIIRS/SLSTR satellites | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Burning hexes, beacons, hotspot list, proximity risk |
| Fire perimeters (current season) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/) M3 perimeters | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Active-perimeter and burn-scar hexes, burned-area total |
| Weather (today + 7-day forecast as daily peaks: temperature, humidity, wind speed and direction; live current conditions; 14 days of rain history) | [Open-Meteo](https://open-meteo.com/) | Data [CC BY 4.0](https://open-meteo.com/en/license); free API for non-commercial use | 1.5° grid; Fosberg index per day, days since rain, wind direction for spread. Refreshed at most hourly |

### Not from a source (our own)

- **Risk score:** the **Fosberg Fire Weather Index** (Fosberg 1978: temperature, humidity and wind → 0–100) × a **dryness factor** (0.6 on a day with ≥ 2 mm of rain, rising to 1.0 after 14 dry days) × the fuel load of the land type, plus a **wind-shaped boost** near hotspots: 30 km in calm air, stretched up to ~51 km downwind and shrunk to ~9 km upwind in strong wind. Every day, including today, uses its daily peak (max temperature, min humidity, max wind, dominant direction). Code: `data/fosberg.ts`, `world/spread.ts`, `world/hazardField.ts`. The dryness factor and spread shape are our own; neither is the official Canadian Fire Weather Index.
- **Demo scenario:** simulated ignitions and a heatwave multiplier, labelled SIMULATION wherever it's shown.
- **Wireframe models:** tree, house and landmark shapes are drawn in code (`render/geometry.ts`).

### Attribution shown in the app

> Elevation: Tilezen/AWS Terrain Tiles · Land cover: ESA WorldCover 2021 (CC BY 4.0) · Map data © OpenStreetMap contributors (ODbL) · Fire data: CWFIS, Natural Resources Canada (OGL–Canada) · Weather: Open-Meteo (CC BY 4.0)

### Open-source software

[three.js](https://github.com/mrdoob/three.js/blob/dev/LICENSE) (MIT) · [React](https://github.com/facebook/react/blob/main/LICENSE) (MIT) · [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE) (MIT) · [Lucide](https://github.com/lucide-icons/lucide/blob/main/LICENSE) (ISC) · [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt) (OFL) · [geotiff.js](https://github.com/geotiffjs/geotiff.js/blob/master/LICENSE) (MIT) · [pngjs](https://github.com/pngjs/pngjs/blob/main/LICENSE) (MIT) · [GSAP](https://gsap.com/licensing/) (free "Standard No-Charge" licence, not OSI open source; it's only used for UI and camera tweens and is easy to swap out)

## Architecture

```
scripts/bake-terrain.ts   elevation + land cover → public/data/<region>/terrain.{png,json}
scripts/bake-osm.ts       OSM → public/data/<region>/{osm,places}.json
src/
  config/
    grid.ts               LOD levels (hex size, zoom thresholds, terraces, props/buildings on/off)
    regions.ts            ← everything province-specific + the workspace (which provinces load)
  hex/
    hexMath.ts            pure hex math (axial/offset, chunks, hashing), no three.js
    nodeTypes.ts          ← NODE REGISTRY: how each land type + hazard status looks
    overlayStyles.ts      ← when rivers/roads/rail/bridges/buildings appear and how they look
  geo/                    projection (km world space), land classes
  world/                  web worker: per-region rasters, turns OSM rivers/roads/rail into nodes, scores hazards
  render/
    materials.ts          instanced prism shader (per-pixel outlines, patterns, pulse)
    geometry.ts           unit prism + wireframe props, buildings, landmarks
    ChunkMesh.ts          one chunk → 1 hex draw call + 1 per prop/building kind
    HexWorld.ts           LOD switching, chunk streaming/LRU, node API, picking
    Scene.ts              camera/controls, bloom, beacons, labels
    nodeStyle.ts          type → status → override → styler resolution
  data/                   CWFIS, Open-Meteo, Fosberg index, hazard snapshot, places
  engine.ts               glue between scene, data and UI state
  ui/                     React HUD (Tailwind)
```

### Rivers, roads and rail are nodes

Rivers, roads and rail aren't drawn on top of the map; they are hexes. Every hex a river, road or railway passes through becomes a **River**, **Road** or **Rail** node. It has its own outline, colour, height, hazard status and click-to-inspect, like forest or grassland.

- **Rivers:** sit one terrace down as a channel. A river flowing into a lake merges with it into one water region.
- **Roads and rail:** where a road crosses a river, the road node wins, so it reads as a crossing. Buildings never stand on river, road or rail nodes.
- **Fidelity:** the finest zoom level uses hexes about 130 m across, so the Bow is about one hex wide and major roads form continuous one-hex chains.
- **Realism rule:** a feature only becomes nodes at a zoom level where its real width is at least 25% of the hex width (`NODE_MIN_WIDTH_FRACTION` in `hex/overlayStyles.ts`), so a 30 m road never shows up as a 1 km band. Widths come from OSM `width` tags where present, and otherwise from typical widths per road or river class (`LINE_STYLES`). The finest level shows every feature.
- **Buildings and landmarks:** each stands on the hex it's in, inherits that hex's height and fire status (a burning block turns red), and is dimmed with its region.

### Readability
- **Region borders.** Bright lines are drawn only where the neighbouring hex belongs to a different family or hazard state. Inside a region the grid is faint, so forests, towns, lakes and fire fronts read as shapes.
- **Contours.** A medium-strength line marks any edge where the neighbour is at least one terrace lower, like a topographic map. Walls stay darker than tops, so steps stay legible even inside fires.
- **Glow is reserved for hazards.** Bloom only picks up statuses with high `emphasis` (active fire, perimeter, high/extreme risk).

### Why it stays fast
- **Chunks are built off the main thread** in a worker and arrive as typed arrays (struct-of-arrays).
- **One draw call per chunk.** Hexes are instanced prisms, and the outlines are computed in the fragment shader from a hex distance field, so there is no line geometry and no extra draw calls.
- **Only one grid level is live at a time.** It's chosen by camera distance, and only chunks inside the view ring are shown. Chunks outside the ring fade to black, cached chunks are reused, and old ones are evicted.
- **Picking is analytic.** It ray-marches the height field with an O(1) lookup per cell, so there are no per-instance raycasts.
- **Restyling is cheap.** Hazard updates rewrite instance attributes in place.

## Regions and focus

- **Loading.** Every region in `WORKSPACE.regions` is loaded onto one map using one shared projection (`PROJECTION`). The focused ones load first, and the rest stream in behind.
- **Unfocused regions.** Hexes outside the focus keep all their data (fires, risk, rivers, buildings) but are pulled toward grey. The amount is set by `UNFOCUSED_STYLE` in `nodeTypes.ts`.
- **What follows focus.** The headline numbers, the brand title, the home view and the label emphasis all follow the focus.

## Customising nodes

**Restyle a land type or status.** Edit its entry in `src/hex/nodeTypes.ts`. The fields are:
- `line`: colour
- `fill`: face strength
- `emphasis`: brightness; above about 1 it glows, so keep ordinary land around 0.45
- `family`: types in the same family merge into one outlined region
- `pattern`: the surface pattern drawn on the top face
- `props`: 3D models placed on the hex, with a count and scale
- `fuel`: how readily it burns
- `pulse` and `lift`: for statuses

The legend reads from the same registry.

**Add a land type.** Add a value in `geo/landClass.ts`, add an entry in `NODE_TYPES`, then map it in the bake script.

**Add a prop model.** Add a builder in `render/geometry.ts` (`PROP_BUILDERS`) and reference it from a type's `props`.

**Change one node at runtime:**
```ts
engine.scene.world.setOverride(level, q, r, { line: "#7dd3ff", pulse: 0.6, lift: 0.15, status: NodeStatus.High });
engine.scene.world.setOverride(level, q, r, null); // clear
```

**Restyle many nodes by rule.** Install a styler; the layer toggles use this same hook:
```ts
engine.scene.world.setStyler((ctx, base) => ctx.risk > 0.9 ? { line: [1, 0, 1] } : undefined);
```

**Read a node:** `world.getNode(level, q, r)` or `world.nodeAt(x, z)` returns a `HexNodeInfo`.

**Real-world features.** River, Road and Rail node colours live in `NODE_TYPES` like any land type. `hex/overlayStyles.ts` controls:
- typical widths per river, road and rail class;
- the realism rule for when a feature becomes nodes;
- building brightness and the tower height threshold.

Landmarks (hand-drawn models for specific buildings) are listed per region in `config/regions.ts`.

**Grid tuning.** All of it is in `config/grid.ts`: hex sizes per level, zoom thresholds, chunk size, gap, view radius and cache size.

## Adding a province

1. Add an entry to `REGIONS` in `src/config/regions.ts`. You need a `boundaryName` that matches the provinces GeoJSON, a bbox, a raster resolution, and optionally landmarks and demo sites.
2. Run `npm run bake -- <id>` and `npm run bake:osm -- <id>`.
3. Add the id to `WORKSPACE.regions`.

Fires, weather, labels, borders, focus and the Explore menu all pick the new province up automatically.

## Firefly mascot (preview)

A fully customisable, individually animatable 2D mascot lives in `src/mascot/firefly/`. Try him at **`/firefly.html`**. For the full docs (config, pose fields, moods, controller API, emotes, the 3D transformation spin, recipes, extending), see **[src/mascot/firefly/README.md](src/mascot/firefly/README.md)**.

**Tours and tutorials:** press **Ctrl+Shift+F** on any page (dev builds, or add `?fireflydev`) to record the firefly flying around, talking and spotlighting UI. Copy the result as JSON and replay it with `playScript()` at any resolution. See **[src/mascot/firefly/script/README.md](src/mascot/firefly/script/README.md)**.

## Notes

- **Demo scenario** adds clearly flagged simulated ignitions plus a heatwave. It's meant for presentations when nothing is burning.
- In dev builds the engine and app state are exposed as `window.engine` and `window.app` for debugging, e.g. `engine.flyToLatLng(51.05, -114.07, 10)`.
