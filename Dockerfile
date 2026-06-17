###############################################################################
# cpp_web_ui — Multi-stage Dockerfile (Rocky Linux 9)
#
# ── Stages ───────────────────────────────────────────────────────────────────
#  builder      C++ build (cmake + gcc + openssl-devel)
#  runtime      Minimal runtime image: binary + pre-generated web assets/tiles
#  tile-builder Tile generation image (GDAL + Python); not part of runtime
#
# ── Quick start ──────────────────────────────────────────────────────────────
#  # Build runtime image (tiles in web/ must be pre-generated on host)
#  docker build --target runtime -t cpp_web_ui .
#  docker run -p 9000:9000 cpp_web_ui
#
#  # Custom port
#  docker run -p 8080:8080 -e PORT=8080 cpp_web_ui
#
#  # Persist overlay tile cache between restarts
#  docker run -p 9000:9000 \
#      -v $(pwd)/web/overlay-tiles:/app/web/overlay-tiles \
#      cpp_web_ui
#
# ── Tile regeneration ────────────────────────────────────────────────────────
#  # Build the tile-builder image
#  docker build --target tile-builder -t cpp_web_ui:tile-builder .
#
#  # Dry-run (plan only, no files written)
#  docker run --rm \
#      -v $(pwd)/map:/app/map:ro \
#      -v $(pwd)/web:/app/web \
#      cpp_web_ui:tile-builder scripts/generate_all_tiles.sh --dry-run
#
#  # Generate all tiles (color-relief zoom 11, terrain-rgb zoom 5-12, overlay zoom 5-10)
#  docker run --rm \
#      -v $(pwd)/map:/app/map:ro \
#      -v $(pwd)/web:/app/web \
#      cpp_web_ui:tile-builder
#
###############################################################################

###############################################################################
# Stage 1 — C++ build
###############################################################################
FROM rockylinux:9 AS builder

RUN dnf groupinstall -y "Development Tools" && \
    dnf install -y cmake openssl-devel && \
    dnf clean all

WORKDIR /build

# Copy only source files needed for compilation.
# web/ and map/ are intentionally excluded here to keep this stage small.
COPY CMakeLists.txt ./
COPY cmake/         cmake/
COPY include/       include/
COPY src/           src/
COPY third_party/   third_party/
COPY examples/      examples/

RUN cmake -S . -B out -DCPP_WEB_UI_BUILD_EXAMPLES=ON && \
    cmake --build out -j"$(nproc)"

###############################################################################
# Stage 2 — Runtime
###############################################################################
FROM rockylinux:9 AS runtime

# openssl-libs provides libssl.so.3 / libcrypto.so.3 needed by the HTTPS proxy
RUN dnf install -y openssl-libs && \
    dnf clean all

WORKDIR /app

# Binary compiled in the builder stage
COPY --from=builder /build/out/simple_usage ./

# Web assets — cache-friendly layer ordering (static libs first, tiles last)
# Tiles are large (web/tiles ≈ 2.6 GB, web/terrain-rgb ≈ 3.0 GB) but rarely
# rebuild after generation, so Docker layer cache keeps rebuilds fast when
# only app.js / index.html change.
COPY web/lib/        web/lib/
COPY web/index.html  web/index.html
COPY web/app.js      web/app.js
COPY web/style.css   web/style.css
COPY web/tiles/      web/tiles/
COPY web/terrain-rgb/ web/terrain-rgb/
# overlay-tiles are sparse/empty at build time; the server caches fetched tiles
# here automatically. Mount as a named volume to persist across container restarts.
COPY web/overlay-tiles/ web/overlay-tiles/

# web_root is auto-detected from /proc/self/exe (looks for ./web relative to
# the binary directory), so no env var is required. Setting it explicitly here
# makes the detection path unambiguous inside containers.
ENV CPP_WEB_UI_WEB_ROOT=/app/web

# Port is configurable via the PORT environment variable (default 9000).
ENV PORT=9000
EXPOSE 9000

# exec replaces the shell as PID 1 so SIGTERM/SIGINT reach simple_usage directly.
CMD exec /app/simple_usage "${PORT}"

###############################################################################
# Stage 3 — Tile generation (optional; not part of runtime image)
#
# Use this stage to regenerate tiles from JAXA AW3D30 GeoTIFF data.
# The map/ directory (≈ 19 GB) must be available on the host and is mounted
# as a read-only volume at runtime — it is never baked into the image.
###############################################################################
# Debian is used here because GDAL is available directly in the official
# repositories (no EPEL equivalent needed). Switch to rockylinux:9 with
# dnf install -y epel-release gdal python3-gdal python3-numpy if you
# prefer a RHEL-family base for this stage.
FROM debian:12-slim AS tile-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gdal-bin python3-gdal python3-numpy && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scripts/ scripts/

# /app/map  — mount JAXA GeoTIFF source data here (read-only)
# /app/web  — mount web/ output directory here (read-write for tile output)
VOLUME ["/app/map", "/app/web"]

# Default: generate all tiles (color-relief zoom 11, terrain-rgb, overlay).
# Pass arguments to override, e.g.:
#   docker run ... cpp_web_ui:tile-builder scripts/generate_all_tiles.sh --dry-run
#   docker run ... cpp_web_ui:tile-builder scripts/generate_all_tiles.sh --full
CMD ["scripts/generate_all_tiles.sh"]
