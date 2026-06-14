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
  ray_step_m  float   Range step for ray marching (m, default 500.0)
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
              max_r_m: float, step_m: float) -> tuple[float, float, float, bool, float]:
    """
    Trace a radar ray from (lat0, lon0, h0_asl) in direction (az_deg, el_deg).

    Returns (lat, lon, alt_asl, terrain_hit, range_m):
      - endpoint on terrain surface and range_m = hit distance if blocked
      - endpoint at max range and range_m = max_r_m otherwise
    """
    el        = math.radians(el_deg)
    sin_el    = math.sin(el)
    inv_2reff = 1.0 / (2.0 * R_EFF)

    r = step_m

    while r <= max_r_m:
        lat, lon   = destination(lat0, lon0, az_deg, r)
        h_ray      = h0_asl + r * sin_el - r * r * inv_2reff
        h_ter      = get_elevation(lat, lon)

        if h_ray <= h_ter:
            # Linearly interpolate terrain hit between previous and current step
            r_prev = r - step_m
            lat_p, lon_p = destination(lat0, lon0, az_deg, r_prev)
            h_ray_p = h0_asl + r_prev * sin_el - r_prev * r_prev * inv_2reff
            h_ter_p = get_elevation(lat_p, lon_p)

            dh_ray = h_ray - h_ray_p
            dh_ter = h_ter - h_ter_p
            denom  = (dh_ray - dh_ter)
            if abs(denom) > 0.01:
                t = max(0.0, min(1.0, (h_ter_p - h_ray_p) / denom))
                r_hit = r_prev + t * step_m
                lat_h, lon_h = destination(lat0, lon0, az_deg, r_hit)
                alt_h = get_elevation(lat_h, lon_h)
            else:
                lat_h, lon_h, alt_h, r_hit = lat, lon, h_ter, r

            return lat_h, lon_h, alt_h, True, r_hit

        r += step_m

    # Reached max range without terrain hit
    lat, lon = destination(lat0, lon0, az_deg, max_r_m)
    h_ray    = h0_asl + max_r_m * sin_el - max_r_m * max_r_m * inv_2reff
    h_ter    = get_elevation(lat, lon)
    return lat, lon, max(h_ray, h_ter), False, max_r_m


# ---------------------------------------------------------------------------
# Vertical cross-section
# ---------------------------------------------------------------------------

def compute_section(lat0: float, lon0: float, h_asl0: float,
                    az_deg: float, el_max_deg: float,
                    range_km: float, ray_step_m: float) -> dict:
    """
    Compute a vertical cross-section along az_deg.

    Uses a horizon-angle scan to determine shadow zones.
    At each range step:
      - terrain_m : terrain elevation (m ASL)
      - min_vis_m : lowest altitude visible from radar at this range
                    (= terrain if directly visible; horizon-line altitude if shadowed)
      - max_cov_m : altitude of the el_max beam (upper coverage boundary)
    """
    el_max_rad = math.radians(el_max_deg)
    max_r_m    = range_km * 1000.0
    inv_2reff  = 1.0 / (2.0 * R_EFF)

    range_list:   list[float] = []
    terrain_list: list[float] = []
    min_vis_list: list[float] = []
    max_cov_list: list[float] = []

    max_el_hor = float('-inf')   # highest terrain elevation angle seen so far
    r = ray_step_m
    while True:
        r = min(r, max_r_m)
        lat, lon = destination(lat0, lon0, az_deg, r)
        ter = get_elevation(lat, lon)

        # Elevation angle from radar to terrain at r (with Earth-curvature correction)
        el_ter = math.atan2(ter - h_asl0 + r * r * inv_2reff, r)

        if el_ter > max_el_hor:
            # Terrain is directly visible — update the horizon
            min_vis = ter
            max_el_hor = el_ter
        else:
            # Shadow zone — lowest visible altitude is on the horizon line
            h_hor   = h_asl0 + r * math.sin(max_el_hor) - r * r * inv_2reff
            min_vis = max(ter, h_hor)

        max_cov = h_asl0 + r * math.sin(el_max_rad) - r * r * inv_2reff

        range_list.append(round(r / 1000.0, 3))
        terrain_list.append(round(ter, 1))
        min_vis_list.append(round(min_vis, 1))
        max_cov_list.append(round(max_cov, 1))

        if r >= max_r_m:
            break
        r += ray_step_m

    return {
        'az_deg':      round(az_deg, 1),
        'radar_alt_m': round(h_asl0, 1),
        'range_km':    range_list,
        'terrain_m':   terrain_list,
        'min_vis_m':   min_vis_list,
        'max_cov_m':   max_cov_list,
    }


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
    ray_step = float(params.get('ray_step_m', 500.0))

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
    # grid[az_idx][el_idx]   = [lon, lat, alt_asl]
    # ranges[az_idx][el_idx] = range in metres at which ray terminated
    # hits[az_idx][el_idx]   = True if ray was blocked by terrain
    grid:   list[list[list[float]]] = []
    ranges: list[list[float]]       = []
    hits:   list[list[bool]]        = []
    done = 0

    for az in azimuths:
        row:  list[list[float]] = []
        rrow: list[float]       = []
        hrow: list[bool]        = []
        for el in elevations:
            lat, lon, alt, hit, rng = trace_ray(
                lat0, lon0, h_asl0, az, el, max_r_m, ray_step)
            row.append([lon, lat, alt])
            rrow.append(rng)
            hrow.append(hit)
            done += 1
        grid.append(row)
        ranges.append(rrow)
        hits.append(hrow)
        pct = done * 100 // total
        sys.stderr.write(f'\r  Ray tracing... {pct:3d}%  ({done}/{total})')
        sys.stderr.flush()
    sys.stderr.write('\n')

    # ---- Build triangular mesh ----
    # Only the outer boundary surface is generated — no closing faces to the
    # radar apex or ground.  Closing faces (bottom/top fans, side walls) made
    # the volume look like a cylinder; the open shell better represents the
    # 3-D region that radar beams pass through.
    vertices:  list[list[float]] = []
    triangles: list[list[int]]   = []

    # Flatten grid into vertex array; build index table
    idx = [[0] * n_el for _ in range(n_az)]
    for i in range(n_az):
        for j in range(n_el):
            idx[i][j] = len(vertices)
            vertices.append(grid[i][j])

    def col_next(i: int) -> int:
        """Next azimuth column index (wraps for full circle)."""
        return (i + 1) % n_az if full_circle else i + 1

    az_range = range(n_az) if full_circle else range(n_az - 1)

    # Outer boundary surface only (open shell).
    # Skip quads that straddle a terrain-shadow boundary: these occur when some
    # rays are blocked by terrain at short range while adjacent rays clear the
    # terrain and reach much farther.  Keeping such quads makes the coverage
    # appear to "wrap around" mountains and include their shadowed far sides.
    # A quad is skipped when it mixes terrain-hit and non-terrain-hit vertices
    # AND the ratio of max-range to min-range exceeds SHADOW_RATIO.
    SHADOW_RATIO = 1.5

    for i in az_range:
        ni = col_next(i)
        for j in range(n_el - 1):
            h00 = hits[i][j];   h10 = hits[ni][j]
            h01 = hits[i][j+1]; h11 = hits[ni][j+1]
            any_hit = h00 or h10 or h01 or h11
            all_hit = h00 and h10 and h01 and h11

            if any_hit and not all_hit:
                r00 = ranges[i][j];   r10 = ranges[ni][j]
                r01 = ranges[i][j+1]; r11 = ranges[ni][j+1]
                rmin = min(r00, r10, r01, r11)
                rmax = max(r00, r10, r01, r11)
                if rmin > 0 and rmax > SHADOW_RATIO * rmin:
                    continue  # terrain shadow boundary — leave hole in mesh

            a, b = idx[i][j],   idx[ni][j]
            c, d = idx[i][j+1], idx[ni][j+1]
            triangles += [[a, b, d], [a, d, c]]

    # Vertical cross-section at center azimuth
    sec_az = 0.0 if full_circle else (az_min + az_max) / 2.0
    section = compute_section(lat0, lon0, h_asl0, sec_az, el_max, range_km, ray_step)

    return {
        'vertices':  vertices,
        'triangles': triangles,
        'meta': {
            'lat': lat0, 'lon': lon0,
            'alt_asl': h_asl0,
            'range_km': range_km,
            'n_az': n_az, 'n_el': n_el,
            'full_circle': full_circle,
            'n_vertices':  len(vertices),
            'n_triangles': len(triangles),
        },
        'section': section,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    params = json.load(sys.stdin)

    if params.get('section_only'):
        # Lightweight path: compute only the vertical cross-section, no mesh.
        lat0     = float(params['lat'])
        lon0     = float(params['lon'])
        h_asl0   = get_elevation(lat0, lon0) + float(params['height_agl'])
        az_deg   = float(params.get('az_deg', 0.0))
        el_max   = float(params['el_max'])
        range_km = float(params['range_km'])
        ray_step = float(params.get('ray_step_m', 500.0))
        section  = compute_section(lat0, lon0, h_asl0, az_deg, el_max, range_km, ray_step)
        json.dump({'section': section}, sys.stdout, separators=(',', ':'))
    else:
        result = compute(params)
        json.dump(result, sys.stdout, separators=(',', ':'))

    print(file=sys.stderr)  # final newline on stderr
