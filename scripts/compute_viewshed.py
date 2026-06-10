#!/usr/bin/env python3
"""
3D radar coverage envelope computation.

For each (azimuth, elevation) direction, traces a ray from the radar outward until
it intersects terrain or reaches max range.  The union of all ray endpoints forms
the outer surface of the 3D coverage volume, returned as a triangular mesh.

Model:
  - Effective Earth radius R_eff = (4/3) * R_earth  (standard atmospheric refraction)
  - Ray altitude at range r:  h = h0 + r*sin(el) - r²/(2*R_eff)
  - Terrain elevation from terrain-RGB tiles (Terrarium encoding, zoom 12)

Input  (stdin): JSON with radar parameters (see PARAMS below)
Output (stdout): JSON  { vertices: [[lon,lat,alt_m], ...], triangles: [[i,j,k], ...], meta: {...} }
Stderr: progress messages

PARAMS:
  lat         float   Radar latitude (degrees)
  lon         float   Radar longitude (degrees)
  height_agl  float   Antenna height above ground level (m)
  range_km    float   Maximum detection range (km)
  az_min      float   Minimum azimuth (degrees, 0=North, clockwise)
  az_max      float   Maximum azimuth (degrees); az_max - az_min >= 360 → full circle
  el_min      float   Minimum elevation angle (degrees; may be negative)
  el_max      float   Maximum elevation angle (degrees)
  az_step     float   Azimuth step (degrees, default 2.0)
  el_step     float   Elevation step (degrees, default 1.0)
  ray_step_m  float   Range step for ray marching (m, default 1000.0)
"""

import json
import math
import sys
from pathlib import Path

try:
    import numpy as np
    from osgeo import gdal
    gdal.UseExceptions()
except ImportError as e:
    print(json.dumps({'error': f'Missing dependency: {e}. '
                               'Install: apt install python3-gdal python3-numpy'}))
    sys.exit(1)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_DIR = Path(__file__).resolve().parent.parent
TERRAIN_DIR = PROJECT_DIR / 'web' / 'terrain-rgb'
TERRAIN_ZOOM = 12

R_EARTH = 6_371_000.0          # m
R_EFF   = R_EARTH * 4.0 / 3.0  # effective Earth radius (4/3 model)

# ---------------------------------------------------------------------------
# Tile / elevation helpers
# ---------------------------------------------------------------------------

_tile_cache: dict[tuple, np.ndarray | None] = {}


def _latlon_to_tile_float(lat: float, lon: float, zoom: int) -> tuple[float, float]:
    n  = 1 << zoom
    fx = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    fy = (1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * n
    return fx, fy


def _load_tile(z: int, x: int, y: int) -> np.ndarray | None:
    key = (z, x, y)
    if key in _tile_cache:
        return _tile_cache[key]

    path = TERRAIN_DIR / str(z) / str(x) / f'{y}.png'
    if not path.exists():
        _tile_cache[key] = None
        return None

    ds = gdal.Open(str(path))
    if ds is None:
        _tile_cache[key] = None
        return None

    r = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
    g = ds.GetRasterBand(2).ReadAsArray().astype(np.float32)
    b = ds.GetRasterBand(3).ReadAsArray().astype(np.float32)
    # Terrarium: elevation = R*256 + G + B/256 - 32768
    elev = r * 256.0 + g + b / 256.0 - 32768.0  # shape (256, 256)

    if len(_tile_cache) > 800:
        for k in list(_tile_cache)[:400]:
            del _tile_cache[k]

    _tile_cache[key] = elev
    return elev


def get_elevation(lat: float, lon: float, zoom: int = TERRAIN_ZOOM) -> float:
    """Return terrain elevation (m ASL) from terrain-RGB tiles."""
    fx, fy = _latlon_to_tile_float(lat, lon, zoom)
    n  = 1 << zoom
    tx = max(0, min(n - 1, int(fx)))
    ty = max(0, min(n - 1, int(fy)))

    tile = _load_tile(zoom, tx, ty)
    if tile is None:
        if zoom > 5:
            return get_elevation(lat, lon, zoom - 1)
        return 0.0

    px = max(0, min(255, int((fx - tx) * 256)))
    py = max(0, min(255, int((fy - ty) * 256)))
    return float(tile[py, px])


# ---------------------------------------------------------------------------
# Geodesy
# ---------------------------------------------------------------------------

def destination(lat0: float, lon0: float,
                bearing_deg: float, dist_m: float) -> tuple[float, float]:
    """Great-circle destination given start point, bearing and distance."""
    lat = math.radians(lat0)
    lon = math.radians(lon0)
    brg = math.radians(bearing_deg)
    d   = dist_m / R_EARTH

    lat2 = math.asin(
        math.sin(lat) * math.cos(d) +
        math.cos(lat) * math.sin(d) * math.cos(brg)
    )
    lon2 = lon + math.atan2(
        math.sin(brg) * math.sin(d) * math.cos(lat),
        math.cos(d) - math.sin(lat) * math.sin(lat2)
    )
    return math.degrees(lat2), math.degrees(lon2)


# ---------------------------------------------------------------------------
# Ray tracer
# ---------------------------------------------------------------------------

def trace_ray(lat0: float, lon0: float, h0_asl: float,
              az_deg: float, el_deg: float,
              max_r_m: float, step_m: float) -> tuple[float, float, float, bool]:
    """
    Trace a radar ray from (lat0, lon0, h0_asl) in direction (az_deg, el_deg).

    Returns (lat, lon, alt_asl, terrain_hit):
      - endpoint on terrain surface if ray is blocked
      - endpoint at max range otherwise
    """
    el        = math.radians(el_deg)
    sin_el    = math.sin(el)
    inv_2reff = 1.0 / (2.0 * R_EFF)

    r = step_m
    prev_lat, prev_lon = lat0, lon0

    while r <= max_r_m:
        lat, lon   = destination(lat0, lon0, az_deg, r)
        h_ray      = h0_asl + r * sin_el - r * r * inv_2reff
        h_ter      = get_elevation(lat, lon)

        if h_ray <= h_ter:
            # Linearly interpolate terrain hit between previous and current step
            # for a smoother surface
            r_prev = r - step_m
            lat_p, lon_p = destination(lat0, lon0, az_deg, r_prev)
            h_ray_p = h0_asl + r_prev * sin_el - r_prev * r_prev * inv_2reff
            h_ter_p = get_elevation(lat_p, lon_p)

            # Fraction along [r_prev, r] where h_ray == h_ter
            dh_ray = h_ray - h_ray_p
            dh_ter = h_ter - h_ter_p
            denom  = (dh_ray - dh_ter)
            if abs(denom) > 0.01:
                t = (h_ter_p - h_ray_p) / denom
                t = max(0.0, min(1.0, t))
                r_hit = r_prev + t * step_m
                lat_h, lon_h = destination(lat0, lon0, az_deg, r_hit)
                alt_h = get_elevation(lat_h, lon_h)
            else:
                lat_h, lon_h, alt_h = lat, lon, h_ter

            return lat_h, lon_h, alt_h, True

        prev_lat, prev_lon = lat, lon
        r += step_m

    # Reached max range without terrain hit
    lat, lon = destination(lat0, lon0, az_deg, max_r_m)
    h_ray    = h0_asl + max_r_m * sin_el - max_r_m * max_r_m * inv_2reff
    h_ter    = get_elevation(lat, lon)
    return lat, lon, max(h_ray, h_ter), False


# ---------------------------------------------------------------------------
# Mesh builder
# ---------------------------------------------------------------------------

def _make_angles(start: float, stop: float, step: float) -> list[float]:
    vals: list[float] = []
    v = start
    while v < stop - step * 0.01:
        vals.append(v)
        v += step
    vals.append(stop)
    return vals


def compute(params: dict) -> dict:
    lat0     = float(params['lat'])
    lon0     = float(params['lon'])
    h_agl    = float(params['height_agl'])
    range_km = float(params['range_km'])
    az_min   = float(params['az_min'])
    az_max   = float(params['az_max'])
    el_min   = float(params['el_min'])
    el_max   = float(params['el_max'])
    az_step  = float(params.get('az_step',  2.0))
    el_step  = float(params.get('el_step',  1.0))
    ray_step = float(params.get('ray_step_m', 1000.0))

    h_asl0  = get_elevation(lat0, lon0) + h_agl
    max_r_m = range_km * 1000.0

    full_circle = (az_max - az_min) >= 359.9
    if full_circle:
        # 0 … 360-step; stitch last column back to first in mesh
        azimuths = _make_angles(0.0, 360.0 - az_step, az_step)
    else:
        azimuths = _make_angles(az_min, az_max, az_step)
    elevations = _make_angles(el_min, el_max, el_step)

    n_az, n_el = len(azimuths), len(elevations)
    total      = n_az * n_el

    print(f'  Rays: {n_az} az × {n_el} el = {total}', file=sys.stderr)

    # ---- Compute ray endpoints ----
    # grid[az_idx][el_idx] = [lon, lat, alt_asl]
    grid: list[list[list[float]]] = []
    done = 0

    for az in azimuths:
        row: list[list[float]] = []
        for el in elevations:
            lat, lon, alt, _ = trace_ray(
                lat0, lon0, h_asl0, az, el, max_r_m, ray_step)
            row.append([lon, lat, alt])
            done += 1
        grid.append(row)
        pct = done * 100 // total
        sys.stderr.write(f'\r  Ray tracing... {pct:3d}%  ({done}/{total})')
        sys.stderr.flush()
    sys.stderr.write('\n')

    # ---- Build triangular mesh ----
    vertices:  list[list[float]] = []
    triangles: list[list[int]]   = []

    # Flatten grid into vertex array; build index table
    idx = [[0] * n_el for _ in range(n_az)]
    for i in range(n_az):
        for j in range(n_el):
            idx[i][j] = len(vertices)
            vertices.append(grid[i][j])

    # Apex vertex = radar position
    apex = len(vertices)
    vertices.append([lon0, lat0, h_asl0])

    def col_next(i: int) -> int:
        """Next azimuth column index (wraps for full circle)."""
        return (i + 1) % n_az if full_circle else i + 1

    az_range = range(n_az) if full_circle else range(n_az - 1)

    # Outer surface (between adjacent az/el rays)
    for i in az_range:
        ni = col_next(i)
        for j in range(n_el - 1):
            a, b = idx[i][j],   idx[ni][j]
            c, d = idx[i][j+1], idx[ni][j+1]
            triangles += [[a, b, d], [a, d, c]]

    if not full_circle:
        # Bottom edge → apex (min elevation sweep)
        for i in range(n_az - 1):
            triangles.append([apex, idx[i][0], idx[i+1][0]])
        # Top edge → apex (max elevation sweep)
        for i in range(n_az - 1):
            triangles.append([apex, idx[i+1][n_el-1], idx[i][n_el-1]])
        # Left side (az_min) → apex
        for j in range(n_el - 1):
            triangles.append([apex, idx[0][j], idx[0][j+1]])
        # Right side (az_max) → apex
        for j in range(n_el - 1):
            triangles.append([apex, idx[n_az-1][j+1], idx[n_az-1][j]])
    else:
        # Full circle: close top and bottom with apex fan
        for i in az_range:
            ni = col_next(i)
            triangles.append([apex, idx[i][0],       idx[ni][0]])
            triangles.append([apex, idx[ni][n_el-1], idx[i][n_el-1]])

    return {
        'vertices':  vertices,
        'triangles': triangles,
        'meta': {
            'lat': lat0, 'lon': lon0,
            'alt_asl': h_asl0,
            'range_km': range_km,
            'n_vertices':  len(vertices),
            'n_triangles': len(triangles),
        }
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    params = json.load(sys.stdin)
    result = compute(params)
    json.dump(result, sys.stdout, separators=(',', ':'))
    print(file=sys.stderr)  # final newline on stderr
