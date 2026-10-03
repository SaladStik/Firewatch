"""
Traffic volume bake from provincial open data (ODbL-free, no API keys).

Measured traffic volumes are published per highway section, without coordinates; the
highway geometry is published separately, without volumes. This script fetches both,
joins them on the highway number and writes one compact file per region.

Outputs per region (public/data/<region>/):
  traffic.json   numbered highways with measured volumes + their routes resampled to
                 SPACING_KM points, so the client can score fire proximity cheaply

Usage:  npm run bake:traffic -- alberta [british-columbia ...]   (no args = every region
        that has an adapter)
Requires: pip install openpyxl

Adding a province: write a `fetch_<region>()` returning (meta, volumes, routes) and add it
to ADAPTERS. Regions without an adapter simply ship no traffic.json, and the app hides the
traffic layer for them.
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
CACHE = os.path.join(ROOT, "scripts", ".cache", "traffic")
OUT = os.path.join(ROOT, "public", "data")

# Routes are simplified to follow the real centreline within this distance. Uniform
# resampling was cheaper but cut corners: a 2 km chord across a river bend put the map's
# vehicles in the water. Simplifying adaptively instead spends points where the road actually
# curves and almost none on a straight prairie highway, which costs about half as much again
# in file size and bounds the error at a fraction of a street-zoom hex (75 m).
SIMPLIFY_KM = 0.05
# ...and no gap longer than this, so fire proximity is still sampled along straight runs.
# Fires reach 30-51 km (src/world/spread.ts), so 2 km is far finer than that question needs.
MAX_GAP_KM = 2.0
# Coordinate quantisation in the output file: 1e-4 deg (~11 m), well under SIMPLIFY_KM.
Q = 10000

UA = {"User-Agent": "FIRE//WATCH traffic bake (open data)"}


# ---------------------------------------------------------------- helpers
def fetch(url, name):
    """Download once into scripts/.cache/traffic/."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        print(f"  download {name}")
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=300) as r, open(path, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    return path


def get_json(url, params, tries=4):
    """GET a JSON API with retries (the ArcGIS endpoints occasionally time out)."""
    full = f"{url}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(full, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode("utf8"))
        except Exception as e:  # noqa: BLE001 - any transport error is worth one more try
            last = e
            print(f"    retry {attempt + 1}/{tries}: {e}")
    raise RuntimeError(f"{url} failed: {last}")


def km_per_deg(lat):
    """Local scale factors (km per degree of lng, per degree of lat)."""
    return 111.320 * math.cos(math.radians(lat)), 110.574


def seg_km(a, b):
    kx, ky = km_per_deg((a[1] + b[1]) / 2)
    return math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky)


def simplify(pts, tol_km):
    """Douglas-Peucker on (lng, lat) in local km: drop vertices the line doesn't need."""
    n = len(pts)
    if n < 3:
        return list(pts)
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


def cap_gaps(pts, max_km):
    """Split any segment longer than `max_km` so no two points are further apart than that."""
    if len(pts) < 2:
        return list(pts)
    out = [pts[0]]
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        n = int(seg_km(a, b) / max_km)
        for k in range(1, n + 1):
            t = k / (n + 1)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        out.append(b)
    return out


def point_weights(pts):
    """
    Length of road each point stands for (km): half the way to each neighbour.

    The points are no longer evenly spaced, so anything averaging over them — the gravity
    redistribution below — has to weight them by this or it would over-count the curves.
    """
    n = len(pts)
    if n == 0:
        return []
    if n == 1:
        return [1.0]
    seg = [seg_km(pts[i - 1], pts[i]) for i in range(1, n)]
    return [(seg[max(0, i - 1)] if i > 0 else 0) / 2 + (seg[i] / 2 if i < n - 1 else 0) for i in range(n)]


def chain(features):
    """
    Join polylines that share an endpoint into longer routes.

    Provincial networks ship as thousands of short pieces; chaining them means far fewer
    (and far longer) polylines, which resample to the same points but cost much less JSON.
    """
    ends = {}
    key = lambda p: (round(p[0], 5), round(p[1], 5))  # noqa: E731 - ~1 m snap
    for i, pts in enumerate(features):
        if len(pts) >= 2:
            ends.setdefault(key(pts[0]), []).append((i, False))
            ends.setdefault(key(pts[-1]), []).append((i, True))
    used = [False] * len(features)
    routes = []
    for i, pts in enumerate(features):
        if used[i] or len(pts) < 2:
            continue
        used[i] = True
        route = list(pts)
        # Extend from both ends while exactly one unused piece continues the route (a fork
        # would be an arbitrary choice, so stop there and start a new route instead).
        for at_end in (True, False):
            while True:
                tip = key(route[-1] if at_end else route[0])
                nxt = [(j, rev) for j, rev in ends.get(tip, []) if not used[j]]
                if len(nxt) != 1:
                    break
                j, rev = nxt[0]
                used[j] = True
                add = list(features[j])
                if rev:
                    add.reverse()
                if at_end:
                    route.extend(add[1:])
                else:
                    # add[1:] walks away from the shared tip, so reverse it to stay in order.
                    route[:0] = list(reversed(add[1:]))
        routes.append(route)
    return routes


def encode(pts, mults, hwy_index):
    """One resampled route → [hwyIndex, lat0, lng0, m0, dlat, dlng, m1, ...] in 1/Q degree units."""
    row = [hwy_index]
    px = py = 0
    for (lng, lat), m in zip(pts, mults):
        qx, qy = round(lng * Q), round(lat * Q)
        if len(row) == 1:
            row += [qy, qx, m]
        else:
            if qx == px and qy == py:
                continue  # two samples landed in the same ~100 m cell
            row += [qy - py, qx - px, m]
        px, py = qx, qy
    return row if len(row) >= 7 else None


# ------------------------------------------------- where along a highway the traffic is
# Alberta measures volumes per highway section but does not publish where each section
# lies, so a highway's sections can only be averaged over its whole length (Highway 2 runs
# from 500 to 172,440 vehicles/day). To get a local figure, that measured average is
# redistributed along the route by population accessibility — a gravity term over the baked
# community list — and clamped to the highway's own measured range, so the modelled value
# never leaves the interval the province actually measured. See METHODOLOGY.md.
ACCESS_RADIUS_KM = 150
ACCESS_DECAY_KM = 10
# Accessibility spans several orders of magnitude, which on its own would push remote
# stretches of a trunk route to near zero even though they carry long-distance traffic. The
# ratio is raised to this power to compress that spread before it is renormalised; the value
# is calibrated against sections whose volume Alberta publishes (see METHODOLOGY.md).
ACCESS_EXPONENT = 0.6


def load_places(region):
    """Baked communities (name, lat, lng, pop) bucketed by whole degree of latitude."""
    path = os.path.join(OUT, region, "places.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf8") as f:
        places = json.load(f).get("places") or []
    buckets = {}
    for p in places:
        pop = p.get("pop") or 0
        if pop <= 0:
            continue
        buckets.setdefault(math.floor(p["lat"]), []).append((p["lng"], p["lat"], pop))
    return buckets


def accessibility(pt, buckets):
    """Σ pop / (1 + d/decay)² over communities within ACCESS_RADIUS_KM of this point."""
    lng, lat = pt
    kx, ky = km_per_deg(lat)
    span = int(ACCESS_RADIUS_KM / ky) + 1
    total = 0.0
    for band in range(math.floor(lat) - span, math.floor(lat) + span + 1):
        for plng, plat, pop in buckets.get(band, ()):
            dx = (plng - lng) * kx
            if abs(dx) > ACCESS_RADIUS_KM:
                continue
            dy = (plat - lat) * ky
            d = math.hypot(dx, dy)
            if d > ACCESS_RADIUS_KM:
                continue
            total += pop / (1 + d / ACCESS_DECAY_KM) ** 2
    return total


def trend_pct(series):
    """
    Annual growth (%/yr) from a yearly volume series, as the slope of a least-squares fit
    through log(volume). Log-linear because traffic grows multiplicatively.
    """
    pts = [(y, v) for y, v in series if v and v > 0]
    if len(pts) < 3:
        return 0.0
    n = len(pts)
    mx = sum(y for y, _ in pts) / n
    my = sum(math.log(v) for _, v in pts) / n
    cov = sum((y - mx) * (math.log(v) - my) for y, v in pts)
    var = sum((y - mx) ** 2 for y, _ in pts)
    if var == 0:
        return 0.0
    return round((math.exp(cov / var) - 1) * 100, 2)


def xlsx_rows(path, sheet=0):
    """Rows of a sheet as tuples, without loading the whole workbook into memory."""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[sheet]] if isinstance(sheet, int) else wb[sheet]
    try:
        for row in ws.iter_rows(values_only=True):
            yield row
    finally:
        wb.close()


def num(v):
    """Spreadsheet cell → float, or None when it isn't a number."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------- Alberta
# Volumes: Alberta Transportation and Economic Corridors, "Traffic volumes on links in the
# highway network" (per traffic control section: WAADT, WASDT, vehicle classification) and
# "Traffic volumes at points on the highway" (the 2016-2025 AADT history, for the trend).
# Geometry: Government of Alberta GeoSpatial (titan) transportation/access_facility_roads,
# the only public Alberta layer that serves highway geometry (highways_public has the control
# sections but returns no geometry).
AB_LINKS = "https://open.alberta.ca/dataset/06a254aa-4cec-4d89-9d93-34845b4873f1/resource/777c6e10-ce41-40c5-a3de-bf8af81626eb/download/tec-traffic-volume-highway-network-2025.xlsx"
AB_HISTORY = "https://open.alberta.ca/dataset/38bf49b8-78fa-4480-8044-7635b252f13a/resource/e20b7c7b-5580-4dc4-9339-c7f31c8d1716/download/tec-traffic-volume-history-10-year.xlsx"
AB_ROADS = "https://geospatial.alberta.ca/titan/rest/services/transportation/access_facility_roads/MapServer/0/query"
AB_YEAR = 2025


def ab_volumes():
    """Per-highway measured volumes, length-weighted over that highway's sections."""
    path = fetch(AB_LINKS, "ab-links-2025.xlsx")
    acc = {}
    for row in xlsx_rows(path):
        if len(row) < 19:
            continue
        hwy = str(row[1]).strip() if row[1] is not None else ""
        # Section rows carry a TCS; the blank-TCS rows are control-section subtotals and
        # would double-count. Skip the title block too (no numeric length).
        if not hwy or hwy.lower() == "hwy" or row[4] is None or str(row[4]).strip() == "":
            continue
        length, aadt, sadt = num(row[10]), num(row[11]), num(row[12])
        if not length or not aadt or length <= 0 or aadt <= 0:
            continue
        cm = num(row[18]) or 0.0
        a = acc.setdefault(hwy, {"km": 0.0, "wa": 0.0, "ws": 0.0, "wcm": 0.0, "lo": aadt, "hi": aadt})
        a["km"] += length
        a["wa"] += aadt * length
        a["ws"] += (sadt or aadt) * length
        a["wcm"] += cm * length
        a["lo"] = min(a["lo"], aadt)
        a["hi"] = max(a["hi"], aadt)
    out = {}
    for hwy, a in acc.items():
        if a["km"] <= 0:
            continue
        out[hwy] = {
            "aadt": round(a["wa"] / a["km"]),
            "sadt": round(a["ws"] / a["km"]),
            "cm": round(a["wcm"] / a["km"], 1),
            "lo": round(a["lo"]),
            "hi": round(a["hi"]),
            "km": round(a["km"], 1),
        }
    print(f"  volumes: {len(out)} highways, {round(sum(v['km'] for v in out.values())):,} km measured")
    return out


def ab_trend():
    """Annual growth per highway from the 2016-2025 AADT history."""
    path = fetch(AB_HISTORY, "ab-history-10yr.xlsx")
    years, totals = [], {}
    for row in xlsx_rows(path):
        if not years:
            # The header row is the one carrying a run of four-digit years.
            ys = [(i, int(str(c))) for i, c in enumerate(row) if c is not None and str(c).strip().isdigit() and len(str(c).strip()) == 4]
            if len(ys) >= 5:
                years = ys
            continue
        hwy = str(row[1]).strip() if len(row) > 1 and row[1] is not None else ""
        if not hwy or hwy.lower() == "hwy":
            continue
        t = totals.setdefault(hwy, {y: 0.0 for _, y in years})
        for i, y in years:
            v = num(row[i]) if i < len(row) else None
            if v:
                t[y] += v
    out = {h: trend_pct(sorted(t.items())) for h, t in totals.items() if any(t.values())}
    print(f"  history: {len(out)} highways over {years[0][1]}-{years[-1][1]}")
    return out


def ab_routes():
    """Numbered provincial highway geometry, paged out of the ArcGIS layer."""
    # Paging the whole network takes a while, so keep it alongside the spreadsheets.
    cached = os.path.join(CACHE, "ab-highways.json")
    if os.path.exists(cached):
        with open(cached, encoding="utf8") as f:
            raw = json.load(f)
        by_hwy = {(k.split("\t")[0], k.split("\t")[1]): v for k, v in raw.items()}
        print(f"  geometry: {len(by_hwy)} highway/class groups (cached)")
        return by_hwy
    by_hwy = {}
    offset, page, total = 0, 2000, 0
    while True:
        j = get_json(AB_ROADS, {
            "where": "ROAD_CLASS IN ('PRIMARY','SECONDARY')",
            "outFields": "HWY_NUMBER,ROAD_CLASS",
            "returnGeometry": "true",
            "outSR": "4326",
            "orderByFields": "OBJECTID",
            "resultOffset": offset,
            "resultRecordCount": page,
            "f": "json",
        })
        if j.get("error"):
            raise RuntimeError(j["error"])
        feats = j.get("features") or []
        for f in feats:
            hwy = (f.get("attributes") or {}).get("HWY_NUMBER")
            cls = (f.get("attributes") or {}).get("ROAD_CLASS")
            if not hwy:
                continue
            for p in (f.get("geometry") or {}).get("paths") or []:
                if len(p) >= 2:
                    by_hwy.setdefault((str(hwy).strip(), cls), []).append([(c[0], c[1]) for c in p])
        total += len(feats)
        if not j.get("exceededTransferLimit") and len(feats) < page:
            break
        offset += page
        print(f"    {total:,} features")
    print(f"  geometry: {total:,} features, {len(by_hwy)} highway/class groups")
    os.makedirs(CACHE, exist_ok=True)
    with open(cached, "w", encoding="utf8") as f:
        json.dump({f"{h}\t{c}": v for (h, c), v in by_hwy.items()}, f)
    return by_hwy


def fetch_alberta():
    vols, trend, routes = ab_volumes(), ab_trend(), ab_routes()
    meta = {
        "source": "Alberta Transportation and Economic Corridors",
        "year": AB_YEAR,
        "attribution": "Traffic volumes and highway geometry: Government of Alberta (Open Government Licence – Alberta)",
        "historyFrom": 2016,
    }
    return meta, vols, trend, routes


ADAPTERS = {"alberta": fetch_alberta}


# ---------------------------------------------------------------- bake
def bake(region):
    adapter = ADAPTERS.get(region)
    if not adapter:
        print(f"{region}: no traffic adapter, skipping")
        return
    print(f"{region}:")
    meta, vols, trend, routes = adapter()
    places = load_places(region)
    if not places:
        print("  no places.json — local volumes will all sit at the highway average")

    highways, points = [], []
    matched = unmatched = 0
    for (hwy, cls), feats in sorted(routes.items()):
        v = vols.get(hwy)
        if not v:
            unmatched += 1
            continue
        matched += 1
        idx = len(highways)
        highways.append({
            "n": hwy,
            "c": 0 if cls == "PRIMARY" else 1,
            "aadt": v["aadt"],
            "sadt": v["sadt"],
            "cm": v["cm"],
            "lo": v["lo"],
            "hi": v["hi"],
            "km": v["km"],
            "g": trend.get(hwy, 0.0),
        })
        # Simplify to the real centreline, then spread this highway's measured average over
        # its own points, weighting each by the length of road it stands for.
        shapes = [p for p in (cap_gaps(simplify(f, SIMPLIFY_KM), MAX_GAP_KM) for f in chain(feats)) if len(p) >= 2]
        access = [[accessibility(p, places) for p in shape] for shape in shapes]
        weights = [point_weights(shape) for shape in shapes]
        flat = [a for row in access for a in row]
        wflat = [w for row in weights for w in row]
        total_w = sum(wflat)
        mean = (sum(a * w for a, w in zip(flat, wflat)) / total_w) if total_w > 0 else 0.0
        # Compress the accessibility ratio, then renormalise so this highway's own points
        # still average to the volume the province measured on it.
        ratio = [(a / mean) ** ACCESS_EXPONENT if mean > 0 else 1.0 for a in flat]
        rmean = (sum(r * w for r, w in zip(ratio, wflat)) / total_w) if total_w > 0 else 1.0
        for shape, row in zip(shapes, access):
            if mean > 0 and rmean > 0:
                scaled = [v["aadt"] * (a / mean) ** ACCESS_EXPONENT / rmean for a in row]
                local = [min(v["hi"], max(v["lo"], x)) for x in scaled]
            else:
                local = [v["aadt"]] * len(row)
            mults = [max(1, round(x / v["aadt"] * 100)) for x in local]
            enc = encode(shape, mults, idx)
            if enc:
                points.append(enc)

    if not highways:
        print("  nothing matched, no file written")
        return
    out = {**meta, "toleranceKm": SIMPLIFY_KM, "maxGapKm": MAX_GAP_KM, "q": Q, "highways": highways, "points": points}
    d = os.path.join(OUT, region)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "traffic.json")
    with open(path, "w", encoding="utf8") as f:
        json.dump(out, f, separators=(",", ":"))
    n = sum((len(p) - 1) // 3 for p in points)
    print(f"  {matched} matched / {unmatched} without volumes · {len(points)} routes · {n:,} points · {os.path.getsize(path) / 1e6:.2f} MB")


if __name__ == "__main__":
    args = sys.argv[1:] or list(ADAPTERS)
    for r in args:
        bake(r)
