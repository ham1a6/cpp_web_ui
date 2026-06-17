#!/usr/bin/env bash
#
# Batch-generate all tile sets for cpp_web_ui:
#   1. generate_tiles.py        — JAXA AW3D30 color-relief tiles (web/tiles/)
#   2. generate_terrain_rgb.py  — Terrarium elevation tiles (web/terrain-rgb/)
#   3. download_overlay_tiles.py — GSI overlay tiles (web/overlay-tiles/, needs internet)
#
# Usage:
#   scripts/generate_all_tiles.sh                  # zoom 11 tiles + terrain-rgb + overlay
#   scripts/generate_all_tiles.sh --full            # also zoom 12 tiles (~8 GB, ~2 h)
#   scripts/generate_all_tiles.sh --skip-overlay    # skip overlay download (offline JAXA data only)
#   scripts/generate_all_tiles.sh --dry-run         # print the plan for each step, no files written
#   scripts/generate_all_tiles.sh --overlay-zoom 11-16 --overlay-bbox 35.3,138.8,36.2,140.3
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

FULL=0
SKIP_OVERLAY=0
DRY_RUN=0
OVERLAY_ZOOM="5-10"
OVERLAY_BBOX=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --full)            FULL=1; shift ;;
        --skip-overlay)     SKIP_OVERLAY=1; shift ;;
        --dry-run)          DRY_RUN=1; shift ;;
        --overlay-zoom)     OVERLAY_ZOOM="$2"; shift 2 ;;
        --overlay-bbox)     OVERLAY_BBOX="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,14p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "unknown option: $1" >&2
            exit 1
            ;;
    esac
done

PYTHON3="${PYTHON3:-python3}"

command -v "$PYTHON3" >/dev/null 2>&1 || {
    echo "error: python3 not found (set PYTHON3=... to override)" >&2
    exit 1
}
"$PYTHON3" -c "import osgeo" >/dev/null 2>&1 || {
    echo "error: python3-gdal not installed." >&2
    echo "  Debian/Ubuntu : sudo apt install gdal-bin python3-gdal python3-numpy" >&2
    echo "  Rocky Linux   : sudo dnf install gdal gdal-python3 python3-numpy" >&2
    exit 1
}

step() { printf '\n=== %s ===\n' "$1"; }

cd "$PROJECT_DIR"

DRY_FLAG=()
[[ $DRY_RUN -eq 1 ]] && DRY_FLAG=(--dry-run)

step "Color-relief tiles (web/tiles/)"
if [[ $FULL -eq 1 ]]; then
    "$PYTHON3" scripts/generate_tiles.py 11 12 "${DRY_FLAG[@]}"
else
    "$PYTHON3" scripts/generate_tiles.py 11 11 "${DRY_FLAG[@]}"
fi

step "Terrain-RGB elevation tiles (web/terrain-rgb/)"
"$PYTHON3" scripts/generate_terrain_rgb.py "${DRY_FLAG[@]}"

if [[ $SKIP_OVERLAY -eq 0 ]]; then
    step "GSI overlay tiles (web/overlay-tiles/)"
    overlay_args=(--zoom "$OVERLAY_ZOOM")
    [[ -n "$OVERLAY_BBOX" ]] && overlay_args+=(--bbox "$OVERLAY_BBOX")
    "$PYTHON3" scripts/download_overlay_tiles.py "${overlay_args[@]}" "${DRY_FLAG[@]}"
else
    step "GSI overlay tiles — skipped (--skip-overlay)"
fi

step "Done"
echo "Restart the server to pick up new tiles (max_native_zoom is auto-detected on startup)."
