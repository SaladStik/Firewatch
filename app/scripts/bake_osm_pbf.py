"""
OpenStreetMap bake from per-province extracts (OpenStreetMap France / Geofabrik mirrors) (ODbL — (c) OpenStreetMap contributors).

Replaces the Overpass-based bake: one ~0.1-1 GB .osm.pbf per province, processed
locally with pyosmium. No public API rate limits.

Outputs per region (public/data/<region>/):
  osm.json         buildings (>= ~4 storeys) + MAIN lines (highways, primary/secondary,
                   rivers, rail) — loaded at start-up
  places.json      every city / town / village / hamlet inside the province + landmarks
  lines/<lat>_<lng>.json   DETAIL lines in 1 deg tiles (tertiary, local/residential roads,
                   forest/resource tracks, streams/creeks/canals) — fetched on demand
                   at street zoom
  lines/index.json list of tiles

Usage:  npm run bake:pbf -- alberta [ontario ...]     (no args = every region)
Requires: pip install osmium
"""
import json
import math
import os
import re
import sys
import time
import urllib.request

import osmium

sys.path.insert(0, os.path.dirname(__file__))

ROOT = os.path.join(os.path.dirname(__file__), "..")
CACHE = os.path.join(ROOT, "scripts", ".cache")
PBF_DIR = os.path.join(CACHE, "pbf")
CFG = json.load(open(os.path.join(CACHE, "regions.json"), encoding="utf8"))
K = CFG["lineKinds"]
# Same per-province OSM extracts from two hosts; the first that answers fast is used.
# (Geofabrik throttles heavily at times; OpenStreetMap France is the fallback/primary mirror.)
MIRRORS = [
    lambda rid: f"https://download.openstreetmap.fr/extracts/north-america/canada/{rid.replace('-', '_')}-latest.osm.pbf",
    lambda rid: f"https://download.geofabrik.de/north-america/canada/{rid}-latest.osm.pbf",
]

MAJOR_RIVER = re.compile(
    r"^(Bow|Elbow|Athabasca|Peace|North Saskatchewan|South Saskatchewan|Red Deer|Oldman|Milk|Smoky|Hay|Slave|Wapiti|McLeod|"
    r"Pembina|Clearwater|Battle|Highwood|Sheep|Belly|St\. Mary|Waterton|Wabasca|Birch|Christina|Beaver|Brazeau|Little Smoky|"
    r"Berland|Wildhay|Sturgeon|Lesser Slave|Fraser|Thompson|North Thompson|South Thompson|Columbia|Kootenay|Skeena|Nass|"
    r"Stikine|Liard|Nechako|Kettle|Okanagan|Similkameen|Chilcotin|Quesnel|Churchill|Qu'Appelle|Assiniboine|Souris|Carrot|"
    r"Saskatchewan|Fond du Lac|Frenchman|Nelson|Hayes|Winnipeg|Red|Albany|Moose|Severn|Attawapiskat|Ottawa|French|"
    r"Saint Lawrence|Saint-Laurent|Rivière des Outaouais|Saguenay|Rupert|Eastmain|La Grande|Koksoak|Caniapiscau|"
    r"Saint John|Miramichi|Restigouche|Churchill|Mackenzie|Yukon|Pelly|Stewart|Porcupine|Peel|Thelon|Back|Kazan|Dubawnt|"
    r"Coppermine|Anderson|Hay|Liard)( River)?$|^(Fleuve|Rivière) "
)

MAJOR_ROADS = {"motorway": K["Highway"], "trunk": K["Highway"], "primary": K["Primary"], "secondary": K["Secondary"]}
DETAIL_ROADS = {"tertiary": K["Tertiary"], "unclassified": K["Local"], "residential": K["Local"], "track": K["Track"]}
DETAIL_WATER = {"stream": K["Stream"], "canal": K["Stream"]}

TOL_MAJOR_KM = 0.03
TOL_DETAIL_KM = 0.008
Q = 1e5  # detail tile quantisation: 1e-5 deg (~1 m)


# ---------------------------------------------------------------- helpers
def simplify(pts, tol_km):
    """Douglas-Peucker on (lng, lat) in local km."""
    n = len(pts)
    if n < 3:
        return pts
    kx = 111.32 * math.cos(math.radians(pts[0][1]))
    ky = 110.574
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a][0] * kx, pts[a][1] * ky
        dx, dy = pts[b][0] * kx - ax, pts[b][1] * ky - ay
        ln = math.hypot(dx, dy) or 1e-9
        best, best_d = -1, tol_km
        for i in range(a + 1, b):
            d = abs((pts[i][0] * kx - ax) * dy - (pts[i][1] * ky - ay) * dx) / ln
            if d > best_d:
                best_d, best = d, i
        if best > 0:
            keep[best] = True
            stack.append((a, best))
            stack.append((best, b))
    return [p for p, k in zip(pts, keep) if k]


def r5(v):
    return round(v, 5)


class Boundary:
    """Point-in-province test (rings from the provinces GeoJSON, bucketed by latitude band)."""

    def __init__(self, name):
        gj = json.load(open(os.path.join(CACHE, "canada-provinces.geojson"), encoding="utf8"))
        f = next(f for f in gj["features"] if f["properties"]["name"] == name)
        polys = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]]
        self.edges = []
        for poly in polys:
            for ring in poly:
                for i in range(len(ring)):
                    a, b = ring[i], ring[i - 1]
                    if a[1] != b[1]:
                        self.edges.append((a[0], a[1], b[0], b[1]))
        self.bands = {}
        for e in self.edges:
            for band in range(math.floor(min(e[1], e[3]) * 4), math.floor(max(e[1], e[3]) * 4) + 1):
                self.bands.setdefault(band, []).append(e)

    def contains(self, lng, lat):
        inside = False
        for ax, ay, bx, by in self.bands.get(math.floor(lat * 4), ()):
            if (ay > lat) != (by > lat) and lng < (bx - ax) * (lat - ay) / (by - ay) + ax:
                inside = not inside
        return inside


def height_of(tags):
    h = re.sub(r"[^\d.]", "", tags.get("height", "") or "")
    try:
        if h and float(h) > 0:
            return float(h)
    except ValueError:
        pass
    try:
        lv = float(tags.get("building:levels", ""))
        return lv * 3.5 if lv > 0 else None
    except ValueError:
        return None


def download(region_id):
    os.makedirs(PBF_DIR, exist_ok=True)
    path = os.path.join(PBF_DIR, f"{region_id}.osm.pbf")
    if os.path.exists(path):
        return path
    tmp = path + ".part"
    last_err = None
    for mirror in MIRRORS:
        url = mirror(region_id)
        try:
            print(f"  downloading {url}", flush=True)
            fetch(url, tmp)
            os.replace(tmp, path)
            return path
        except Exception as e:  # try the next mirror
            last_err = e
            print(f"    failed: {e}", flush=True)
    raise RuntimeError(f"all mirrors failed for {region_id}: {last_err}")


def fetch(url, tmp):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "embergrid-bake/0.2"}), timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got, last = 0, 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if got - last > 100 << 20:
                last = got
                print(f"    {got / 1e6:.0f} / {total / 1e6:.0f} MB", flush=True)


# ---------------------------------------------------------------- handler
class Extract(osmium.SimpleHandler):
    def __init__(self, region, boundary):
        super().__init__()
        self.region = region
        self.boundary = boundary
        self.landmark_names = set(region["landmarks"])
        self.places = []
        self.landmarks = {}
        self.buildings = []
        self.major = []
        self.detail = []  # (kind, pts)

    def node(self, n):
        t = n.tags
        name = t.get("name")
        if not name:
            return
        place = t.get("place")
        if place in ("city", "town", "village", "hamlet"):
            lat, lng = n.location.lat, n.location.lon
            if not self.boundary.contains(lng, lat):
                return
            try:
                pop = int(re.sub(r"[^\d]", "", t.get("population", "")))
            except ValueError:
                pop = {"city": 50_000, "town": 2_000, "village": 300, "hamlet": 80}[place]
            self.places.append({"name": name, "lat": r5(lat), "lng": r5(lng), "pop": pop})
        if name in self.landmark_names and name not in self.landmarks:
            self.landmarks[name] = [r5(n.location.lat), r5(n.location.lon)]

    def way(self, w):
        t = w.tags
        hw, ww, rw = t.get("highway"), t.get("waterway"), t.get("railway")
        building = t.get("building")
        name = t.get("name")
        if not (hw or ww or rw or building or (name and name in self.landmark_names)):
            return
        try:
            pts = [(nd.location.lon, nd.location.lat) for nd in w.nodes if nd.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2:
            return

        if name and name in self.landmark_names:
            self.landmarks[name] = [r5(sum(p[1] for p in pts) / len(pts)), r5(sum(p[0] for p in pts) / len(pts))]

        if building:
            h = height_of(t)
            if h and 12 <= h <= 400 and not t.get("man_made"):
                lngs = [p[0] for p in pts]
                lats = [p[1] for p in pts]
                lat, lng = (min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2
                wk = (max(lngs) - min(lngs)) * 111.32 * math.cos(math.radians(lat))
                dk = (max(lats) - min(lats)) * 110.574
                if wk <= 0.6 and dk <= 0.6:
                    self.buildings.append([r5(lat), r5(lng), round(h), round(max(wk, 0.02), 3), round(max(dk, 0.02), 3)])
            return

        if t.get("tunnel") not in (None, "no"):
            return
        if hw in MAJOR_ROADS:
            self.add_major(MAJOR_ROADS[hw], pts)
        elif hw in DETAIL_ROADS:
            self.detail.append((DETAIL_ROADS[hw], pts))
        elif ww == "river":
            nm = name or ""
            k = K["RiverMajor"] if MAJOR_RIVER.search(nm) else K["River"]
            wd = 0
            try:
                wd = float(t.get("width", "0") or 0)
            except ValueError:
                pass
            self.add_major(k, pts, wd / 1000 if 3 < wd < 1000 else 0, nm if k == K["RiverMajor"] else None)
        elif ww in DETAIL_WATER:
            self.detail.append((DETAIL_WATER[ww], pts))
        elif rw in ("rail", "light_rail") and (rw == "light_rail" or t.get("usage") in ("main", "branch")):
            self.add_major(K["Rail"], pts)

    def add_major(self, k, pts, width_km=0, name=None):
        s = simplify(pts, TOL_MAJOR_KM)
        line = {"k": k, "p": [v for lng, lat in s for v in (r5(lng), r5(lat))]}
        if width_km:
            line["w"] = round(width_km, 3)
        if name:
            line["n"] = name
        self.major.append(line)


# ---------------------------------------------------------------- tiles
def write_detail_tiles(detail, out_dir):
    lines_dir = os.path.join(out_dir, "lines")
    os.makedirs(lines_dir, exist_ok=True)
    for f in os.listdir(lines_dir):
        os.remove(os.path.join(lines_dir, f))
    tiles = {}
    for i, (k, pts) in enumerate(detail):
        s = simplify(pts, TOL_DETAIL_KM)
        touched = set()
        for lng, lat in s:
            touched.add((math.floor(lat), math.floor(lng)))
        for lat0, lng0 in touched:
            # first point relative to the tile origin, then deltas (all in 1e-5 deg)
            enc = [i, k]
            px = py = None
            for lng, lat in s:
                qx, qy = round((lng - lng0) * Q), round((lat - lat0) * Q)
                if px is None:
                    enc += [qx, qy]
                else:
                    enc += [qx - px, qy - py]
                px, py = qx, qy
            tiles.setdefault((lat0, lng0), []).append(enc)
    index = []
    total = 0
    for (lat0, lng0), lines in tiles.items():
        name = f"{lat0}_{lng0}"
        txt = json.dumps({"o": [lat0, lng0], "l": lines}, separators=(",", ":"))
        with open(os.path.join(lines_dir, name + ".json"), "w", encoding="utf8") as f:
            f.write(txt)
        total += len(txt)
        index.append(name)
    with open(os.path.join(lines_dir, "index.json"), "w", encoding="utf8") as f:
        json.dump({"q": Q, "tiles": sorted(index)}, f)
    return len(index), total


# ---------------------------------------------------------------- main
def bake(region_id):
    region = CFG["regions"][region_id]
    t0 = time.time()
    print(f"=== {region_id}", flush=True)
    pbf = download(region_id)
    h = Extract(region, Boundary(region["boundaryName"]))
    print(f"  parsing {os.path.getsize(pbf) / 1e6:.0f} MB pbf", flush=True)
    h.apply_file(pbf, locations=True, idx="flex_mem")
    out = os.path.join(ROOT, "public", "data", region_id)
    os.makedirs(out, exist_ok=True)
    h.buildings.sort(key=lambda b: -b[2])
    h.places.sort(key=lambda p: -p["pop"])
    osm = json.dumps({"attribution": "(c) OpenStreetMap contributors (ODbL), via Geofabrik", "buildings": h.buildings, "lines": h.major}, separators=(",", ":"))
    with open(os.path.join(out, "osm.json"), "w", encoding="utf8") as f:
        f.write(osm)
    with open(os.path.join(out, "places.json"), "w", encoding="utf8") as f:
        json.dump({"attribution": "(c) OpenStreetMap contributors (ODbL)", "places": h.places, "landmarks": h.landmarks}, f, separators=(",", ":"))
    n_tiles, detail_bytes = write_detail_tiles(h.detail, out)
    # Main lines only show at street zoom too (realism rule): move them into the tiles.
    import tile_main_lines
    tile_main_lines.process(region_id)
    print(
        f"  {len(h.places)} places, {len(h.buildings)} buildings, {len(h.major)} main lines ({len(osm) / 1e6:.1f} MB), "
        f"{len(h.detail)} detail lines in {n_tiles} tiles ({detail_bytes / 1e6:.0f} MB), "
        f"landmarks {len(h.landmarks)}/{len(region['landmarks'])} — {time.time() - t0:.0f}s",
        flush=True,
    )


if __name__ == "__main__":
    ids = sys.argv[1:] or CFG["order"]
    for rid in ids:
        if rid not in CFG["regions"]:
            sys.exit(f"unknown region {rid}")
        bake(rid)
