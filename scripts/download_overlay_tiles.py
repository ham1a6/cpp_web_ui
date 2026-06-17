#!/usr/bin/env python3
"""
Download GSI pale-map overlay tiles for offline use.
Tiles are saved to data/overlay-tiles/{z}/{x}/{y}.png

Typical workflow
----------------
  # 1. Preview tile counts without downloading
  python3 scripts/download_overlay_tiles.py --dry-run

  # 2. Download zoom 5-10 for all Japan (≈ 11,000 tiles, ≈ 340 MB)
  python3 scripts/download_overlay_tiles.py

  # 3. Add higher-zoom tiles for a specific area, e.g. Tokyo metro at zoom 11-16
  python3 scripts/download_overlay_tiles.py --zoom 11-16 --bbox 35.3,138.8,36.2,140.3

After downloading, the server serves tiles from disk without any internet access.
Tiles already present on disk are skipped (re-running is safe).

GSI tile policy: https://maps.gsi.go.jp/development/ichiran.html
"""
import os, sys, math, time, urllib.request, argparse

TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"
OUT_DIR  = os.path.join(os.path.dirname(__file__), '..', 'data', 'overlay-tiles')

HEADERS = {
    'User-Agent': 'MapDemoApp/1.0 (offline educational demo; contact yhamae@outlook.com)'
}

# Bounding box — all of Japan including remote islands
JAPAN_MIN_LAT, JAPAN_MAX_LAT = 20.0, 46.0
JAPAN_MIN_LON, JAPAN_MAX_LON = 122.0, 155.0


def tile_xy(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    r = math.radians(lat)
    y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
    return x, y


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--zoom', default='5-10', metavar='Z1-Z2',
                   help='zoom range to download (default: 5-10)')
    p.add_argument('--bbox', default=None, metavar='MINLAT,MINLON,MAXLAT,MAXLON',
                   help='bounding box (default: all Japan)')
    p.add_argument('--dry-run', action='store_true',
                   help='print tile counts without downloading')
    return p.parse_args()


def parse_zoom(s: str) -> range:
    if '-' in s:
        a, b = s.split('-', 1)
        return range(int(a), int(b) + 1)
    z = int(s)
    return range(z, z + 1)


def parse_bbox(s: str) -> tuple[float, float, float, float]:
    vals = [float(v) for v in s.split(',')]
    if len(vals) != 4:
        raise ValueError("--bbox expects MINLAT,MINLON,MAXLAT,MAXLON")
    return vals[0], vals[1], vals[2], vals[3]


def count_tiles(zoom_levels, min_lat, min_lon, max_lat, max_lon) -> int:
    total = 0
    for z in zoom_levels:
        x1, y2 = tile_xy(min_lat, min_lon, z)
        x2, y1 = tile_xy(max_lat, max_lon, z)
        total += (x2 - x1 + 1) * (y2 - y1 + 1)
    return total


def main():
    args = parse_args()

    zoom_levels = parse_zoom(args.zoom)
    if args.bbox:
        min_lat, min_lon, max_lat, max_lon = parse_bbox(args.bbox)
    else:
        min_lat, min_lon = JAPAN_MIN_LAT, JAPAN_MIN_LON
        max_lat, max_lon = JAPAN_MAX_LAT, JAPAN_MAX_LON

    print(f"Overlay tiles: zoom {zoom_levels.start}–{zoom_levels.stop - 1}, "
          f"bbox ({min_lat},{min_lon})–({max_lat},{max_lon})")
    print(f"Output: {os.path.abspath(OUT_DIR)}\n")

    # Per-zoom summary
    for z in zoom_levels:
        x1, y2 = tile_xy(min_lat, min_lon, z)
        x2, y1 = tile_xy(max_lat, max_lon, z)
        count = (x2 - x1 + 1) * (y2 - y1 + 1)
        print(f"  zoom {z:2d}: x={x1}-{x2}, y={y1}-{y2}  ({count} tiles)")

    total = count_tiles(zoom_levels, min_lat, min_lon, max_lat, max_lon)
    print(f"\nTotal: {total} tiles (~{total * 30 // 1024} MB estimated)")

    if args.dry_run:
        print("(dry run — no downloads)")
        return

    if total > 100_000:
        print(f"\nWarning: {total} tiles is large. Ctrl-C to abort, Enter to continue.")
        try:
            input()
        except EOFError:
            pass

    print("Downloading... (Ctrl+C to stop)\n")

    done = skipped = errors = 0
    for z in zoom_levels:
        x1, y2 = tile_xy(min_lat, min_lon, z)
        x2, y1 = tile_xy(max_lat, max_lon, z)
        for x in range(x1, x2 + 1):
            for y in range(y1, y2 + 1):
                path = os.path.join(OUT_DIR, str(z), str(x), f'{y}.png')
                if os.path.exists(path):
                    skipped += 1
                    continue
                os.makedirs(os.path.dirname(path), exist_ok=True)
                url = TILE_URL.format(z=z, x=x, y=y)
                try:
                    req = urllib.request.Request(url, headers=HEADERS)
                    with urllib.request.urlopen(req, timeout=15) as r:
                        data = r.read()
                    with open(path, 'wb') as f:
                        f.write(data)
                    done += 1
                    if done % 100 == 0:
                        print(f"  {done} downloaded, {skipped} skipped, {errors} errors")
                    time.sleep(0.1)  # be polite to GSI servers
                except Exception as e:
                    errors += 1
                    if errors <= 10:
                        print(f"  ERROR {z}/{x}/{y}: {e}")

    print(f"\nDone: {done} new, {skipped} already existed, {errors} errors")
    print(f"Tiles saved to: {os.path.abspath(OUT_DIR)}")


if __name__ == '__main__':
    main()
