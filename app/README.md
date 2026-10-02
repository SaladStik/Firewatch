# EMBER//GRID

Wildfire risk intelligence on a 3D hex grid, built entirely on open data. It covers all of Canada: every province and territory gets the same treatment. Alberta loads first and is usable straight away, and the rest stream in behind it. The provinces in focus render at full strength and the rest are slightly greyed.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ (deploy anywhere; set BASE=/sub/path/ for sub-path hosting)
npm run bake -- alberta       # terrain + land-cover raster for a region
npm run bake:pbf -- alberta   # OSM (Geofabrik extract): every road, river, stream, rail line, town, building ≥4 storeys
npm run bake:all              # terrain for every province and territory
npm run bake:pbf              # OSM for every province and territory (needs `pip install osmium`; ~3 GB of downloads, cached)
```

The baked files for every region ship in `public/data/<region>/`, so you only need the bake scripts to add a province or refresh data. Downloads are cached in `scripts/.cache`. (`npm run bake:osm` is the older Overpass-API bake, kept as a fallback; the public Overpass servers couldn't handle full-Canada volumes.)

**Controls:**
- Left-drag pans; right-drag, middle-drag or Ctrl+drag rotates and tilts; scroll zooms toward the cursor.
- Click a hex to inspect it. Clicking a greyed province brings it into focus.
- The **Explore** panel has two tabs:
  - **Regions:** choose which provinces are in focus.
  - **Places:** search every community and click one to fly there.
  - It also sets label density. **Auto** (the default) shows major cities from afar and adds smaller towns as you zoom in; All / Some / Major / Off are fixed settings.
- The **Light / Dark** button switches between the dark theme and a government-style light theme.
- `?focus=ab,bc` opens with specific provinces in focus.

## Data sources

All data is openly licensed and free, with no API keys. **Baked** data is downloaded once by the build scripts (`npm run bake`, `npm run bake:pbf`) and ships as static files in `public/data/<region>/`. **Live** data is fetched by the browser and refreshed every 10 minutes.

### Baked

| Data | Source | Licence | How we use it |
|---|---|---|---|
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Tilezen/Mapzen Terrarium; in Canada built from NRCan CDEM, SRTM and others: [source list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | Open, attribution required ([details](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | Zoom 6–8 tiles (matched to each region's raster resolution) resampled to a 0.3–1.6 km raster; hex heights |
| Land cover | [ESA WorldCover 2021 v200](https://esa-worldcover.org/en) ([AWS mirror](https://registry.opendata.aws/esa-worldcover-vito/)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 10 m classes, majority-voted per raster pixel; hex land types (incl. ice / glacier, tundra, wetland) |
| Province & territory boundaries | [click_that_hood `canada.geojson`](https://github.com/codeforgermany/click_that_hood) | Open-source repository (MIT) | Region masks and border lines (all 13) |
| Roads (motorway → residential, plus forest / resource tracks), rivers, streams and canals, rail | [OpenStreetMap](https://www.openstreetmap.org/copyright), per-province extracts from [OpenStreetMap France](https://download.openstreetmap.fr/extracts/north-america/canada/) (fallback [Geofabrik](https://download.geofabrik.de/north-america/canada.html)), processed locally with [pyosmium](https://osmcode.org/pyosmium/) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Become River / Road / Rail hex nodes. All lines ship as 1° tiles fetched on demand at street zoom (the realism rule means they can't show further out); only rivers ≥ 50 m wide ship with each region |
| Buildings ≥ ~4 storeys | Same OSM extracts (`height` / `building:levels` tags) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Towers standing on their hexes |
| Community names and populations | Same OSM extracts (`place=city/town/village/hamlet`, `population`), clipped to each province's boundary | [ODbL](https://opendatacommons.org/licenses/odbl/) | Map labels, Places list and quick-jump |
| Landmark positions | [OpenStreetMap](https://www.openstreetmap.org/copyright), looked up by name | [ODbL](https://opendatacommons.org/licenses/odbl/) | Positions of hand-drawn wireframe landmark models (the shapes are our own) |

### Live

| Data | Source | Licence | How we use it |
|---|---|---|---|
| Satellite fire hotspots (last 24 h) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/), Natural Resources Canada ([datamart](https://cwfis.cfs.nrcan.gc.ca/datamart)); detections from MODIS/VIIRS/SLSTR satellites | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Burning hexes, beacons, hotspot list, proximity risk |
| Fire perimeters (current season) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/) M3 perimeters | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Active-perimeter and burn-scar hexes, burned-area total |
| Weather (temperature, humidity, wind, 72 h rain) | [Open-Meteo](https://open-meteo.com/) | Data [CC BY 4.0](https://open-meteo.com/en/license); free API for non-commercial use | 1° grid, turned into the weather part of the risk score |

### Not from a source (our own)

- **Risk score:** weather risk (hot/dry/windy, damped by recent rain) × fuel load of the land type, plus a boost within 30 km of a hotspot. It lives in `world/hazardField.ts` and `data/openMeteo.ts`. It is transparent and tweakable, but it is **not** the official Canadian Fire Weather Index.
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
  data/                   CWFIS, Open-Meteo, hazard snapshot, places
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
- **Chunks are built off the main thread** by a pool of web workers: up to 3, one per spare CPU core, each holding the region data. Chunks arrive as typed arrays.
- **One small draw per chunk.** Hex tops are instanced 4-triangle hexagons. **Walls are instanced separately, and only the walls that can actually be seen are included** (neighbour lower, or open edge), which removes most of the geometry. Outlines and patterns are computed in the fragment shader, so there's no line geometry.
- **Interior edges vanish at a distance.** Outlines between same-type, same-height hexes only appear when each hex is big on screen, and coarse levels have no gap between hexes.
- **The view drives streaming.**
  - The loaded area is pushed forward along the camera's view direction.
  - Off-screen chunks are never built.
  - The nearest chunks are built first.
- **Multi-resolution rings.** The active level is drawn near you, and up to `farRings` coarser levels are drawn in rings beyond it, each `farRingReach`× further out. You see the horizon at lower detail instead of paying for millions of tiny distant hexes. While a fine chunk is still loading, the coarse chunk under it stands in, so there are no holes.
- **Street-level data is lazy.** Every road, river, stream and rail line loads per 1° tile only when a street-zoom chunk needs it. Start-up carries only buildings, places and very wide rivers: about 1 MB of line data for all of Canada.
- **Full resolution, 4× MSAA.** The map is limited by draw calls (CPU), not pixels, so it always renders at native resolution. Lowering resolution only made it grainy.
- **Tight culling.** Each chunk's bounding sphere fits its real relief at the current height exaggeration, so off-screen chunks are skipped. Chunk matrices are frozen, so three.js doesn't walk thousands of meshes every frame.
- **Sub-pixel detail is dropped.** Trees, houses and buildings shrink out once they're under about 2 px. On the CPU, their whole draw calls are skipped for chunks where they'd be that small, and terrace outlines fade once hexes are only a few pixels wide. This removes the speckle at distance.
- **Labels only re-layout when the camera moves.** With 10k+ places this used to be about 20% of every frame.
- **Picking is analytic.** It ray-marches the height field with an O(1) lookup per cell.
- **Restyling is cheap.** Hazard updates rewrite instance attributes in place.

## Regions and focus

- **Coverage.** All 13 provinces and territories.
- **Load order.** Regions load in `WORKSPACE.regions` order, with focused regions always first: **AB → BC → SK → MB → ON → QC → NB → NS → PE → NL → YT → NT → NU**. Alberta is interactive as soon as it's in; the others appear as they arrive.
- **Projection.** Everything uses one shared projection (`PROJECTION`): Lambert conformal conic with Statistics Canada's national-map parameters (standard parallels 49° N and 77° N), so shapes hold up from BC to Newfoundland. Changing it means re-running `npm run bake:all`. OSM files store lat/lng and don't need re-baking.
- **Detail per region.** Raster resolution (`pxKm`) scales with region size: 0.3 km for PEI, 0.5 km for Alberta, up to 1.6 km for Nunavut. Source detail (elevation zoom, land-cover sampling) follows it.
- **Zoom levels.** A national level with ~38 km hexes shows the whole country, and the finer levels take over as you zoom in.
- **Heights.** Hex heights use a relief curve (`RELIEF_EXPONENT` = 1.3 in `config/grid.ts`), so high ground like the Rockies, Torngats and Arctic ice caps stands out from plateaus like the prairies. Vertical exaggeration (`verticalScale`) stays near-real close up (×4–7) and ramps to about ×40 at province view and about ×60 nationally. During the bake, elevation spikes are filtered out and values are capped at each region's official high point.
- **Weather.** Live weather is fetched only for regions **in focus**, hourly, at most ~90 points each, to stay inside Open-Meteo's free daily limit. Unfocused regions still show fires, perimeters and fuel-based risk.
- **The north reads as the north.** Land types come from ESA WorldCover. Ice caps and glaciers are **Ice / glacier** (pale ice with a cracked crosshatch), and moss/lichen is **Tundra**, its own region type, so the treeline is drawn as a border. Where land-cover data is missing in the far Arctic, hexes fall back to tundra, not grassland. The legend lists every land type.
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

**LOD tuner (dev).** Press **Ctrl+Shift+L** in dev builds, or on a page opened once with `?fireflydev`, to tune the map live:
- each level's switch distance, with a **go** button that flies the camera to it;
- switch hysteresis;
- render distance (view radius × camera distance, the max radius in hexes, plus the number of far rings and how far each reaches);
- height exaggeration (close / province / national, and the ramp curve).

A live readout shows the camera distance, active level, cell size, exaggeration, hex count and fps. Tweaks persist in that browser until **Reset**. **Copy config** copies paste-ready values for `config/grid.ts`. Hex sizes and terraces aren't live-editable; they're used by the worker, so change them in the file.

**Grid tuning.** All of it is in `config/grid.ts`: hex sizes per level, zoom thresholds, chunk size, gap, view radius and cache size.

## Adding a province

1. Add an entry to `REGIONS` in `src/config/regions.ts`. You need:
   - a `boundaryName` that matches the provinces GeoJSON;
   - the `iso` code (ISO 3166-2, used to find it in OSM);
   - a bbox and a raster resolution;
   - optionally landmarks and demo sites.
2. Run `npm run bake -- <id>` and `npm run bake:pbf -- <id>`. The Geofabrik extract name must match the region id (it does for every province and territory).
3. Add the id to `WORKSPACE.regions`, in the position you want it to load.

Fires, weather, labels, borders, focus and the Explore menu all pick the new province up automatically.

## Firefly mascot (preview)

A fully customisable, individually animatable 2D mascot lives in `src/mascot/firefly/`. Try him at **`/firefly.html`**. For the full docs (config, pose fields, moods, controller API, emotes, the 3D transformation spin, recipes, extending), see **[src/mascot/firefly/README.md](src/mascot/firefly/README.md)**.

**Tours and tutorials:** press **Ctrl+Shift+F** on any page (dev builds, or add `?fireflydev`) to record the firefly flying around, talking and spotlighting UI. Copy the result as JSON and replay it with `playScript()` at any resolution. See **[src/mascot/firefly/script/README.md](src/mascot/firefly/script/README.md)**.

## Notes

- **Demo scenario** adds clearly flagged simulated ignitions plus a heatwave. It's meant for presentations when nothing is burning.
- In dev builds the engine and app state are exposed as `window.engine` and `window.app` for debugging, e.g. `engine.flyToLatLng(51.05, -114.07, 10)`.
