#!/usr/bin/env python3
"""
Generate flat color-relief elevation tiles from JAXA AW3D30 GeoTIFF data.

Pipeline (4 steps):
  1. gdalbuildvrt  — merge all 1°×1° DSM/MSK GeoTIFFs into virtual mosaics
  2. gdal_calc.py  — ocean masking (MSK bit 0x03 → nodata -9999)
  3. gdaldem       — color-relief (scripts/color_table.txt)
  4. gdal2tiles.py — XYZ PNG tiles (--resume safe to add zoom levels)


JAXA AW3D30 resolution vs zoom level (at 35°N):
  zoom 10: ~125 m/px  (coarser than sensor)
  zoom 11:  ~63 m/px  (approaching native)
  zoom 12:  ~31 m/px  ← JAXA AW3D30 native resolution
  zoom 13:  ~16 m/px  (oversampled — beyond sensor resolution)

Requirements:
  Debian/Ubuntu : apt install gdal-bin python3-gdal python3-numpy
  Rocky Linux   : dnf install gdal gdal-python3 python3-numpy

Usage:
  python3 scripts/generate_tiles.py            # zoom 11-12 (default)
  python3 scripts/generate_tiles.py 11 11      # zoom 11 only
  python3 scripts/generate_tiles.py 11 12      # zoom 11-12
  python3 scripts/generate_tiles.py 5 12       # all zoom levels (full regeneration)
  python3 scripts/generate_tiles.py --dry-run  # plan only, no GDAL commands
"""

import argparse
import math
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT_DIR  = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
MAP_DIR     = PROJECT_DIR / 'data' / 'map'
TILES_DIR   = PROJECT_DIR / 'web' / 'tiles'
COLOR_TABLE = SCRIPT_DIR / 'color_table.txt'
NCPU        = os.cpu_count() or 4

# Prevent GDAL from trying to use all available RAM on large rasters.
GDAL_CACHEMAX = '512'


# --------------------------------------------------------------------------- #
# File discovery                                                               #
# --------------------------------------------------------------------------- #

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


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #

def run(cmd, **kw):
    env = dict(os.environ, GDAL_CACHEMAX=GDAL_CACHEMAX)
    print('  $', ' '.join(str(c) for c in cmd))
    sys.stdout.flush()
    subprocess.run([str(c) for c in cmd], check=True, env=env, **kw)


def elapsed_str(t0):
    s = int(time.time() - t0)
    return f'{s//60}m{s%60:02d}s'


def resolution_note(z):
    """Human-readable resolution at zoom z (at 35°N latitude)."""
    mpx = (2 * math.pi * 6378137 * math.cos(math.radians(35))) / (2**z * 256)
    if 20 <= mpx <= 40:
        return f'~{mpx:.0f} m/px  ← JAXA AW3D30 native'
    if mpx < 20:
        return f'~{mpx:.0f} m/px  (beyond sensor — upsampled)'
    return f'~{mpx:.0f} m/px'


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


# --------------------------------------------------------------------------- #
# Main pipeline                                                                #
# --------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('zoom_min', nargs='?', type=int, default=11,
                    help='minimum zoom level to generate (default: 11)')
    ap.add_argument('zoom_max', nargs='?', type=int, default=12,
                    help='maximum zoom level to generate (default: 12)')
    ap.add_argument('--dry-run', action='store_true',
                    help='show plan without running any GDAL commands')
    args = ap.parse_args()

    if not (5 <= args.zoom_min <= args.zoom_max <= 14):
        ap.error('zoom values must satisfy 5 <= zoom_min <= zoom_max <= 14')

    print('=' * 62)
    print(' JAXA AW3D30 → PNG tile generator')
    print(f' Zoom    : {args.zoom_min}–{args.zoom_max}')
    print(f' Output  : {TILES_DIR}/')
    print(f' Procs   : {NCPU}')
    print('=' * 62)
    print()

    for z in range(args.zoom_min, args.zoom_max + 1):
        print(f'  zoom {z}: {resolution_note(z)}')
    print(f'  Approx tiles: {approx_tile_count(args.zoom_min, args.zoom_max):,}')
    print()

    if not COLOR_TABLE.exists():
        print(f'ERROR: color table not found: {COLOR_TABLE}')
        sys.exit(1)

    dsm_files = find_dsm_files()
    msk_files = find_msk_files()
    print(f'DSM files: {len(dsm_files)}')
    print(f'MSK files: {len(msk_files)}')

    if not dsm_files:
        print('ERROR: No DSM files found under map/.')
        print('       Download JAXA AW3D30 data first.')
        sys.exit(1)

    if args.dry_run:
        print('\n(dry run — no GDAL commands executed)')
        return

    print()
    t0 = time.time()

    with tempfile.TemporaryDirectory(prefix='cpp_web_ui_tiles_') as tmpdir:
        tmp = Path(tmpdir)

        # Write file lists for gdalbuildvrt
        (tmp / 'dsm_list.txt').write_text('\n'.join(dsm_files))
        (tmp / 'msk_list.txt').write_text('\n'.join(msk_files))

        merged_dsm = tmp / 'merged_dsm.vrt'
        merged_msk = tmp / 'merged_msk.vrt'
        masked_dsm = tmp / 'masked_dsm.tif'
        color_rel  = tmp / 'color_relief.tif'

        # ---------------------------------------------------------------- #
        # 1. Merge all DSM/MSK files into virtual mosaics (no data copy).  #
        # ---------------------------------------------------------------- #
        print(f'[1/4] Building VRTs from {len(dsm_files)} DSM / '
              f'{len(msk_files)} MSK files...  {elapsed_str(t0)}')
        run(['gdalbuildvrt', '-resolution', 'highest', '-q',
             '-srcnodata', '-9999', '-vrtnodata', '-9999',
             '-input_file_list', tmp / 'dsm_list.txt', merged_dsm])
        if msk_files:
            run(['gdalbuildvrt', '-resolution', 'highest', '-q',
                 '-input_file_list', tmp / 'msk_list.txt', merged_msk])
        else:
            print('  WARNING: no MSK files found — ocean masking skipped')

        # ---------------------------------------------------------------- #
        # 2. Ocean mask: pixels where MSK bit 0-1 == 0x03 → nodata -9999.  #
        #    Processed in 256×256 tiles → no OOM even for full-Japan data.  #
        # ---------------------------------------------------------------- #
        print(f'\n[2/4] Ocean masking (MSK bit 0x03 → nodata)...  '
              f'{elapsed_str(t0)}')
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
            masked_dsm = merged_dsm   # skip ocean masking if no MSK

        # ---------------------------------------------------------------- #
        # 3. Color relief (flat colors, no hillshading).                    #
        # ---------------------------------------------------------------- #
        print(f'\n[3/4] Color relief...  {elapsed_str(t0)}')
        run(['gdaldem', 'color-relief', '-q',
             '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES',
             masked_dsm, COLOR_TABLE, color_rel])

        # ---------------------------------------------------------------- #
        # 4. Generate XYZ PNG tiles.                                        #
        #    --resume skips tiles that already exist on disk.               #
        # ---------------------------------------------------------------- #
        print(f'\n[4/4] Generating tiles (zoom {args.zoom_min}-{args.zoom_max}, '
              f'{NCPU} cores)...  {elapsed_str(t0)}')
        TILES_DIR.mkdir(parents=True, exist_ok=True)
        run(['gdal2tiles.py',
             '--xyz',
             f'--zoom={args.zoom_min}-{args.zoom_max}',
             f'--processes={NCPU}',
             '--resampling=bilinear',
             '--webviewer=none',
             '--resume',
             color_rel,
             TILES_DIR])

    # Report
    total = time.time() - t0
    print()
    print('=' * 62)
    for z in range(args.zoom_min, args.zoom_max + 1):
        zdir = TILES_DIR / str(z)
        n = len(list(zdir.rglob('*.png'))) if zdir.exists() else 0
        print(f'  zoom {z}: {n:,} tiles')
    print(f'Total time: {total / 60:.1f} min')
    print('=' * 62)
    print()
    print('Restart map_server to serve new zoom levels (auto-detected).')
    print()


if __name__ == '__main__':
    main()
