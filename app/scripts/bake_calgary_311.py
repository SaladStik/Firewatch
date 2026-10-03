"""
Bakes the context Calgary 311 dispatch scores tickets with: public/data/cases/calgary_context.json

  Open Calgary 311 history   (data.calgary.ca iahh-g8bj; Open Government Licence - City of Calgary)
    - how long the city takes to close each service type (median / 90th percentile days): the
      target a ticket is measured against before it counts as overdue;
    - last year's requests per community and type, per 1,000 residents (chronic problem areas);
    - repeat spots: 100 m cells with 3+ requests of the same type in the last year.
  Calgary community populations (data.calgary.ca jtpc-xgsh, latest census per community)
  OpenStreetMap (Alberta extract, cached by bake_osm_pbf.py; ODbL) inside Calgary:
    schools, childcare, hospitals and clinics, seniors' homes, fire and police stations,
    transit stops, traffic signals, pedestrian crossings.
  Slope (%), 100 m grid, from the 20 m city raster (scripts/bake-city.ts) - ice on hills.

Run: python scripts/bake_calgary_311.py         (needs `pip install osmium pypng`-free: uses osmium + PIL)
Downloads are cached in scripts/.cache (delete calgary311_*.json to refresh the history).
"""
import base64
import json
import math
import os
import statistics
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta

import osmium

ROOT = os.path.join(os.path.dirname(__file__), "..")
CACHE = os.path.join(ROOT, "scripts", ".cache")
OUT = os.path.join(ROOT, "public", "data", "cases", "calgary_context.json")
BBOX = (-114.33, 50.84, -113.85, 51.22)  # matches src/config/cities.ts
API = "https://data.calgary.ca/resource"

# The service types the planner knows (src/dispatch/ops311.ts), plus the city's ice/snow ones.
TYPES = [
    "Roads - Pothole Maintenance",
    "Roads - Debris on Street/Sidewalk/Boulevard",
    "Roads - Signs - Missing - Damaged",
    "Roads - Signs - Parking",
    "Roads - Signs - Traffic and Roadmarking",
    "Roads - Snow and Ice Control",
    "Roads - Streetlight Maintenance",
    "WRS - Waste - Residential",
    "WRS - Commercial Collection Services",
    "WRS - New Service - Carts",
]


def soql(dataset, params, cache_name):
    path = os.path.join(CACHE, cache_name)
    if os.path.exists(path):
        with open(path, encoding="utf8") as f:
            return json.load(f)
    rows, offset = [], 0
    while True:
        q = dict(params, **{"$limit": "50000", "$offset": str(offset)})
        url = f"{API}/{dataset}.json?" + urllib.parse.urlencode(q)
        with urllib.request.urlopen(url, timeout=120) as r:
            page = json.load(r)
        rows += page
        print(f"  {dataset}: {len(rows)} rows", flush=True)
        if len(page) < 50000:
            break
        offset += 50000
    with open(path, "w", encoding="utf8") as f:
        json.dump(rows, f)
    return rows


def r5(v):
    return round(v, 5)


# ---------------------------------------------------------------- 311 history
def history():
    since = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%dT00:00:00")
    types = ",".join("'" + t.replace("'", "''") + "'" for t in TYPES)
    rows = soql("iahh-g8bj", {
        "$select": "service_name,comm_name,requested_date,closed_date,status_description,latitude,longitude",
        "$where": f"requested_date > '{since}' AND service_name in ({types})",
    }, "calgary311_history.json")
    close_days = defaultdict(list)
    per_comm = defaultdict(Counter)
    cells = defaultdict(Counter)
    for r in rows:
        s = r.get("service_name")
        try:
            req = datetime.fromisoformat(r["requested_date"][:19])
        except (KeyError, ValueError):
            continue
        if r.get("closed_date"):
            try:
                close_days[s].append(max(0.0, (datetime.fromisoformat(r["closed_date"][:19]) - req).total_seconds() / 86400))
            except ValueError:
                pass
        if r.get("comm_name"):
            per_comm[r["comm_name"]][s] += 1
        try:
            la, ln = float(r["latitude"]), float(r["longitude"])
        except (KeyError, ValueError, TypeError):
            continue
        # 100 m cells (0.0009° lat ≈ 100 m; 0.0014° lng ≈ 100 m at 51° N)
        cells[s][(round(la / 0.0009), round(ln / 0.0014))] += 1
    targets = {}
    for s, ds in close_days.items():
        ds.sort()
        targets[s] = {"median": round(statistics.median(ds), 1), "p90": round(ds[int(len(ds) * 0.9) - 1], 1), "n": len(ds)}
    repeats = {s: [[r5(k[0] * 0.0009), r5(k[1] * 0.0014), n] for k, n in c.items() if n >= 3] for s, c in cells.items()}
    return rows, targets, {c: dict(v) for c, v in per_comm.items()}, repeats


# ---------------------------------------------------------------- population
def population():
    rows = soql("jtpc-xgsh", {"$select": "name,census_year,population"}, "calgary_population.json")
    best = {}
    for r in rows:
        try:
            y, p = int(r["census_year"]), int(float(r["population"]))
        except (KeyError, ValueError):
            continue
        if p > 0 and (r["name"] not in best or y > best[r["name"]][0]):
            best[r["name"]] = (y, p)
    return {n: p for n, (y, p) in best.items()}, max((y for y, _ in best.values()), default=None)


# ---------------------------------------------------------------- OpenStreetMap
KINDS = {
    "school": lambda t: t.get("amenity") in ("school", "college", "university"),
    "childcare": lambda t: t.get("amenity") in ("kindergarten", "childcare"),
    "hospital": lambda t: t.get("amenity") in ("hospital", "clinic") or t.get("healthcare") in ("hospital", "clinic"),
    "seniors": lambda t: t.get("amenity") == "nursing_home" or t.get("social_facility") in ("nursing_home", "assisted_living") or t.get("social_facility:for") == "senior",
    "fire_station": lambda t: t.get("amenity") == "fire_station",
    "police": lambda t: t.get("amenity") == "police",
    "transit": lambda t: t.get("highway") == "bus_stop" or t.get("public_transport") == "platform" or t.get("railway") in ("station", "tram_stop"),
    "signal": lambda t: t.get("highway") == "traffic_signals",
    "crossing": lambda t: t.get("highway") == "crossing" or t.get("crossing") is not None,
}


class Poi(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.found = defaultdict(set)

    def _add(self, tags, lat, lng):
        if not (BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lng <= BBOX[2]):
            return
        for k, test in KINDS.items():
            if test(tags):
                self.found[k].add((r5(lat), r5(lng)))

    def node(self, n):
        if n.tags and n.location.valid():
            self._add(n.tags, n.location.lat, n.location.lon)

    def area(self, a):
        # Buildings / grounds mapped as areas (schools, hospitals): their centre.
        t = a.tags
        if not any(test(t) for k, test in KINDS.items() if k in ("school", "childcare", "hospital", "seniors", "fire_station", "police")):
            return
        try:
            pts = [(nd.lat, nd.lon) for ring in a.outer_rings() for nd in ring]
        except Exception:
            return
        if pts:
            self._add(t, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def osm():
    pbf = os.path.join(CACHE, "pbf", "alberta.osm.pbf")
    if not os.path.exists(pbf):
        sys.exit("No Alberta OSM extract cached: run `npm run bake:pbf -- alberta` first.")
    h = Poi()
    h.apply_file(pbf, locations=True)
    return {k: sorted(v) for k, v in h.found.items()}


# ---------------------------------------------------------------- slope
def slope_grid():
    from PIL import Image
    meta = json.load(open(os.path.join(ROOT, "public", "data", "alberta", "cities", "calgary.json")))
    im = Image.open(os.path.join(ROOT, "public", "data", "alberta", "cities", "calgary.png")).convert("RGBA")
    w, h = im.size
    px = im.load()
    elev = lambda i, j: px[i, j][0] * 256 + px[i, j][1]
    step = 5  # 5 × 20 m = 100 m cells
    gw, gh = w // step, h // step
    out = bytearray(gw * gh)
    for gj in range(gh):
        for gi in range(gw):
            i, j = gi * step + step // 2, gj * step + step // 2
            i0, i1, j0, j1 = max(0, i - 2), min(w - 1, i + 2), max(0, j - 2), min(h - 1, j + 2)
            dzx = (elev(i1, j) - elev(i0, j)) / ((i1 - i0) * meta["pxKm"] * 1000)
            dzy = (elev(i, j1) - elev(i, j0)) / ((j1 - j0) * meta["pxKm"] * 1000)
            out[gj * gw + gi] = min(255, round(math.hypot(dzx, dzy) * 100 * 4))  # % × 4
    return {"minX": meta["minX"], "minZ": meta["minZ"], "cellKm": meta["pxKm"] * step, "w": gw, "h": gh, "scale": 4, "b64": base64.b64encode(bytes(out)).decode()}


def main():
    os.makedirs(CACHE, exist_ok=True)
    print("311 history (last 365 days) …")
    rows, targets, per_comm, repeats = history()
    print("community populations …")
    pop, pop_year = population()
    print("OpenStreetMap points …")
    poi = osm()
    print("slope …")
    slope = slope_grid()
    out = {
        "attribution": "311 history and community populations: City of Calgary (Open Government Licence - City of Calgary). Points: (c) OpenStreetMap contributors (ODbL). Slope: AWS Terrain Tiles.",
        "baked": datetime.now().strftime("%Y-%m-%d"),
        "historyDays": 365,
        "historyRequests": len(rows),
        "closeTargets": targets,
        "communityRequests": per_comm,
        "population": pop,
        "populationYear": pop_year,
        "repeatSpots": repeats,
        "poi": poi,
        "slope": slope,
    }
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.2f} MB)")
    print("close targets (days):", {k.split(' - ', 1)[1]: v["median"] for k, v in targets.items()})
    print("points:", {k: len(v) for k, v in poi.items()})
    print("communities with population:", len(pop), "census", pop_year, "· repeat spots:", sum(len(v) for v in repeats.values()))


if __name__ == "__main__":
    main()
