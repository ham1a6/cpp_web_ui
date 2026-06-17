#!/usr/bin/env python3
"""
Generate Terrain-RGB tiles from JAXA AW3D30 DEM for MapLibre 3D terrain.

Encoding: Terrarium  (elevation = R*256 + G + B/256 - 32768)
For JAXA Int16 data B is always 0:
  R = (elevation + 32768) >> 8
  G = (elevation + 32768) & 0xFF
  nodata (-9999) → sea level  (R=128, G=0, B=0)

Output: web/terrain-rgb/{z}/{x}/{y}.png
MapLibre source config: { type: 'raster-dem', encoding: 'terrarium', maxzoom: 12 }

NOTE: --resampling=near is used intentionally.  Bilinear/average resampling
mixes R and G channel bytes and corrupts the encoded elevation at overview
zoom levels.  Near-neighbor preserves encoding fidelity.

Requirements:
  Debian/Ubuntu : apt install gdal-bin python3-gdal python3-numpy
  Rocky Linux   : dnf install gdal gdal-python3 python3-numpy

Usage:
  python3 scripts/generate_terrain_rgb.py            # zoom 5-12
  python3 scripts/generate_terrain_rgb.py 5 10       # zoom 5-10 only
  python3 scripts/generate_terrain_rgb.py --dry-run
"""

import argparse
import math
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_DIR  = SCRIPT_DIR.parent
MAP_DIR      = PROJECT_DIR / 'map'
TERRAIN_DIR  = PROJECT_DIR / 'web' / 'terrain-rgb'
NCPU         = os.cpu_count() or 4
GDAL_CACHEMAX = '512'


def find_dsm_files():
    files = sorted(MAP_DIR.glob('*/*_DSM.tif'))
    if not files:
        files = sorted(MAP_DIR.glob('**/*DSM*.tif'))
    return [str(f) for f in files]


def find_msk_files():
    files = sorted(MAP_DIR.glob('*/*_MSK.tif'))
    if not files:
        files = sorted(MAP_DIR.glob('**/*MSK*.tif'))
    return [str(f) for f in files]


def run(cmd, **kw):
    env = dict(os.environ, GDAL_CACHEMAX=GDAL_CACHEMAX)
    print('  $', ' '.join(str(c) for c in cmd))
    sys.stdout.flush()
    subprocess.run([str(c) for c in cmd], check=True, env=env, **kw)


def elapsed_str(t0):
    s = int(time.time() - t0)
    return f'{s//60}m{s%60:02d}s'


def approx_tile_count(zoom_min, zoom_max):
    def tile_xy(lat, lon, z):
        n = 2**z
        r = math.radians(lat)
        x = int((lon + 180) / 360 * n)
        y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
        return x, y
    MIN_LAT, MAX_LAT, MIN_LON, MAX_LON = 20.0, 46.0, 122.0, 155.0
    total = 0
    for z in range(zoom_min, zoom_max + 1):
        x1, y2 = tile_xy(MIN_LAT, MIN_LON, z)
        x2, y1 = tile_xy(MAX_LAT, MAX_LON, z)
        total += (x2 - x1 + 1) * (y2 - y1 + 1)
    return total


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('zoom_min', nargs='?', type=int, default=5)
    ap.add_argument('zoom_max', nargs='?', type=int, default=12)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not (5 <= args.zoom_min <= args.zoom_max <= 14):
        ap.error('zoom values must satisfy 5 <= zoom_min <= zoom_max <= 14')

    print('=' * 62)
    print(' JAXA AW3D30 → Terrain-RGB tile generator')
    print(f' Zoom    : {args.zoom_min}–{args.zoom_max}')
    print(f' Output  : {TERRAIN_DIR}/')
    print(f' Procs   : {NCPU}')
    print('=' * 62)
    print(f'  Approx tiles: {approx_tile_count(args.zoom_min, args.zoom_max):,}')
    print()

    dsm_files = find_dsm_files()
    msk_files = find_msk_files()
    print(f'DSM files: {len(dsm_files)}')
    print(f'MSK files: {len(msk_files)}')

    if not dsm_files:
        print('ERROR: No DSM files found under map/.')
        sys.exit(1)

    if args.dry_run:
        print('\n(dry run — no GDAL commands executed)')
        return

    print()
    t0 = time.time()

    with tempfile.TemporaryDirectory(prefix='cpp_web_ui_terrain_') as tmpdir:
        tmp = Path(tmpdir)

        (tmp / 'dsm_list.txt').write_text('\n'.join(dsm_files))
        if msk_files:
            (tmp / 'msk_list.txt').write_text('\n'.join(msk_files))

        merged_dsm = tmp / 'merged_dsm.vrt'
        merged_msk = tmp / 'merged_msk.vrt'
        masked_dsm = tmp / 'masked_dsm.tif'
        value_tif  = tmp / 'value.tif'
        r_band     = tmp / 'r_band.tif'
        g_band     = tmp / 'g_band.tif'
        b_band     = tmp / 'b_band.tif'
        rgb_vrt    = tmp / 'terrain_rgb.vrt'

        # ------------------------------------------------------------ #
        # 1. Merge DSM/MSK files                                        #
        # ------------------------------------------------------------ #
        print(f'[1/4] Building VRTs from {len(dsm_files)} DSM files...  {elapsed_str(t0)}')
        run(['gdalbuildvrt', '-resolution', 'highest', '-q',
             '-srcnodata', '-9999', '-vrtnodata', '-9999',
             '-input_file_list', tmp / 'dsm_list.txt', merged_dsm])
        if msk_files:
            run(['gdalbuildvrt', '-resolution', 'highest', '-q',
                 '-input_file_list', tmp / 'msk_list.txt', merged_msk])

        # ------------------------------------------------------------ #
        # 2. Ocean masking                                               #
        # ------------------------------------------------------------ #
        print(f'\n[2/4] Ocean masking...  {elapsed_str(t0)}')
        if msk_files:
            run(['gdal_calc.py',
                 '-D', merged_dsm, '-M', merged_msk,
                 '--outfile', masked_dsm,
                 '--type=Int16', '--NoDataValue=-9999',
                 '--co', 'COMPRESS=DEFLATE', '--co', 'TILED=YES',
                 '--co', 'BLOCKXSIZE=256', '--co', 'BLOCKYSIZE=256',
                 '--overwrite', '--quiet',
                 '--calc',
                 'numpy.where((M.astype(numpy.int32) & 3) == 3,'
                 ' numpy.int16(-9999), D)'])
        else:
            masked_dsm = merged_dsm

        # ------------------------------------------------------------ #
        # 3. Compute Terrarium value (UInt16)                           #
        #    nodata (-9999) → 32768 (sea level = 0 m)                   #
        # ------------------------------------------------------------ #
        print(f'\n[3/4] Terrarium encoding...  {elapsed_str(t0)}')
        # --hideNoData: GDAL 3.3+ uses masked arrays by default, which would
        # silently skip nodata pixels and write output-nodata instead of the
        # computed value. --hideNoData forces all pixels (including -9999
        # ocean/nodata) to be included in the numpy calc so they correctly
        # map to sea level (32768 → R=128, G=0).
        run(['gdal_calc.py', '-A', masked_dsm,
             '--outfile', value_tif,
             '--type=UInt16', '--NoDataValue=0',
             '--hideNoData',
             '--co', 'COMPRESS=DEFLATE', '--co', 'TILED=YES',
             '--co', 'BLOCKXSIZE=256', '--co', 'BLOCKYSIZE=256',
             '--overwrite', '--quiet',
             '--calc',
             'numpy.where(A <= -9998, numpy.uint16(32768),'
             ' numpy.clip(A.astype(numpy.int32) + 32768,'
             ' 0, 65535).astype(numpy.uint16))'])

        for label, calc, out in [
            ('R', '(V >> 8).astype(numpy.uint8)',  r_band),
            ('G', '(V & 255).astype(numpy.uint8)', g_band),
            ('B', 'numpy.zeros_like(V, dtype=numpy.uint8)', b_band),
        ]:
            run(['gdal_calc.py', '-V', value_tif,
                 '--outfile', out,
                 '--type=Byte', '--hideNoData', '--overwrite', '--quiet',
                 '--co', 'COMPRESS=DEFLATE', '--co', 'TILED=YES',
                 '--calc', calc])
            print(f'  {label} band done  {elapsed_str(t0)}')

        run(['gdalbuildvrt', '-separate', '-q',
             rgb_vrt, r_band, g_band, b_band])

        subprocess.run(['python3', '-W', 'ignore', '-c', f'''
from osgeo import gdal
ds = gdal.Open("{rgb_vrt}", gdal.GA_Update)
ds.GetRasterBand(1).SetColorInterpretation(gdal.GCI_RedBand)
ds.GetRasterBand(2).SetColorInterpretation(gdal.GCI_GreenBand)
ds.GetRasterBand(3).SetColorInterpretation(gdal.GCI_BlueBand)
ds.FlushCache()
'''], check=True)

        # ------------------------------------------------------------ #
        # 4. Generate XYZ tiles                                         #
        # Pass EPSG:4326 VRT directly — gdal2tiles reprojects           #
        # internally.  Avoids gdalwarp fill-value=0 corrupting ocean    #
        # pixels (0,0,0 → elevation -32768 m in Terrarium encoding).    #
        # Use nearest-neighbor to preserve Terrarium byte encoding.     #
        # ------------------------------------------------------------ #
        print(f'\n[4/4] Generating terrain-RGB tiles '
              f'(zoom {args.zoom_min}-{args.zoom_max})...  {elapsed_str(t0)}')
        TERRAIN_DIR.mkdir(parents=True, exist_ok=True)
        run(['gdal2tiles.py',
             '--xyz',
             f'--zoom={args.zoom_min}-{args.zoom_max}',
             f'--processes={NCPU}',
             '--resampling=near',
             '--webviewer=none',
             '--resume',
             rgb_vrt,
             TERRAIN_DIR])

    total = time.time() - t0
    print()
    print('=' * 62)
    for z in range(args.zoom_min, args.zoom_max + 1):
        zdir = TERRAIN_DIR / str(z)
        n = len(list(zdir.rglob('*.png'))) if zdir.exists() else 0
        print(f'  zoom {z}: {n:,} tiles')
    print(f'Total time: {total / 60:.1f} min')
    print('=' * 62)
    print()
    print('Terrain-RGB tiles ready. Restart the server to activate 3D terrain.')
    print()


if __name__ == '__main__':
    main()
