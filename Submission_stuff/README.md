# FIRE//WATCH

A wildfire watch for all of Canada that keeps running on its own. It pulls live satellite fires and weather, scores every hex with the Canadian Fire Weather Index, projects where each fire could spread, and tells you which communities and highways are in the way. A voice agent named Firefly flies the map, briefs the situation, and speaks up when something changes.

FIRE//WATCH is decision support built from open data. Projected spread is a labelled scenario that sits beside official alerts from provincial agencies.

## The problem

Wildfire information in Canada is public, and it is scattered. Satellite hotspots live in one federal feed. Weather lives in another. Fuel is a land-cover map. Highway traffic is a provincial spreadsheet. A person trying to answer a simple question — *what is burning, who is in the path, and where should the next crew go* — has to assemble that picture by hand, then rebuild it when the next satellite pass arrives.

The hard part is not drawing a map. The hard part is staying current, and turning a pile of feeds into a ranked decision without someone sitting on the refresh button.

## What it does on its own

Once the map is open, a watch loop runs without further input. Every ten minutes it fetches new fires. Weather, fire-weather stations, and each fire's growth history refresh on their own schedule. After every refresh the models recompute, the map restyles, and Firefly compares the new picture with the last one.

```
live feeds                models                         action
──────────                ──────                         ──────
CWFIS hotspots      →     Canadian FWI, seeded      →    hex risk, 7-day forecast
CWFIS perimeters    →     from official stations    →    communities at risk
hotspot archive     →     FBP spread, hex by hex    →    corridors at risk
Open-Meteo weather  →     calibrated per fire       →    Firefly flies and speaks
Alberta traffic     →     crew ranking              →    patrol flags
```

Nobody has to ask for the next update. The first load is silent on purpose: everything is new, so Firefly waits. After that, a change is an alert.

## Autonomous features

### 1. Continuous data watch

The engine schedules its own refreshes (`app/src/engine.ts`).

- Satellite hotspots and fire perimeters reload every 10 minutes for every loaded province.
- Weather reloads at most hourly, and only for provinces in focus, so the free weather quota is spent once.
- Fire-weather stations reseed the moisture codes on the same hourly clock.
- Each active fire's hotspot history is pulled and cached, then dropped when the fire is gone.
- A failed source keeps the last good copy. The next try waits instead of hammering the feed.
- Optional data server (`npm run server`) does this once for every visitor: one upstream fetch, gzipped responses, ETags, and a stale copy served while a refresh runs in the background.

### 2. Self-running fire models

Every number on the map is computed in the browser from the feeds above. The formulas are the national standards; the scheduling is ours. Detail is in [`app/METHODOLOGY.md`](app/METHODOLOGY.md).

- **Fire danger.** The Canadian FWI System runs day by day through 14 past days, today, and 7 forecast days. Today's moisture codes are seeded from CWFIS stations (or from the codes CWFIS attaches to hotspots) and the forecast continues from there. Danger falls into the standard five classes.
- **Hex risk.** Weather danger × the fuel load of that hex's land cover, raised near a fire. The boost is stretched downwind and shrunk upwind. Active fire and fresh perimeters override the score.
- **Projected spread.** The Canadian FBP System sets a rate of spread for each fuel type. Fire then grows hex by hex by minimum travel time: every direction through fuel, faster downwind and upslope, stopped by water, rock, and ice. The selected forecast day moves the front.
- **Per-fire calibration.** For each active perimeter the watch compares observed growth (new hotspot cells since the fire started) with what the same model predicted on the weather that actually happened. A fire that has been crawling is scaled down. A fire that has been running is scaled up. New clusters with no history stay at the uncalibrated rate.
- **Communities at risk.** Towns are listed only with a reason: a fire inside the wind-shaped reach, a town inside the projected path, or Very High fire danger. The reason is shown next to the name.
- **Corridors at risk.** Highways inside that same reach are ranked by how much traffic the stretch is expected to carry that day, from Alberta's measured volumes, seasonal swing, and year-on-year trend.
- **Air.** Smoke and air-quality readings update from the same fires, wind, and forecast day.

### 3. Firefly's own watch

Firefly is the mascot and the operator. After every data or forecast refresh he builds a small situation summary and diffs it against the previous one (`app/src/firefly/monitor.ts`).

He raises an alert, flies the camera there, and flies himself there, when:

- a new fire appears at least 10 km from every fire he already knew about;
- a community enters a projected path;
- a community is forecast to hit Extreme fire danger tomorrow.

Each alert is announced once per session. If a voice session is connected and he is not already speaking, he says it out loud. Otherwise the line stays in his speech bubble until someone asks.

His mood follows the situation on its own: alert when a town sits in a projected path, worried before an extreme day, curious when a town is listed, idle when it is calm. Idle is also where he starts.

### 4. An agent that acts on the map

Firefly answers by voice or text through an ElevenLabs agent. Facts come only from client tools that read the same state the map is showing (`app/src/firefly/tools.ts`). He is instructed to act: talking about a place or a fire moves the camera; a question about a future day sets the forecast first.

| Tool | What he does with it |
|---|---|
| `get_briefing` | Active fires, last-24 h hotspots, biggest fires, threatened communities, worst forecast day |
| `get_place_report` | One community across today and the next 7 days, including best and worst day |
| `list_fires` / `get_fire_details` | Size, growth, and which communities a fire's projected spread reaches, and on which day |
| `explain_location` | Why a town or the selected hex is rated the way it is |
| `plan_crews` | Given N crews, ranks fires by community exposure and growth and returns reasons |
| `fly_to` | Moves the camera and flies Firefly to a community or a fire |
| `set_forecast_day` | Switches the map between today and any of the next 7 days |
| `set_layer` | Shows or hides risk, fires, spread, air, traffic, wind, rain, beacons, glow |
| `set_regions` | Focuses, adds, or removes provinces, and flies there |
| `flag_patrol` | Drops a patrol marker on a community or a fire |
| `set_demo_mode` | Turns the labelled simulation on or off |

A local rule brain answers plain map commands without waiting on the voice model (`app/src/agent/rules.ts`): focus a province, jump to a day, toggle a layer, fly to a place, list threats, explain the selection. The same engine calls run either way.

Crew ranking is a worked example of the agent deciding, not just narrating. For each active fire it adds up nearby population, weights towns that sit in the projected path more heavily, and adds observed growth. Ask "I have 3 crews, where?" and the top three come back with the towns and the growth that put them there. He can then fly the route and flag each one for patrol.

### 5. A sensor station that polls itself

`wildfire/` is a separate research server for a local instrument. A background loop reads temperature and humidity from an Arduino (USB or Wi-Fi), fills wind from Open-Meteo when the station has none, and scores the Fosberg index the sensor was built around. Stale readings are dropped. Results are written to a local history the dashboard reads. The national map uses the Canadian FWI System; Fosberg is kept alongside so the station and the map can be compared.

### 6. A map that keeps up with the camera

The 3D hex grid covers all 13 provinces and territories. Alberta is interactive as soon as it loads; the rest stream in behind it. Chunks are built on web workers, only the visible ones, nearest first, with coarser rings toward the horizon. Street-level roads and rivers load per tile when the camera gets close enough for them to be real. Wind streams, rain, and snow follow the live wind and temperature for the day on screen. Labels thicken as you zoom in.

The demo scenario is there for a quiet day: simulated ignitions, a heatwave, and a rainstorm that starts over a fire and drifts downwind on the real wind, damping risk and slowing spread under it. Everything simulated is labelled.

## Run it

Full steps are in [`RUNBOOK.md`](RUNBOOK.md).

```bash
cd app
npm install
npm run dev          # http://localhost:5173
```

The browser fetches live fire and weather data itself. No API keys. For a shared cache across devices, run `npm run server` and point the app at it (see the runbook).

Voice: create the agent from [`app/src/firefly/AGENT.md`](app/src/firefly/AGENT.md), copy `app/.env.example` to `app/.env`, and set `VITE_ELEVENLABS_AGENT_ID`. Without it, typed map commands still go through the local rule brain, and the watch still raises alerts in the speech bubble.

## Where to read more

| Doc | What it covers |
|---|---|
| [`app/README.md`](app/README.md) | Controls, data sources and licences, architecture, adding a province |
| [`app/METHODOLOGY.md`](app/METHODOLOGY.md) | Every equation: FWI, FBP, calibration, communities, corridors |
| [`RUNBOOK.md`](RUNBOOK.md) | Install, data server, other devices, production |
| [`app/src/firefly/AGENT.md`](app/src/firefly/AGENT.md) | Firefly's prompt and tool contract |

## Data

All of it is open and free. Baked terrain, land cover, roads, places, and Alberta traffic ship with the site. Live fires come from CWFIS (Natural Resources Canada). Live weather comes from Open-Meteo. Elevation is AWS Terrain Tiles. Land cover is ESA WorldCover 2021.

> Elevation: Tilezen/AWS Terrain Tiles · Land cover: ESA WorldCover 2021 (CC BY 4.0) · Map data © OpenStreetMap contributors (ODbL) · Fire data: CWFIS, Natural Resources Canada (OGL–Canada) · Weather: Open-Meteo (CC BY 4.0) · Traffic volumes and highway geometry: Government of Alberta (OGL–Alberta)
