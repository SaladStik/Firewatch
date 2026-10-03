# How FIRE//WATCH reaches its conclusions

This document explains every number the map shows: where the data comes from, which algorithm turns it into a risk, a projection or a warning, and where we rely on an industry standard versus a choice of our own. Code paths are relative to `app/src`.

**The short version:**
- **Fire danger** is the **Canadian Forest Fire Weather Index (FWI) System**: the national standard, the same system the Canadian Wildland Fire Information System (CWFIS) and every provincial agency use. It's driven by real weather and seeded from CWFIS's own observed moisture codes.
- **Fire spread** uses the **Canadian Fire Behaviour Prediction (FBP) System** rates of spread for each fuel type. Fire grows hex by hex across the real land cover using a minimum-travel-time method (the approach behind FlamMap).
- **Each fire is calibrated** against its own satellite history, so a fire that has been crawling isn't projected to run, and vice versa.

Everything is a **decision-support view built from open data**. It is not an official forecast, and the projected spread is labelled a scenario wherever it appears.

---

## 1. The data

| What | Source | Used for |
|---|---|---|
| Weather: hourly temperature, humidity and wind (12:00 local), daily rain, 14 days of history plus 7-day forecast, live current conditions | [Open-Meteo](https://open-meteo.com/) (CC BY 4.0) | FWI System inputs, wind and rain layers |
| Observed FWI moisture codes (FFMC, DMC, DC) at fire weather stations | CWFIS `public:firewx_stns_current` (OGL–Canada) | Seeding the FWI System with official values |
| Satellite hotspots, last 24 h, with CWFIS's FWI codes at each one | CWFIS `public:hotspots_last24hrs` | Active fires, plus FWI seeding near fires |
| Fire perimeters (current season) | CWFIS `public:m3_polygons_current` | Fire extent, burned area, burn scars |
| Hotspot archive (every detection since 2012) | CWFIS `public:hotspots` | Each active fire's daily growth history |
| Land cover, 10 m | ESA WorldCover 2021 (CC BY 4.0) | Fuel type per hex |
| Elevation | AWS Terrain Tiles (Tilezen) | Slope effect on spread, the 3D map |
| Highway traffic volumes: annual and summer average daily traffic, vehicle classification, 2016-2025 history | Alberta Transportation and Economic Corridors (OGL-Alberta) | How busy each highway corridor is, and how that changes by season and year |
| Highway geometry with highway numbers | Government of Alberta GeoSpatial (OGL-Alberta) | Where those corridors run |

Sources, licences and how often each is refreshed are listed in the [README](README.md#data-sources).

---

## 2. Fire danger: the Canadian FWI System

**Standard:** Van Wagner (1987), *Development and Structure of the Canadian Forest Fire Weather Index System*, Forestry Technical Report 35. The equations follow the reference implementation (Van Wagner & Pickett 1985; the `cffdrs` R package, Wang et al. 2017). Code: `data/cffdrs.ts`.

**Inputs per day:** temperature, relative humidity and 10 m wind at **12:00 local time** (the standard observation time), and the day's rain.

**The six FWI values:**
- **Moisture codes**, which carry over from day to day:
  - **FFMC** (Fine Fuel Moisture Code): litter and fine fuels, which react within hours.
  - **DMC** (Duff Moisture Code): the loose organic layer, with a time lag of about 2 weeks.
  - **DC** (Drought Code): deep organic layers, with a time lag of about 7 weeks. This is the seasonal drought signal.
- **Fire behaviour indices**, derived from the codes:
  - **ISI** (Initial Spread Index) = wind × FFMC: how fast a fire would spread.
  - **BUI** (Buildup Index) = DMC + DC: how much fuel is available to burn.
  - **FWI** = ISI × BUI: overall fire intensity, which is the danger rating.

**How we run it.** For every weather grid cell we run the system day by day through 14 past days, today, and 7 forecast days. Today's codes come from **official CWFIS values** where possible, and the forecast runs on from them. Every rule below was chosen by testing it against CWFIS (§12):
1. **A CWFIS fire weather station within 400 km.** Today's FFMC, DMC and DC are an **inverse-distance blend of the 4 nearest stations** (weight 1/distance², so the closest dominates). This is the most accurate case.
2. **No station, but CWFIS fire hotspots within 400 km.** CWFIS attaches its own FWI codes to each hotspot, but fires burn where it's driest, so those codes are **biased dry** for the area around them. In testing they made stations read FFMC +9, DC +126 and FWI +9 too high. So in this case:
   - FFMC comes from local weather;
   - DMC and DC are the **average** of the blended fire codes and our own spin-up (the two err in opposite directions).
3. **Nothing official within 400 km.** The cell spins up from the standard startup values (FFMC 85, DMC 6, DC 15). FFMC settles within days. DMC and DC read **low**: in testing, DC was about 200 too low, because two weeks can't rebuild a season of drying (§11).
3. **Rain.** Rain enters the system's own equations: FFMC needs more than 0.5 mm to change, DMC more than 1.5 mm, DC more than 2.8 mm. That's how rain lowers danger. We don't use a separate rain fudge factor.

**Danger classes.** The common Canadian five-class rating on FWI (exact breakpoints vary a little by province):

| FWI | < 5 | 5–10 | 10–20 | 20–30 | ≥ 30 |
|---|---|---|---|---|---|
| Class | Low | Moderate | High | Very High | Extreme |

**Map weather risk (0–1)** is FWI mapped piecewise, so these class breakpoints land exactly on the map's colour thresholds:
- FWI 10 → 0.5 ("Elevated" colour)
- FWI 20 → 0.68 ("High" colour)
- FWI 30 → 0.85 ("Extreme" colour)

Code: `riskFromFwi`.

**Fosberg (comparison only).** The Fosberg Fire Weather Index (Fosberg 1978) is still computed and shown, because it's the index the team's DHT11 sensor station reports. It isn't used to rate danger.

---

## 3. Risk on each hex

Each hex's risk is built in order:

1. **A hotspot inside the hex:** "Active fire", risk 1. Satellite pixels are about 375 m.
2. **Inside a perimeter updated in the last 5 days:** "Active perimeter".
3. **Otherwise:** weather risk (§2) × the **fuel load** of the hex's land type:

   | Land type | Fuel load |
   |---|---|
   | Forest | 1.0 |
   | Shrub | 0.85 |
   | Grass | 0.75 |
   | Tundra | 0.5 |
   | Crop | 0.4 |
   | Wetland | 0.35 |
   | Settlement | 0.3 |
   | Rock, road, rail | 0.05 |
   | Water, ice | 0 |

4. **Near a fire:** a proximity boost, up to +0.55 × fuel.
   - **Reach:** 30 km in calm air, stretched downwind (up to 1.7×) and shrunk upwind by that day's wind.
   - **Calibration:** reach is scaled by the fire's own growth calibration (√k, limited to 0.6–1.6×; §5).
   - **Status:** this is **our own** heuristic, not a standard. It flags ground near fires for attention; the actual spread prediction is §4.
5. **Projected spread:** if the growth model says the hex burns by the selected day, it's marked "Projected spread".
6. **Old burns:** inside an inactive (older) perimeter, it's "Burn scar" with reduced risk.

Colours: risk ≥ 0.5 Elevated, ≥ 0.68 High, ≥ 0.85 Extreme.

Code: `world/hazardField.ts`, `world/spread.ts`.

---

## 4. Projected spread: FBP rates over the real fuel map

### 4.1 Which fires

The model projects two kinds of fire:
- **Mapped fires:** every CWFIS perimeter updated in the last 5 days.
- **New fires:** clusters of hotspots within 3 km of each other that aren't already inside a perimeter.

Each starts at its current size. Code: `data/fireSpread.ts`.

### 4.2 Rate of spread: the FBP System

**Standard:** Forestry Canada Fire Danger Group (1992), *Development and Structure of the Canadian Forest Fire Behavior Prediction System*, ST-X-3, with the 2009 update (Wotton, Alexander & Taylor, GLC-X-10). Code: `data/cffdrs.ts`.

- **Head rate of spread** (m/min) = RSI(ISI) × BE(BUI). RSI = *a*(1 − e^(−*b*·ISI))^*c* with the published coefficients for each fuel type; BE is the buildup effect.
- **Back rate:** the same equations with the back-fire ISI (the wind term reversed).
- **Fire shape:** length-to-breadth from wind.
  - Forest and shrub: FBP eq. 79, LB = 1 + 8.729(1 − e^(−0.030·WS))^2.155.
  - Grass: eq. 80.
- **Grass curing:** Wotton et al. (2009), using seasonal curing by month.
- **Slope:** upslope runs faster by the FBP slope factor e^(3.533·(slope/100)^1.2), capped at 60 %.

**Fuel type per land cover:**

| Land cover (ESA WorldCover) | FBP fuel type | Notes |
|---|---|---|
| Forest | M-1 boreal mixedwood, 50 % conifer | The general forest type when species mix is unknown |
| Shrub | D-1 deciduous | |
| Grassland | O-1b standing grass | Seasonal curing |
| Cropland, wetland, tundra | O-1a matted grass | Seasonal curing |
| Settlement | D-1 × 0.5 | Fire can enter towns, interrupted by streets and lawns |
| Water, ice, rock, river | does not burn | A fire break |

### 4.3 Growth: minimum travel time on hexes

**Method:** minimum travel time (Finney 2002, *Fire growth using minimum travel time methods*, CJFR 32), the algorithm in FlamMap. Canada's Prometheus model uses the same FBP rates with a different propagation method. Code: `world/fireGrowth.ts`.

**Each forecast day:**
1. From every burning hex, fire moves into each neighbour.
2. The time to cross is distance ÷ the rate of spread **in that direction**. That rate is found on the FBP elliptical fire shape using the **neighbour's** fuel type and that day's ISI, BUI, FFMC and wind:
   - head rate downwind;
   - back rate upwind;
   - the ellipse in between on the flanks.

   The upslope factor applies on top.
3. Whatever is reached within the day's **active burning period** burns that day. The next day starts from the new edge with the next day's weather.

**What follows from this:**
- **Fire spreads in every direction through burnable fuel**, not only downwind. On a calm day the shape is round, as fast as that fuel burns.
- **It follows the land cover:** fast through forest, slower through shrub, depending on curing in grass. It stops at lakes, rock and ice.
- **Wind** elongates the shape downwind; **slope** pushes it uphill.

**Active burning period.** FBP gives a rate, not a daily distance. Fire growth models apply the rate across the day's burning period with a diurnal curve. We use **4 hours at the peak rate** per day, a common rule of thumb for the boreal afternoon burning window. The per-fire calibration (§5) corrects it per fire.

**Grid:** the hex size adapts so the fastest fire spans about 70 hexes (0.3–3 km).

**Rain and the demo scenario:**
- Real rain already lowers FFMC, ISI and BUI through the FWI System, so it slows spread automatically.
- The demo scenario's heatwave multiplies rates by 1.35. Its rainstorm cuts rates under it by up to 85 %.

---

## 5. Calibrating each fire against its own history

Models are general; each fire isn't. For every active perimeter in a focused province:

1. **Pull its history.** Fetch every archived CWFIS hotspot inside the perimeter since its first date. Code: `data/fireHistory.ts`.
2. **Daily burned area.** Each day's **new** ~400 m hotspot cells (cells not seen on earlier days) are that day's newly burned ground. Scale the running total to the perimeter's mapped area to get burned area per day. The equivalent radius √(area/π) gives **observed radial growth in km/day**.
3. **Predict the same days.** Run the same FBP model over the last 5 days using the weather that **actually happened** there (Open-Meteo's past days), to get **modelled radial growth**.
4. **Calibration factor** *k* = observed ÷ modelled, limited to 0.2–4. A fire that has been crawling gets *k* < 1 and is projected about one hex; one that has been running gets *k* > 1 and is projected several.
5. **Confidence.** It rises with the number of days the fire actually grew (full at 4). *k* is blended toward 1 when there's little history: *k*^confidence.
6. **Where it's used:** *k* multiplies that fire's spread rates in §4. Its square root, limited to 0.6–1.6, scales the fire's proximity reach in §3 and §6. New hotspot clusters have no history, so they use *k* = 1.

Click a fire hex to see its burned area, recent observed vs. modelled growth, and its *k*.

*Why this matters:* in October 2026 the 9 active fires in Canada showed close to zero growth over 5 days, while the uncalibrated model predicted about 2.8 km/day. With calibration they're projected to barely move, which matches what they're actually doing.

---

## 6. Communities at risk

A town (population 200 or more, in a focused province) is listed only for a concrete reason, which is shown next to it. Code: `data/communityRisk.ts`.

**Reasons:**
- **Fire nearby:** a hotspot or active perimeter within the wind-shaped, growth-scaled reach from §3. Shown as e.g. "fire 18 km W".
- **In projected path:** the growth model (§4) reaches the town by the selected day.
- **High fire weather:** FWI-based risk ≥ 0.68 (Very High or worse) on its own.

**Ranking:**
- **Nearby fire:** influence × (0.65 + 0.35 × weather risk).
- **Projected path:** ≥ 0.9.
- **Weather alone:** weather risk × 0.75.

A town is listed at 0.3 or more. On a quiet day the bar says so rather than naming towns.

---

## 7. Highway corridors at risk

A fire beside a busy highway is a different problem from a fire beside a town: the road is an
exposure in itself (people driving into smoke) and it is usually how everyone upstream of it
leaves. The forecast bar lists the highways a fire has come near, worst first.
Code: `data/traffic.ts` (volumes) and `data/trafficRisk.ts` (scoring); bake:
`scripts/bake_traffic.py`.

### 7.1 Measured volumes

Alberta Transportation and Economic Corridors publishes, for every **traffic control
section** of every numbered highway: the **annual average daily traffic** (WAADT), the
**summer average daily traffic** (WASDT), and the split between passenger vehicles,
recreation vehicles, buses, single-unit trucks and tractor-trailers. A second dataset gives
the **2016-2025 AADT history** for the same sections. Both are Open Government Licence -
Alberta. Nothing here is invented: the volumes are counts the province took.

The volume datasets carry no coordinates, and Alberta's public highway-geometry layer carries
no volumes, so the two are joined on the highway number (including suffixes, e.g. `2A`). The
bake drops the control-section subtotal rows so sections aren't counted twice, length-weights
each highway's sections into one figure, and keeps that highway's measured **minimum and
maximum** section volume alongside it.

### 7.2 Where along a highway the traffic is

Which part of a highway each measured section covers is **not** published. Taken at face
value that would make Highway 2 a single number from Calgary to the Peace Country, when its
sections actually run from 500 to 172,440 vehicles a day.

So the measured average is spread along the route. For every point on the route we compute a
**population accessibility** term over the baked community list,
the sum of pop / (1 + d/10 km) squared within 150 km. That ratio spans several orders of
magnitude, which on its own drives remote stretches of a trunk route to near zero even though
they carry long-distance traffic, so it is raised to the power **0.6**, renormalised so the
highway's own points still average to the volume the province measured, and **clamped to that
highway's measured minimum and maximum**. The modelled value therefore never leaves the
interval Alberta actually measured.

The exponent was chosen against sections whose volume is published:

| Stretch | Modelled | Published |
|---|---|---|
| Highway 2, Deerfoot Trail, Calgary | 98,000 | ~170,000 |
| Highway 63 at Fort McMurray | 33,000 | ~55,000 |
| Highway 2 at Red Deer | 25,000 | ~35,000 |
| Highway 1 at Banff | 9,500 | ~20,000 |
| Highway 16 at Edson | 6,400 | ~10,000 |
| Highway 881, remote | 470 | ~1,000 |

Typical error is a factor of about 1.8, and the **order is right** at every reference point,
which is what the ranking needs. This redistribution is **ours, not Alberta's** - the
measured numbers are the per-highway figures and the range, and the per-point figure is a
model over them.

**Route geometry.** Routes are simplified to stay within 50 m of the real centreline, with no
gap longer than 2 km so fire proximity is still sampled along straight runs. Points are spent
where the road curves and almost none on a straight prairie highway: 23,000 points carry all
28,696 km of measured Alberta highway in 0.28 MB, and 99% of the source road sits within 44 m
of the stored line (median 5 m). Resampling at a uniform 2 km was half as large but cut
corners by up to a kilometre, which at street zoom put the map's vehicles in the river the
highway was following.

### 7.3 The volume on a given day

Two measured quantities turn a yearly figure into one for the day the slider is on:

- **Season.** A cosine peaking in mid-July, with its amplitude set so that averaged over
  Alberta's own June-August window it returns WASDT/WAADT, and averaged over the year it
  returns 1. The swing is the province's measurement; only its shape between the two is ours.
- **Growth.** Each highway's annual change is the slope of a least-squares fit through
  log(volume) across the published 2016-2025 series - log-linear because traffic grows
  multiplicatively. It carries the last measured year forward, capped at 15 years so an old
  dataset can never be extrapolated far, and never run backwards.

Alberta publishes no day-of-week or hour-of-day breakdown, so the prediction stops at daily
resolution. That is the resolution the forecast slider works at anyway.

### 7.4 Ranking

A corridor is listed only for a concrete reason, as with communities (§6):

- **Fire nearby:** a hotspot or active perimeter within the same wind-shaped, growth-scaled
  reach used everywhere else (§3). Shown as e.g. "fire 12 km NW".
- **In projected path:** the growth model (§4) reaches the road by the selected day.

**Fire danger alone never lists a road.** A town can be listed on Very High fire weather by
itself because it is exposed where it stands; a road is only a problem once something is
actually burning next to it.

How busy the road is then sets how much that proximity matters. Exposure is logarithmic
(volumes span three decades): 0 at 500 vehicles/day or below, 1 at 50,000 or above. The score
is influence × (0.55 + 0.45 × exposure) × (0.8 + 0.2 × weather risk), or ≥ 0.9 in a projected
path, and a corridor is listed at 0.3 or more. Each highway appears once, at the point where
a fire comes closest to it, and the commercial share is flagged above 20% - freight traffic is
slower to clear and harder to turn around.

---

### 7.5 The demo scenario on the roads

The scenario's weather side multiplies fire danger and drifts a rainstorm across the map
(§10). Its traffic side completes the chain the scenario already starts: simulated ignitions
threaten towns, the people in those towns leave on the highways, and the fire closes those
same highways. Code: `data/trafficSim.ts`, drawn by `render/TrafficParticles.ts`.

Everything in this subsection is an assumption about the scenario, not a measurement, and it
only applies while the demo scenario is on.

- **Demand.** A long-weekend multiplier of 1.25 on every corridor, the counterpart to the
  heatwave multiplier on fire danger.
- **Evacuation.** A town on the communities-at-risk list (§6) with a fire actually coming at
  it — "fire nearby" or "in projected path", never fire weather alone, because a town listed
  on weather is exposed where it stands rather than being told to leave — puts 80% of its
  people on the road at 2.6 people per vehicle, over about a day, scaled by its threat. That
  is the shape of the real thing: Fort McMurray's 88,000 residents were out within a day in
  May 2016, which put roughly 30,000 extra vehicles on Highway 63. The extra traffic is
  centred on the town and fades out over 60 km, and surges from two towns leaving past the
  same point add up.
- **Closure.** A stretch within 3 km of a fire, or inside the projected spread, is shut. It
  then outranks every other reason, because the busiest road near a fire being the one that
  can't be used is the worst case rather than a detail. The corridor is reported at its
  busiest closed point, and the list shows the traffic the closure strands.
- **Congestion.** Volume against the highway's capacity, which is taken as twice the busiest
  day the province has measured on it — roads are built with headroom over their ordinary
  day. So measured traffic never reads as congested and an evacuation on top of it does.
  Congestion rises as the square of the load past 60% of capacity, because traffic degrades
  slowly and then fails quickly.

**Traffic never changes fire behaviour.** It changes what a fire costs, not how it burns, so
none of this reaches the hazard snapshot, the risk on a hex or the spread model.

**What it does not model:** rerouting. There is no routing graph, so traffic turned back by a
closure does not reappear on the alternative route; it simply stops. A real evacuation would
load the detour.

---

## 8. Wind and rain

- **Wind streams** show Open-Meteo's live wind today and each day's peak wind on forecast days, interpolated between grid points. The fire models use the 12:00 wind (§2, §4).
- **Rain** animates where Open-Meteo reports precipitation now (today) or forecasts a daily total ≥ 1 mm. Its effect on danger and spread comes through the FWI System.

---

## 9. Forecast days

The slider re-runs everything for the chosen day: FWI values, danger, map risk, projected spread (grown day by day up to that day), communities at risk, and the traffic each threatened corridor is expected to carry (§7.3). Fires themselves stay as observed now; the projection shows where they could go.

---

## 10. Demo scenario

For presentations when nothing is burning, the demo adds:
- simulated ignitions;
- a heatwave (×1.35 on danger and spread rates);
- a 75 km rainstorm that drifts about 55 km/day downwind with the real wind while weakening;
- the traffic those fires cause: a long-weekend demand multiplier, the threatened towns
  evacuating onto the highways, closures where fire crosses a road, and the congestion that
  follows (§7.5), drawn as vehicles on the road at street zoom.

Everything simulated is labelled **SIMULATION**. Code: `data/hazards.ts`, `data/rain.ts`,
`data/trafficSim.ts`.

---

## 11. Limitations

- **Not official.** CWFIS / NRCan and provincial agencies issue the official fire danger ratings and fire behaviour forecasts. This tool reuses their standard methods on open data.
- **Weather resolution.** Open-Meteo is sampled on a 1.5° grid (coarser for very large provinces), about 160 km. Local weather (valleys, lake effects, convective storms) is smoothed out.
- **FWI seeding.** The CWFIS live station feed is mostly federal (MSC) stations. Alberta has one and southern BC none, so much of western Canada falls back on fire-hotspot codes (rule 2) or spin-up (rule 3), which are less accurate (§12). Provincial station networks would close this gap; they aren't in the open CWFIS feed.
- **Our own weather runs damper than stations.** Open-Meteo's humidity makes our own FFMC about 6 points lower (wetter) than the stations, which is why official codes are used wherever they exist.
- **Fuel types are inferred** from land cover (ESA WorldCover), not from the official FBP fuel grids. Forest is treated as M-1 mixedwood at 50 % conifer. Pure black-spruce stands (C-2) burn faster, and leafless deciduous stands in spring differ.
- **No spotting, suppression or fuel breaks** beyond water, rock and ice. Roads and rivers narrower than a hex don't stop the model. Real fires jump barriers and are fought.
- **Daily time step.** Burning is 4 h equivalent at the peak rate per day; overnight and diurnal changes are not modelled separately.
- **Growth history** counts new hotspot cells, which undercounts under cloud or smoke and with gaps between satellite passes. It's scaled to the mapped perimeter area, so totals stay right, but individual days can be noisy. That's why calibration uses a 5-day window and a confidence weight.
- **The proximity boost** (§3) is our own heuristic for flagging attention, not a standard.
- **Traffic volumes are annual counts, not live.** No province publishes an open, keyless live traffic feed; Alberta's 511 road-event API requires a key, so closures and incidents are not in the app. What is live in a corridor warning is the fire and the weather, not the traffic.
- **Traffic volumes are per highway, redistributed along it.** Alberta does not publish where each measured section sits, so the local figure is a model (§7.2) - typically within a factor of about 1.8 of the published section value, and lowest where traffic has a cause the population list can't see. Tourist corridors are the clearest case: Highway 1 at Banff models low because Banff is a small town carrying a national park's traffic.
- **The scenario's traffic is a scenario.** The demand multiplier, the share of a town that leaves, how long it takes and what closes a road are assumptions, not measurements, and they are only applied with the demo scenario on. Traffic is not rerouted around closures (§7.5).
- **Only numbered provincial highways.** Forest and resource roads carry the crews and are often the only way out of a remote site, but no traffic counts are published for them.
- **Alberta only, so far.** Each province publishes its counts in its own format under its own licence, and only Alberta's adapter is written. Other provinces load with no corridor list rather than a guessed one.

---

## 12. How it's tested

### Against CWFIS's published values

`npm run validate:fwi` (`scripts/validate-fwi.ts`) compares our FWI System output with CWFIS's own values at every CWFIS station reporting today, plus up to 120 of today's hotspots. **Leave-one-out:** each point is seeded only from *other* points at least 25 km away, so it's never checked against itself.

Results for 2 Oct 2026 (n = 552 stations + 120 hotspots; "MAE" is the average absolute difference from CWFIS):

| Method | FWI MAE | FWI bias | Danger class exact | Within one class |
|---|---|---|---|---|
| Our weather only (standard spin-up, no CWFIS input) | 6.0 | −5.4 | 64 % | 85 % |
| Nearest official point only | 3.7 | −1.3 | 72 % | 94 % |
| **Blend of 4 nearest (used)** | **3.4** | −1.4 | **75 %** | **95 %** |
| …at points with stations nearby | 2.1 | −0.6 | 79 % | 96 % |
| …at fire points seeded from other fires | 9.3 | −4.9 | 62 % | 90 % |

Away from fires, seeded only from fire hotspots (90 stations checked against hotspot seeds):

| Method | FFMC bias | DC bias | FWI MAE | Class exact | Within one |
|---|---|---|---|---|---|
| All codes from fires | +8.8 | +126 | 10.9 | 37 % | 61 % |
| Our weather only | −2.7 | −214 | 6.4 | 36 % | 83 % |
| **Local FFMC, slow codes averaged (used)** | −2.7 | −44 | **5.3** | **48 %** | **88 %** |

Rejected alternatives we tested:
- FFMC from local weather everywhere: FWI MAE 5.2.
- Stepping official FFMC through today's local rain: FWI MAE 4.6.

Both were worse than the official codes, which already account for the day's weather.

### Unit tests

`npm test` runs the unit tests in `app/tests/`:
- **FWI System:** matches the published reference day (Van Wagner & Pickett 1985): from startup values with T 17 °C, RH 42 %, wind 25 km/h and no rain, it gives FFMC 87.7, DMC 8.5, DC 19.0, ISI 10.9, BUI 8.5, FWI 10.1. Also checks rain response, monotonic indices and danger classes.
- **FBP:** fuel ordering (conifer faster than deciduous; cured grass faster than green); length-to-breadth grows with wind.
- **Growth model:** spreads in every direction in calm air, runs downwind in wind, never crosses water, forest outruns shrub, the ellipse geometry is right, and a rainstorm slows it.
- **Calibration:** daily growth reconstruction; fast fires get *k* > 1, stalled fires *k* < 1; little history keeps *k* near 1.
- **Traffic volumes:** delta-decoding restores each point's position and its own volume; the seasonal curve reproduces the measured summer average over Alberta's June-August window and averages to 1 over the year; a highway with no summer uplift has no swing; growth compounds from the measured year and is capped rather than extrapolated.
- **Corridors at risk:** no fires lists nothing however busy the road; a fire 10 km away lists the highway with that distance and direction and one 80 km away doesn't; the busier of two highways at the same distance scores higher; fire danger alone never lists a road; a long highway is one entry reported at its closest approach; and the same corridor reads busier in July than in January.
- **Traffic scenario:** capacity leaves a measured peak free-flowing and fails when demand doubles; congestion stays at zero until the road is near capacity; only towns with a fire coming at them evacuate, scaled by threat, and fire weather alone never empties one; surges add up where two towns leave past the same point and fade out with distance; the demand multiplier lifts every corridor; fire on the road closes it and that outranks everything else; and nothing is closed without the scenario.
- **The traffic field:** every point carries a volume whether or not a fire is near it, so the map always has traffic to draw; a route can be driven along by distance, its length is measured off the projected geometry rather than assumed, it clamps past the end, and a closure has an edge on it.
- **Communities at risk, rain, wind field, Fosberg:** behaviour checks.

---

## References

- Van Wagner, C.E. 1987. *Development and Structure of the Canadian Forest Fire Weather Index System.* Forestry Technical Report 35. Canadian Forestry Service.
- Van Wagner, C.E.; Pickett, T.L. 1985. *Equations and FORTRAN Program for the Canadian Forest Fire Weather Index System.* Forestry Technical Report 33.
- Forestry Canada Fire Danger Group. 1992. *Development and Structure of the Canadian Forest Fire Behavior Prediction System.* Information Report ST-X-3.
- Wotton, B.M.; Alexander, M.E.; Taylor, S.W. 2009. *Updates and Revisions to the 1992 Canadian Forest Fire Behavior Prediction System.* Information Report GLC-X-10.
- Wang, X.; Wotton, B.M.; Cantin, A.S.; et al. 2017. *cffdrs: an R package for the Canadian Forest Fire Danger Rating System.* Ecological Processes 6:5.
- Finney, M.A. 2002. *Fire growth using minimum travel time methods.* Canadian Journal of Forest Research 32: 1420–1424.
- Tymstra, C.; Bryce, R.W.; Wotton, B.M.; Taylor, S.W.; Armitage, O.B. 2010. *Development and Structure of Prometheus: the Canadian Wildland Fire Growth Simulation Model.* Information Report NOR-X-417.
- Fosberg, M.A. 1978. *Weather in wildland fire management: the fire weather index.* Proceedings of the Conference on Sierra Nevada Meteorology.
- Canadian Wildland Fire Information System (CWFIS), Natural Resources Canada: <https://cwfis.cfs.nrcan.gc.ca/>
- Alberta Transportation and Economic Corridors. *Traffic volumes on links in the highway network.* Open Government Licence - Alberta: <https://open.alberta.ca/dataset/traffic-volumes-on-links-in-the-highway-network>
- Alberta Transportation and Economic Corridors. *Traffic volumes at points on the highway* (AADT history). Open Government Licence - Alberta: <https://open.alberta.ca/dataset/traffic-volumes-at-points-on-the-highway>
- Government of Alberta GeoSpatial. *Transportation: access facility roads* (highway geometry). Open Government Licence - Alberta: <https://geospatial.alberta.ca/titan/rest/services/transportation/access_facility_roads/MapServer>
