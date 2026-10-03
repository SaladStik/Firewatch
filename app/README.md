# FIRE//WATCH

Wildfire risk intelligence on a 3D hex grid, built entirely on open data. It covers all of Canada: every province and territory gets the same treatment. Alberta loads first and is usable straight away, and the rest stream in behind it. The provinces in focus render at full strength and the rest are slightly greyed.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ (deploy anywhere; set BASE=/sub/path/ for sub-path hosting)
npm run server       # optional shared data server (http://localhost:8787); use it with VITE_DATA_SERVER=http://localhost:8787 npm run dev (see RUNBOOK.md)
npm test             # unit tests for the risk math (node:test via tsx)
npm run bake -- alberta       # terrain + land-cover raster for a region
npm run bake:pbf -- alberta   # OSM (Geofabrik extract): every road, river, stream, rail line, town, building ≥4 storeys
npm run bake:all              # terrain for every province and territory
npm run bake:pbf              # OSM for every province and territory (needs `pip install osmium`; ~3 GB of downloads, cached)
npm run bake:city -- calgary  # 20 m street-level raster for a city (src/config/cities.ts; no argument = every city)
```

The baked files for every region ship in `public/data/<region>/`, so you only need the bake scripts to add a province or refresh data. Downloads are cached in `scripts/.cache`. (`npm run bake:osm` is the older Overpass-API bake, kept as a fallback; the public Overpass servers couldn't handle full-Canada volumes.)

**Controls:**
- Left-drag pans; right-drag, middle-drag or Ctrl+drag rotates and tilts; scroll zooms toward the cursor.
- **Keyboard:** arrow keys drive the camera (**Up** goes the way you're facing, so it follows wherever you've turned), **Ctrl+arrows** orbit and tilt (**Ctrl+Right** turns the compass clockwise, **Ctrl+Up** lifts towards a bird's-eye view), and **+** / **−** zoom. Holding a key moves a little every frame rather than stepping once per press, and the speed scales with how far out you are, so it feels the same at every zoom. Tilt and zoom stop at the same limits the mouse has.
  - **Shift+arrows** do the same as Ctrl+arrows, because macOS claims all four Ctrl+arrows for Mission Control and Spaces before the page ever sees them.
  - Arrows are ignored while you're typing in a panel, and the key map plus its maths are in `render/cameraKeys.ts` (pure, no three.js, unit-tested).
- Click a hex to inspect it. Clicking a greyed province brings it into focus.
- The **Explore** panel has two tabs:
  - **Regions:** choose which provinces are in focus.
  - **Places:** search every community and click one to fly there.
  - It also sets label density. **Auto** (the default) shows major cities from afar and adds smaller towns as you zoom in; All / Some / Major / Off are fixed settings.
- The **Light / Dark** button switches between the dark theme and a government-style light theme.
- The **Forecast** bar switches the map between today and each of the next 7 days, and lists the **communities at risk** that day: only towns with a fire nearby, in a projected path, or under High fire weather, each with its reason (e.g. "fire 18 km W"). Fires stay as observed now.
- The **Wind** layer animates faint, continuous streams that curve with the wind (interpolated between the weather grid points). **Today uses the live measured wind**; later days use each day's peak wind. Streams float over the highest ground nearby so they don't zig-zag over mountains, and they never glow (`data/wind.ts`, `render/WindParticles.ts`).
- The **Rain & snow** layer animates falling rain wherever it's raining: Open-Meteo's **live precipitation** today, and each day's forecast total on later days. A soft blue wash marks the rain area on the ground, and the drops drift and lean with the same wind as the streams (`data/rain.ts`, `render/RainParticles.ts`).
  - **Snow:** where it's at or below freezing (all snow at ≤ 0 °C, all rain at ≥ 2 °C, mixed between; today by the live temperature, later days by the day's high) the same precipitation falls as slow, fluttering snowflakes that drift with the wind, over a white ground wash. Open-Meteo's precipitation already includes snow (as water), so snow lowers fire risk and slows spread exactly like rain.
- The **Projected spread** layer (violet hexes) shows where each active fire could reach by the selected forecast day (simulated fires too, in the demo scenario). The strip above the forecast bar lists communities inside that area. It's a simplified **scenario** model, not an official forecast (see below).
- `?focus=ab,bc` opens with specific provinces in focus.

## Firefly agent

Firefly, the mascot, is also a voice and text agent that flies over the map. Type in the bottom-left box or **hold the mic** to talk. He answers out loud, in his speech bubble, and in the history drawer. His brain and voice run on an **ElevenLabs Agent**. Everything he says comes from **client tools**, functions in the page that read the same app state the map shows (`src/firefly/tools.ts` → `src/firefly/facts.ts`).

What he can do:
- **Situation briefing:** what's burning, hotspots in the last 24 h, the biggest fires, threatened communities, the worst forecast day.
- **Place check:** a community's risk today and over the next 7 days, plus the best and worst day.
- **Fire dossier:** a fire's size, growth, and which communities its projected spread reaches, and when.
- **Explain why:** why a town or the selected hex is rated the way it is (fuel × fire weather × nearby fire).
- **Drive the map:** fly to places and fires, set the forecast day, toggle layers, turn the demo scenario on or off.
- **Proactive alerts:** a new fire, a town entering a projected path, or extreme danger tomorrow. He flies there and says so (`src/firefly/monitor.ts`).
- **Crew allocation:** "I have 3 crews, where?" or "rank the 2023 to 2025 fires for 40 crews, then cut 20%" ranks fires, compares with biggest-first and says who lost a crew (see [Dispatch](#dispatch-who-gets-the-next-crew)).
- **311 dispatch:** "plan Calgary 311 for a blizzard" or "what if a crew calls in sick" plans the city's crews and replans at noon.
- **Mood:** alert (red lantern) when a town is in a projected path, worried before an extreme day, curious when a town is listed, and idle when it's calm — idle is also where he starts.
- **Look:** `src/firefly.config.ts`, pasted out of the preview page's "copy config" (`/firefly.html`). The mascot module keeps its own default; this is the one the map applies.

Setup:
1. Create an agent in the ElevenLabs dashboard from [`src/firefly/AGENT.md`](src/firefly/AGENT.md): first message, system prompt, and the 13 client tools (names and parameters must match `tools.ts`).
2. Copy `app/.env.example` to `app/.env` and put its ID in: `VITE_ELEVENLABS_AGENT_ID=agent_…`, then restart `npm run dev`. Without it, the dock shows "Firefly is offline". `.env` is the only file it reads (Vite loads `.env` in every mode) and is gitignored, so the ID stays out of the repo.

Privacy: while a session is connected, typed text and voice go to ElevenLabs. The mic stays muted unless the talk button is held, though the browser asks for mic permission once when a session starts. The agent ID is public (no API key in the app); restrict it with the dashboard's host allowlist when deploying. Projected spread is a **scenario**, and Firefly says so.

## Dispatch: who gets the next crew

The **Dispatch** button (top bar) opens the IEEE YP Industry Hackathon 2026 cases inside the map. Firefly drives the same plans from Ask or voice (`plan_crews`, `plan_311`, `open_dispatch`). Method in plain terms: [src/dispatch/README.md](src/dispatch/README.md); full method and evaluation: [METHODOLOGY.md §13](METHODOLOGY.md#13-dispatch-who-gets-the-next-crew).

**Wildfire crews (Case 3).** Ranks fires for N crews, either today's live fires or Alberta's real 2023–2025 fire table. **Demo scenario** replays that table on the map.
- One-line score: `priority = size × spread × people × crown`. Spread is the faster of the observed rate and the FBP rate for that fuel and weather; people are towns and critical sites within 30 km.
- Baseline: biggest first. Cut crews by 20% (adjustable) and see which fires lost a crew, ringed red on the map.
- Improvement round: the weights are fitted on two seasons and tested on the third.
- Duty-officer paragraph, which Firefly reads out on request.

With 40 crews, cut to 32 (`npm run case:crews`):

| Plan | Crews | Escapes reached (of 156) |
|---|---|---|
| Biggest first | 40 | 15 |
| FIRE//WATCH | 40 | **28** |
| Biggest first, after the cut | 32 | 11 |
| FIRE//WATCH, after the cut | 32 | **21** |

**Calgary 311 (Case 1).** Plans Roads and Waste & Recycling crews for one day from Open Calgary tickets.
- Priority: `priority = 10 × safety × weather + 2 × days waiting + 3 × similar reports nearby`. Crews work a neighbourhood and batch similar jobs.
- Baseline: oldest first.
- Noon disruption: a **blizzard** (ice and snow calls jump; suggested automatically when our forecast shows snow in Calgary) or a **sick crew**, then a replan that counts jobs moved.
- **All tickets:** every ticket with its priority, crew and stop. Mark one **urgent** or **hold** it and the day replans.
- **Route planner:** each crew's drive from the depot through its stops along Calgary's real streets (OpenStreetMap), drawn on the map in the crew's colour, with the distance and minutes for each leg. **Shortest order** re-orders the stops for the least driving.
- Supervisor notes for 8 a.m. and noon.

With 8 crews × 5 jobs (`npm run case:311`): 25 safety jobs instead of 19, and 112 km of driving instead of 440.

```bash
npm run case:crews              # Case 3 report (40 crews, 20% cut); -- 30 25 for 30 crews, 25% cut
npm run case:311                # Case 1 report (blizzard at noon); -- sick for a sick crew
```

## Data sources

All data is openly licensed and free, with no API keys. **Baked** data is downloaded once by the build scripts (`npm run bake`, `npm run bake:pbf`) and ships as static files in `public/data/<region>/`. **Live** data is fetched by the browser and refreshed every 10 minutes (weather at most hourly, and only for provinces in focus).

### Baked

| Data | Source | Licence | How we use it |
|---|---|---|---|
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Tilezen/Mapzen Terrarium; in Canada built from NRCan CDEM, SRTM and others: [source list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | Open, attribution required ([details](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | Zoom 6–8 tiles (matched to each region's raster resolution) resampled to a 0.3–1.6 km raster; hex heights |
| Land cover | [ESA WorldCover 2021 v200](https://esa-worldcover.org/en) ([AWS mirror](https://registry.opendata.aws/esa-worldcover-vito/)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 10 m classes, majority-voted per raster pixel; hex land types (incl. ice / glacier, tundra, wetland) |
| Street-level city rasters (Calgary, Edmonton) | ESA WorldCover at its native 10 m (4-sample vote per 20 m pixel) and AWS Terrain Tiles at zoom 13 (~12 m) | as above | `public/data/<region>/cities/`: at street zoom (L5 and L6) the map samples land cover and elevation from these instead of the province's 500 m raster, so 38 m hexes follow real parks, rivers and blocks |
| Province & territory boundaries | [click_that_hood `canada.geojson`](https://github.com/codeforgermany/click_that_hood) | Open-source repository (MIT) | Region masks and border lines (all 13) |
| Roads (motorway → residential, plus forest / resource tracks), rivers, streams and canals, rail | [OpenStreetMap](https://www.openstreetmap.org/copyright), per-province extracts from [OpenStreetMap France](https://download.openstreetmap.fr/extracts/north-america/canada/) (fallback [Geofabrik](https://download.geofabrik.de/north-america/canada.html)), processed locally with [pyosmium](https://osmcode.org/pyosmium/) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Become River / Road / Rail hex nodes. All lines ship as 1° tiles fetched on demand at street zoom (the realism rule means they can't show further out); only rivers ≥ 50 m wide ship with each region |
| Buildings ≥ ~4 storeys | Same OSM extracts (`height` / `building:levels` tags) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Towers standing on their hexes |
| Highway traffic volumes (measured) | [Alberta Transportation and Economic Corridors](https://open.alberta.ca/) — [traffic volumes on links in the highway network](https://open.alberta.ca/dataset/traffic-volumes-on-links-in-the-highway-network) (annual and summer average daily traffic, vehicle classification, per traffic control section) and [traffic volumes at points on the highway](https://open.alberta.ca/dataset/traffic-volumes-at-points-on-the-highway) (the 2016–2025 AADT history) | [Open Government Licence – Alberta](https://open.alberta.ca/licence) | How busy each highway is, how much of that is commercial, and how fast it is growing — the volume side of "Corridors at risk" |
| Highway geometry | [Government of Alberta GeoSpatial](https://geospatial.alberta.ca/titan/rest/services/transportation/access_facility_roads/MapServer) (`transportation/access_facility_roads`, primary + secondary highways with their highway numbers) | [Open Government Licence – Alberta](https://open.alberta.ca/licence) | Where those highways run: joined to the volumes above on the highway number, then resampled to a point every 2 km |
| Community names and populations | Same OSM extracts (`place=city/town/village/hamlet`, `population`), clipped to each province's boundary | [ODbL](https://opendatacommons.org/licenses/odbl/) | Map labels, Places list and quick-jump |
| Landmark positions | [OpenStreetMap](https://www.openstreetmap.org/copyright), looked up by name | [ODbL](https://opendatacommons.org/licenses/odbl/) | Positions of hand-drawn wireframe landmark models (the shapes are our own) |

### Live

| Data | Source | Licence | How we use it |
|---|---|---|---|
| Satellite fire hotspots (last 24 h) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/), Natural Resources Canada ([datamart](https://cwfis.cfs.nrcan.gc.ca/datamart)); detections from MODIS/VIIRS/SLSTR satellites | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Burning hexes, beacons, hotspot list, proximity risk |
| Fire perimeters (current season) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/) M3 perimeters (`public:m3_polygons_current`) | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Active-perimeter and burn-scar hexes, burned-area total |
| Fire weather stations: observed FWI moisture codes (FFMC, DMC, DC) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/) `public:firewx_stns_current` | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Seeds the FWI System per weather cell with official values (with the FWI codes CWFIS attaches to each hotspot). Refreshed at most hourly |
| Fire growth history (per fire) | [CWFIS](https://cwfis.cfs.nrcan.gc.ca/) hotspot archive (`public:hotspots`, every detection since 2012), queried per active perimeter since its start date | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) | Each fire's daily burned-area growth; calibrates how far that fire is projected to spread. Fetched for active fires in focused provinces, at most hourly |
| Weather (12:00 local hourly temperature, humidity and wind for the FWI System; daily peaks and rain totals; 14 past days + today + 7-day forecast; live current conditions incl. wind and precipitation) | [Open-Meteo](https://open-meteo.com/) | Data [CC BY 4.0](https://open-meteo.com/en/license); free API for non-commercial use | 1.5° grid (coarser for very large provinces, ≤ ~90 points each), focused provinces only; Canadian FWI System per day (with Fosberg for comparison), wind direction for spread, live wind and rain animation. Refreshed at most hourly |

### Case data (bundled, `public/data/cases/`)

| Data | Source | Licence | How we use it |
|---|---|---|---|
| Alberta wildfires 2023–2025 (856 fires: all size class C/D/E plus a sample of A/B) | [Historical wildfire data 2006–2025](https://open.alberta.ca/opendata/wildfire-data), Government of Alberta, via the hackathon's Case 3 seed | [Open Government Licence – Alberta](https://open.alberta.ca/licence) | Crew ranking and its evaluation; the demo scenario's fires |
| Calgary 311 service requests (200-ticket sample) | [Open Calgary 311 Service Requests](https://data.calgary.ca/Services-and-Amenities/311-Service-Requests/iahh-g8bj), via the hackathon's Case 1 seed | Open Government Licence – City of Calgary | 311 dispatch, ticket list |

### Data server (optional)

By default every visitor's browser fetches the live data above itself. Running `npm run server` (`server/index.ts`, port 8787) and starting or building the app with `VITE_DATA_SERVER=<server address>` changes that:
- The server fetches each source once and the app reads only from the server (`src/data/liveData.ts`).
  - CWFIS fire data covers all of Canada and refreshes every 10 minutes.
  - Stations, weather and fire history refresh hourly.
  - Weather is fetched per province when first requested. `FIREWATCH_PREWARM` (default `alberta`) lists the provinces kept warm.
- The server caches everything in memory and in `server/.cache/`, so the data survives restarts.
- Every visitor sees the same data, and the Open-Meteo quota is spent once rather than once per browser.
- If a source fails or rate-limits, the server keeps serving the last good copy and waits 5 minutes before retrying.
- The server computes FWI seeding with the same code as the browser (`src/data/fwiSeed.ts`).
- **Many devices at once:**
  - Each data set is serialised and gzipped once per refresh, not per request.
  - Every response carries an ETag, so a device that already has the latest copy gets an empty 304.
  - Stale data is served instantly while one background refresh runs.
  - Simultaneous requests share one upstream fetch.
  - Upstream calls are queued: one Open-Meteo request and two hotspot-archive queries at a time. However many devices connect, the sources see the same traffic.
  - Perimeter outlines are rounded to about 1 m, which is a third smaller to send.
  - Only known province and fire ids are accepted, and old fire histories are dropped, so memory stays bounded.
  - Load test: 300 devices booting at once (5,100 requests) all succeeded, with each data set fetched from its source once.
- **Addresses:**
  - In dev, the page calls its own `/api`, and Vite forwards that to `VITE_DATA_SERVER`. Phones and other computers on the network only need to reach the dev server (`npm run dev -- --host`).
  - In a build, the page calls `<VITE_DATA_SERVER>/api`. Use `same-origin` when the data server also serves the built site from `dist/`, which it does whenever a build exists.

Baked data — terrain, land cover, roads, places and **traffic volumes** — is not affected by any of this. It ships with the site and is served from the same address as the page in both modes, so there is no traffic endpoint on the data server; only the live sources below are routed through it.

Hosting it on Databricks needs a few extra parts (an app can't be reached anonymously, so the
site proxies to it): see **[DEPLOY-DATABRICKS.md](../DEPLOY-DATABRICKS.md)**.

API endpoints:
- `/api/health`
- `/api/cwfis/hotspots`
- `/api/cwfis/perimeters`
- `/api/cwfis/stations`
- `/api/weather/<region id>`
- `/api/fire-history/<perimeter id>`

### Not from a source (our own)

How every risk, projection and warning is worked out (Canadian FWI and FBP Systems, fuel-aware growth, per-fire calibration, communities at risk, limitations and references) is documented in **[METHODOLOGY.md](METHODOLOGY.md)**. In short:
- **Fire danger:** the Canadian **FWI System** (Van Wagner 1987) from Open-Meteo 12:00 weather, seeded with CWFIS's observed moisture codes (stations, and CWFIS's FWI grids at hotspots), rated in the standard 5 danger classes. Fosberg is shown alongside for comparison with the sensor station.
- **Hex risk:** FWI-based weather risk × the land type's fuel load, plus a proximity boost near fires (our heuristic).
- **Projected spread:** FBP System rates of spread by fuel type (ST-X-3 / GLC-X-10), grown hex by hex over the real land cover with minimum travel time (Finney 2002): spreads in every direction through fuel, faster downwind and upslope, stops at water and rock.
- **Per-fire calibration:** each fire's observed growth from the CWFIS hotspot archive vs. the model on the same days' weather scales its projection.
- **Communities at risk:** only towns with a fire nearby, in a projected path, or under Very High fire danger.
- **Corridors at risk:** highways with a fire inside the same wind-shaped reach used everywhere else, ranked by how much traffic that stretch is expected to carry on the chosen day. Volumes are Alberta's own measurements; the seasonal swing comes from its annual-vs-summer averages and the year-on-year change from its published history. Where along a highway each measured section sits is not published, so the measured average is spread along the route by population accessibility and held inside the highway's own measured range.
- **Traffic in the demo scenario:** a long-weekend demand multiplier, the threatened towns' people leaving on the highways, fire closing those highways, and the congestion that follows — drawn as vehicles on the road at street zoom. All assumptions, all scenario-only, and none of it touches fire behaviour.
- **Demo scenario:** simulated ignitions, a heatwave multiplier, and a **rainstorm** (75 km radius) that starts over a demo fire site and drifts downwind ~55 km/day with the real wind while weakening. The storm damps risk under it (up to ×0.15) and slows any fire it covers. Everything simulated is labelled SIMULATION. Code: `data/hazards.ts`, `data/rain.ts`.
- **Wireframe models:** tree, house and landmark shapes are drawn in code (`render/geometry.ts`).

### Attribution shown in the app

> Elevation: Tilezen/AWS Terrain Tiles · Land cover: ESA WorldCover 2021 (CC BY 4.0) · Map data © OpenStreetMap contributors (ODbL) · Fire data: CWFIS, Natural Resources Canada (OGL–Canada) · Weather: Open-Meteo (CC BY 4.0) · Traffic volumes and highway geometry: Government of Alberta (OGL–Alberta)

### Open-source software

[three.js](https://github.com/mrdoob/three.js/blob/dev/LICENSE) (MIT) · [React](https://github.com/facebook/react/blob/main/LICENSE) (MIT) · [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE) (MIT) · [Lucide](https://github.com/lucide-icons/lucide/blob/main/LICENSE) (ISC) · [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt) (OFL) · [geotiff.js](https://github.com/geotiffjs/geotiff.js/blob/master/LICENSE) (MIT) · [pngjs](https://github.com/pngjs/pngjs/blob/main/LICENSE) (MIT) · [GSAP](https://gsap.com/licensing/) (free "Standard No-Charge" licence, not OSI open source; it's only used for UI and camera tweens and is easy to swap out)

## Architecture

```
scripts/bake-terrain.ts   elevation + land cover → public/data/<region>/terrain.{png,json}
scripts/bake-osm.ts       OSM → public/data/<region>/{osm,places}.json
scripts/bake_traffic.py   provincial traffic counts + highway geometry → public/data/<region>/traffic.json
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
- **Realism rule:** a feature only becomes nodes at a zoom level where its real width is at least 25% of the hex width (`NODE_MIN_WIDTH_FRACTION` in `hex/overlayStyles.ts`), so a 30 m road never shows up as a 1 km band. Widths come from OSM `width` tags where present, and otherwise from typical widths per road or river class (`LINE_STYLES`). The two street levels (L5, 130 m hexes, and L6, 38 m) show every feature; at L6 local streets also cut through town hexes, so the real street grid shows.
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

**Traffic volumes are per province and optional.** Every province publishes its traffic counts in its own format, under its own licence, so `scripts/bake_traffic.py` has one adapter per province; Alberta's is written. To add another, write a `fetch_<region>()` that returns the measured volumes per highway number, the year-on-year trend and that highway's geometry, and register it in `ADAPTERS`. Then run `npm run bake:traffic -- <id>` (it needs `pip install openpyxl`, and `npm run bake:pbf` first, because the volumes are spread along each route using the baked community list). A province with no adapter ships no `traffic.json`, and the app simply lists no corridors for it — nothing else changes.

## Loading screen (test page)

The boot screen is **FIRE//WATCH**: a fire lookout tower that draws itself as the app loads (legs, bracing, platform, cab, roof, antenna). The firefly (the standard mascot, small) flies up around the tower in a smooth spiral as loading progresses, with a short fading comet tail. When loading finishes he reaches the top and lights the tower: a flash at the beacon, then the cab windows glow and the beacon sweeps. A **system check** frame ticks off what's loading: terrain, roads and towns, live fires, weather and forecast, fire danger, fire growth. Open **`/loading.html`** to replay it as often as you like. Its controls are replay, load time, a progress scrubber, loop, firefly on/off, error state and light theme. Code: `src/ui/loading/LoadingScreen.tsx` (used by the app's boot overlay) and `src/ui/loading/preview.tsx` (the test page).

## Firefly mascot (preview)

A fully customisable, individually animatable 2D mascot lives in `src/mascot/firefly/`. Try him at **`/firefly.html`**. For the full docs (config, pose fields, moods, controller API, emotes, the 3D transformation spin, recipes, extending), see **[src/mascot/firefly/README.md](src/mascot/firefly/README.md)**.

**Tours and tutorials:** press **Ctrl+Shift+F** on any page (dev builds, or add `?fireflydev`) to record the firefly flying around, talking and spotlighting UI. Copy the result as JSON and replay it with `playScript()` at any resolution. See **[src/mascot/firefly/script/README.md](src/mascot/firefly/script/README.md)**.

## Notes

- **Demo scenario** adds clearly flagged simulated ignitions, a heatwave and a drifting rainstorm. It's meant for presentations when nothing is burning.
- In dev builds the engine and app state are exposed as `window.engine` and `window.app` for debugging, e.g. `engine.flyToLatLng(51.05, -114.07, 10)`.
