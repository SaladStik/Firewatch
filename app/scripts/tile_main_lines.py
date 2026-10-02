"""
Move "main" lines (highways, primary/secondary roads, ordinary rivers, rail) out of each
region's osm.json and into its on-demand 1 deg detail tiles.

Why: under the realism rule (a line becomes hex nodes only where it's >= 25% of a hex
wide) these lines can only appear at street zoom anyway, but in osm.json every map
worker had to download + index ~53 MB of them at start-up. Only genuinely wide rivers
(which can show at coarser zoom) stay in osm.json.

Run after bake_osm_pbf.py (the bake also calls this):   python scripts/tile_main_lines.py [region ...]
"""
import json
import math
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "public", "data")
Q = 1e5
KEEP_RIVER_WIDTH_KM = 0.05  # rivers this wide (OSM width tag) stay global
ID_OFFSET = 50_000_000      # keeps moved line ids distinct from detail-line ids


def keep_global(line):
    return line["k"] in (0, 1) and line.get("w", 0) >= KEEP_RIVER_WIDTH_KM


def encode(i, k, pts, lat0, lng0):
    enc = [i, k]
    px = py = None
    for lng, lat in pts:
        qx, qy = round((lng - lng0) * Q), round((lat - lat0) * Q)
        if px is None:
            enc += [qx, qy]
        else:
            enc += [qx - px, qy - py]
        px, py = qx, qy
    return enc


def process(region):
    d = os.path.join(DATA, region)
    osm_path = os.path.join(d, "osm.json")
    lines_dir = os.path.join(d, "lines")
    if not os.path.exists(osm_path) or not os.path.isdir(lines_dir):
        print(f"{region}: skipped (no osm.json / lines)")
        return
    osm = json.load(open(osm_path, encoding="utf8"))
    if osm.get("tiled"):
        print(f"{region}: already tiled")
        return
    keep, moved = [], {}
    for n, line in enumerate(osm["lines"]):
        if keep_global(line):
            keep.append(line)
            continue
        p = line["p"]
        pts = [(p[j], p[j + 1]) for j in range(0, len(p), 2)]
        for lat0, lng0 in {(math.floor(lat), math.floor(lng)) for lng, lat in pts}:
            moved.setdefault((lat0, lng0), []).append(encode(ID_OFFSET + n, line["k"], pts, lat0, lng0))
    index = json.load(open(os.path.join(lines_dir, "index.json"), encoding="utf8"))
    tiles = set(index["tiles"])
    for (lat0, lng0), enc in moved.items():
        name = f"{lat0}_{lng0}"
        path = os.path.join(lines_dir, name + ".json")
        tile = json.load(open(path, encoding="utf8")) if name in tiles else {"o": [lat0, lng0], "l": []}
        tile["l"].extend(enc)
        with open(path, "w", encoding="utf8") as f:
            f.write(json.dumps(tile, separators=(",", ":")))
        tiles.add(name)
    index["tiles"] = sorted(tiles)
    with open(os.path.join(lines_dir, "index.json"), "w", encoding="utf8") as f:
        json.dump(index, f)
    before = os.path.getsize(osm_path)
    osm["lines"] = keep
    osm["tiled"] = True
    with open(osm_path, "w", encoding="utf8") as f:
        f.write(json.dumps(osm, separators=(",", ":")))
    print(f"{region}: kept {len(keep)} wide-river lines, moved {sum(len(v) for v in moved.values())} line-tiles; "
          f"osm.json {before / 1e6:.1f} -> {os.path.getsize(osm_path) / 1e6:.1f} MB")


if __name__ == "__main__":
    for r in sys.argv[1:] or sorted(os.listdir(DATA)):
        if os.path.isdir(os.path.join(DATA, r)):
            process(r)
