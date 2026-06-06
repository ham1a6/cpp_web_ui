#!/usr/bin/env python3
"""
Download OSM tiles for Japan (full extent) for offline use.
Tiles are saved to ../web/tiles/{z}/{x}/{y}.png

Coverage: Japan including all territories
  - Mainland: Hokkaido, Honshu, Shikoku, Kyushu
  - Remote islands: Okinawa, Ogasawara, Minamitorishima (~154°E)
  Bounding box: 20°N–46°N, 122°E–155°E

Usage: python3 download_tiles.py [--dry-run]

NOTE: Using the same bounding box for all zoom levels ensures that any area
visible at a low zoom level (e.g. zoom 5) also has tiles at higher zoom levels,
preventing tiles from disappearing when zooming in.
"""
import os, sys, math, time, urllib.request

def tile_xy(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    r = math.radians(lat)
    y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
    return x, y

# Bounding box: all of Japan including Minamitorishima (easternmost) at 153.97°E
MIN_LAT, MAX_LAT = 20.0, 46.0
MIN_LON, MAX_LON = 122.0, 155.0

# Zoom levels to cache
ZOOM_LEVELS = range(5, 11)

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'web', 'tiles')
DRY_RUN = '--dry-run' in sys.argv

headers = {'User-Agent': 'MapDemoApp/1.0 (offline educational demo; contact yhamae@outlook.com)'}

total_tiles = 0
for z in ZOOM_LEVELS:
    # Note: lat increases upward but y increases downward
    x1, y2 = tile_xy(MIN_LAT, MIN_LON, z)
    x2, y1 = tile_xy(MAX_LAT, MAX_LON, z)
    count = (x2 - x1 + 1) * (y2 - y1 + 1)
    total_tiles += count
    print(f"  zoom {z:2d}: x={x1}-{x2}, y={y1}-{y2}  ({count} tiles)")

print(f"\nTotal: {total_tiles} tiles")
if DRY_RUN:
    print("(dry run — no downloads)")
    sys.exit(0)

print("Downloading... (Ctrl+C to stop)\n")

done = skipped = errors = 0
for z in ZOOM_LEVELS:
    x1, y2 = tile_xy(MIN_LAT, MIN_LON, z)
    x2, y1 = tile_xy(MAX_LAT, MAX_LON, z)
    for x in range(x1, x2 + 1):
        for y in range(y1, y2 + 1):
            path = os.path.join(OUT_DIR, str(z), str(x), f'{y}.png')
            if os.path.exists(path):
                skipped += 1
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            url = f'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=10) as r:
                    with open(path, 'wb') as f:
                        f.write(r.read())
                done += 1
                if done % 50 == 0:
                    print(f"  {done} downloaded, {skipped} skipped, {errors} errors")
                time.sleep(0.05)   # respect OSM tile usage policy
            except Exception as e:
                errors += 1
                print(f"  ERROR {z}/{x}/{y}: {e}")

print(f"\nDone: {done} new, {skipped} cached, {errors} errors")
print(f"Tiles saved to: {os.path.abspath(OUT_DIR)}")
