// STB_IMAGE_IMPLEMENTATION must be defined in exactly one translation unit.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-qual"
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#pragma GCC diagnostic ignored "-Wdouble-promotion"
#pragma GCC diagnostic ignored "-Wunused-function"
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#include "stb_image.h"
#pragma GCC diagnostic pop

#include "json.hpp"
#include <cpp_web_ui/ViewshedComputer.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;
using json   = nlohmann::json;

namespace cpp_web_ui {

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------
static constexpr double R_EARTH  = 6'371'000.0;
static constexpr double R_EFF    = R_EARTH * 4.0 / 3.0; // 4/3 effective Earth radius
static constexpr double DEG2RAD  = M_PI / 180.0;

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

struct ViewshedComputer::Impl {
    fs::path terrain_dir;
    int      zoom;

    // Tile cache: uint64 key → 256×256 float elevation array (null = missing)
    mutable std::mutex cache_mu;
    mutable std::unordered_map<
        uint64_t,
        std::shared_ptr<const std::vector<float>>> tile_cache;

    Impl(const std::string& dir, int z) : terrain_dir(dir), zoom(z) {}

    // -------------------------------------------------------------------------
    // Tile loading
    // -------------------------------------------------------------------------

    static uint64_t tileKey(int z, int x, int y) noexcept {
        return (uint64_t)z * 1'000'000'000ULL
             + (uint64_t)x * 100'000ULL
             + (uint64_t)(uint32_t)y;
    }

    // Returns shared_ptr to 256*256 float array, or null if tile is missing.
    std::shared_ptr<const std::vector<float>>
    loadTile(int z, int x, int y) const {
        const uint64_t key = tileKey(z, x, y);

        // Fast path: already cached
        {
            std::lock_guard lk(cache_mu);
            auto it = tile_cache.find(key);
            if (it != tile_cache.end()) return it->second;
        }

        // Load PNG outside the lock (I/O should not block other threads)
        std::shared_ptr<std::vector<float>> tile;

        fs::path path = terrain_dir
            / std::to_string(z) / std::to_string(x)
            / (std::to_string(y) + ".png");

        if (fs::exists(path)) {
            int w = 0, h = 0, ch = 0;
            uint8_t* data = stbi_load(path.string().c_str(), &w, &h, &ch, 3);
            if (data) {
                if (w == 256 && h == 256) {
                    auto elev = std::make_shared<std::vector<float>>(256 * 256);
                    for (int i = 0; i < 256 * 256; ++i) {
                        float R = data[i*3    ];
                        float G = data[i*3 + 1];
                        float B = data[i*3 + 2];
                        // Terrarium encoding: elevation = R*256 + G + B/256 - 32768
                        (*elev)[i] = R * 256.0f + G + B / 256.0f - 32768.0f;
                    }
                    tile = std::move(elev);
                }
                stbi_image_free(data);
            }
        }

        std::lock_guard lk(cache_mu);
        // Evict oldest half when cache grows large
        if (tile_cache.size() > 800) {
            auto it = tile_cache.begin();
            std::advance(it, 400);
            tile_cache.erase(tile_cache.begin(), it);
        }
        return tile_cache[key] = tile; // stores null shared_ptr for missing tiles
    }

    // -------------------------------------------------------------------------
    // Coordinate math
    // -------------------------------------------------------------------------

    static std::pair<double,double>
    latLonToTileFloat(double lat, double lon, int z) {
        double n  = (double)(1 << z);
        double fx = (lon + 180.0) / 360.0 * n;
        double lr = lat * DEG2RAD;
        double fy = (1.0 - std::log(std::tan(lr) + 1.0 / std::cos(lr)) / M_PI)
                    / 2.0 * n;
        return {fx, fy};
    }

    float getElevation(double lat, double lon, int z) const {
        auto [fx, fy] = latLonToTileFloat(lat, lon, z);
        int n  = 1 << z;
        int tx = std::clamp((int)fx, 0, n - 1);
        int ty = std::clamp((int)fy, 0, n - 1);

        auto tile = loadTile(z, tx, ty);
        if (!tile) {
            // Fall back to a coarser zoom if tile is missing
            return z > 5 ? getElevation(lat, lon, z - 1) : 0.0f;
        }
        int px = std::clamp((int)((fx - tx) * 256), 0, 255);
        int py = std::clamp((int)((fy - ty) * 256), 0, 255);
        return (*tile)[py * 256 + px];
    }

    float getElevation(double lat, double lon) const {
        return getElevation(lat, lon, zoom);
    }

    // -------------------------------------------------------------------------
    // Geodesy: great-circle destination point
    // -------------------------------------------------------------------------

    static std::pair<double,double>
    destination(double lat0, double lon0, double bearing_deg, double dist_m) {
        double lat = lat0 * DEG2RAD;
        double lon = lon0 * DEG2RAD;
        double brg = bearing_deg * DEG2RAD;
        double d   = dist_m / R_EARTH;

        double sin_lat = std::sin(lat), cos_lat = std::cos(lat);
        double sin_d   = std::sin(d),   cos_d   = std::cos(d);

        double lat2 = std::asin(sin_lat * cos_d
                               + cos_lat * sin_d * std::cos(brg));
        double lon2 = lon + std::atan2(std::sin(brg) * sin_d * cos_lat,
                                       cos_d - sin_lat * std::sin(lat2));
        return {lat2 / DEG2RAD, lon2 / DEG2RAD};
    }

    // -------------------------------------------------------------------------
    // Ray tracer
    // -------------------------------------------------------------------------

    struct RayResult {
        double lat, lon, alt_asl;
        bool   terrain_hit;
        double range_m;
    };

    RayResult traceRay(double lat0, double lon0, double h0_asl,
                       double az_deg, double el_deg,
                       double max_r_m, double step_m) const {
        const double el        = el_deg * DEG2RAD;
        const double sin_el    = std::sin(el);
        const double inv_2reff = 1.0 / (2.0 * R_EFF);

        for (double r = step_m; r <= max_r_m; r += step_m) {
            auto [lat, lon] = destination(lat0, lon0, az_deg, r);
            double h_ray = h0_asl + r * sin_el - r * r * inv_2reff;
            double h_ter = (double)getElevation(lat, lon);

            if (h_ray <= h_ter) {
                // Linearly interpolate the hit point between prev and current step
                double r_prev  = r - step_m;
                auto [lp, lop] = destination(lat0, lon0, az_deg, r_prev);
                double h_ray_p = h0_asl + r_prev * sin_el - r_prev * r_prev * inv_2reff;
                double h_ter_p = (double)getElevation(lp, lop);
                double denom   = (h_ray - h_ray_p) - (h_ter - h_ter_p);

                if (std::abs(denom) > 0.01) {
                    double t      = std::clamp((h_ter_p - h_ray_p) / denom, 0.0, 1.0);
                    double r_hit  = r_prev + t * step_m;
                    auto [lh, oh] = destination(lat0, lon0, az_deg, r_hit);
                    return {lh, oh, (double)getElevation(lh, oh), true, r_hit};
                }
                return {lat, lon, h_ter, true, r};
            }
        }

        // Reached max range without terrain intersection
        auto [lat, lon] = destination(lat0, lon0, az_deg, max_r_m);
        double h_ray = h0_asl + max_r_m * sin_el - max_r_m * max_r_m * inv_2reff;
        double h_ter = (double)getElevation(lat, lon);
        return {lat, lon, std::max(h_ray, h_ter), false, max_r_m};
    }

    // -------------------------------------------------------------------------
    // Vertical cross-section (horizon-angle scan)
    // -------------------------------------------------------------------------

    json computeSection(double lat0, double lon0, double h_asl0,
                        double az_deg, double el_max_deg,
                        double range_km, double ray_step_m) const {
        const double el_max_rad = el_max_deg * DEG2RAD;
        const double max_r_m   = range_km * 1000.0;
        const double inv_2reff = 1.0 / (2.0 * R_EFF);

        std::vector<double> range_list, terrain_list, min_vis_list, max_cov_list;

        double max_el_hor = -1e30; // highest terrain elevation angle seen so far

        for (double r = ray_step_m; ; r += ray_step_m) {
            r = std::min(r, max_r_m);

            auto [lat, lon] = destination(lat0, lon0, az_deg, r);
            double ter = (double)getElevation(lat, lon);

            // Elevation angle from radar to terrain at r (with Earth-curvature)
            double el_ter = std::atan2(ter - h_asl0 + r * r * inv_2reff, r);

            double min_vis;
            if (el_ter > max_el_hor) {
                max_el_hor = el_ter;
                min_vis    = ter; // directly visible — terrain itself
            } else {
                // Shadow zone — lowest visible altitude is on the horizon line
                double h_hor = h_asl0 + r * std::sin(max_el_hor) - r * r * inv_2reff;
                min_vis = std::max(ter, h_hor);
            }

            double max_cov = h_asl0 + r * std::sin(el_max_rad) - r * r * inv_2reff;

            range_list.push_back(  std::round(r / 1000.0 * 1000.0) / 1000.0);
            terrain_list.push_back(std::round(ter     * 10.0) / 10.0);
            min_vis_list.push_back(std::round(min_vis * 10.0) / 10.0);
            max_cov_list.push_back(std::round(max_cov * 10.0) / 10.0);

            if (r >= max_r_m) break;
        }

        return json{
            {"az_deg",      std::round(az_deg  * 10.0) / 10.0},
            {"radar_alt_m", std::round(h_asl0  * 10.0) / 10.0},
            {"range_km",    range_list},
            {"terrain_m",   terrain_list},
            {"min_vis_m",   min_vis_list},
            {"max_cov_m",   max_cov_list},
        };
    }

    // -------------------------------------------------------------------------
    // Angle sequence generator (mirrors Python _make_angles)
    // -------------------------------------------------------------------------

    static std::vector<double>
    makeAngles(double start, double stop, double step) {
        std::vector<double> v;
        for (double a = start; a < stop - step * 0.01; a += step)
            v.push_back(a);
        v.push_back(stop);
        return v;
    }

    // -------------------------------------------------------------------------
    // Full 3-D mesh computation
    // -------------------------------------------------------------------------

    std::string compute(const json& p) const {
        const double lat0     = p["lat"].get<double>();
        const double lon0     = p["lon"].get<double>();
        const double h_agl    = p["height_agl"].get<double>();
        const double range_km = p["range_km"].get<double>();
        const double az_min   = p["az_min"].get<double>();
        const double az_max   = p["az_max"].get<double>();
        const double el_min   = p["el_min"].get<double>();
        const double el_max   = p["el_max"].get<double>();
        const double az_step  = p.value("az_step",    2.0);
        const double el_step  = p.value("el_step",    1.0);
        const double ray_step = p.value("ray_step_m", 500.0);

        const double h_asl0  = (double)getElevation(lat0, lon0) + h_agl;
        const double max_r_m = range_km * 1000.0;

        const bool full_circle = (az_max - az_min) >= 359.9;
        auto azimuths  = full_circle
                       ? makeAngles(0.0, 360.0 - az_step, az_step)
                       : makeAngles(az_min, az_max, az_step);
        auto elevations = makeAngles(el_min, el_max, el_step);

        const int n_az = (int)azimuths.size();
        const int n_el = (int)elevations.size();

        // ---- Ray trace ----
        struct Vtx { double lon, lat, alt; };
        std::vector<std::vector<Vtx>>    grid  (n_az, std::vector<Vtx>   (n_el));
        std::vector<std::vector<double>> ranges(n_az, std::vector<double> (n_el));
        std::vector<std::vector<bool>>   hits  (n_az, std::vector<bool>   (n_el));

        for (int i = 0; i < n_az; ++i) {
            for (int j = 0; j < n_el; ++j) {
                auto r       = traceRay(lat0, lon0, h_asl0,
                                        azimuths[i], elevations[j],
                                        max_r_m, ray_step);
                grid[i][j]   = {r.lon, r.lat, r.alt_asl};
                ranges[i][j] = r.range_m;
                hits[i][j]   = r.terrain_hit;
            }
        }

        // ---- Flatten grid into vertex array ----
        std::vector<std::array<double,3>> verts;
        verts.reserve((size_t)n_az * n_el);
        std::vector<std::vector<int>> idx(n_az, std::vector<int>(n_el));
        for (int i = 0; i < n_az; ++i)
            for (int j = 0; j < n_el; ++j) {
                idx[i][j] = (int)verts.size();
                verts.push_back({grid[i][j].lon, grid[i][j].lat, grid[i][j].alt});
            }

        // ---- Build triangle index list ----
        // Skip quads that straddle terrain-shadow boundaries to leave
        // visible holes in the mesh (see Python script for rationale).
        auto colNext = [&](int i) {
            return full_circle ? (i + 1) % n_az : i + 1;
        };
        const int az_imax = full_circle ? n_az : n_az - 1;

        constexpr double SHADOW_RATIO = 1.5;
        std::vector<std::array<int,3>> tris;
        tris.reserve((size_t)az_imax * (n_el - 1) * 2);

        for (int i = 0; i < az_imax; ++i) {
            int ni = colNext(i);
            for (int j = 0; j < n_el - 1; ++j) {
                bool h00 = hits[i][j],   h10 = hits[ni][j];
                bool h01 = hits[i][j+1], h11 = hits[ni][j+1];

                if ((h00 || h10 || h01 || h11) && !(h00 && h10 && h01 && h11)) {
                    double rmin = std::min({ranges[i][j],  ranges[ni][j],
                                            ranges[i][j+1],ranges[ni][j+1]});
                    double rmax = std::max({ranges[i][j],  ranges[ni][j],
                                            ranges[i][j+1],ranges[ni][j+1]});
                    if (rmin > 0.0 && rmax > SHADOW_RATIO * rmin) continue;
                }

                int a = idx[i][j], b = idx[ni][j];
                int c = idx[i][j+1], d = idx[ni][j+1];
                tris.push_back({a, b, d});
                tris.push_back({a, d, c});
            }
        }

        // Cross-section at the center azimuth (included in full-mesh response)
        double sec_az = full_circle ? 0.0 : (az_min + az_max) / 2.0;
        json section  = computeSection(lat0, lon0, h_asl0,
                                       sec_az, el_max, range_km, ray_step);

        const int n_verts = (int)verts.size();
        const int n_tris  = (int)tris.size();

        json out;
        out["vertices"]  = verts;
        out["triangles"] = tris;
        out["section"]   = std::move(section);
        out["meta"] = {
            {"lat",         lat0},
            {"lon",         lon0},
            {"alt_asl",     h_asl0},
            {"range_km",    range_km},
            {"n_az",        n_az},
            {"n_el",        n_el},
            {"full_circle", full_circle},
            {"n_vertices",  n_verts},
            {"n_triangles", n_tris},
        };
        return out.dump();
    }

    // -------------------------------------------------------------------------
    // Section-only path (lightweight — no 3-D mesh)
    // -------------------------------------------------------------------------

    std::string runSection(const json& p) const {
        double lat0     = p["lat"].get<double>();
        double lon0     = p["lon"].get<double>();
        double h_asl0   = (double)getElevation(lat0, lon0)
                        + p["height_agl"].get<double>();
        double az_deg   = p.value("az_deg",    0.0);
        double el_max_  = p["el_max"].get<double>();
        double range_km = p["range_km"].get<double>();
        double ray_step = p.value("ray_step_m", 500.0);

        json sec = computeSection(lat0, lon0, h_asl0,
                                  az_deg, el_max_, range_km, ray_step);
        return json{{"section", std::move(sec)}}.dump();
    }

    // -------------------------------------------------------------------------
    // Entry point
    // -------------------------------------------------------------------------

    std::string run(const json& p) const {
        try {
            if (p.value("section_only", false)) return runSection(p);
            return compute(p);
        } catch (const std::exception& e) {
            return json{{"error", e.what()}}.dump();
        }
    }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

ViewshedComputer::ViewshedComputer(const std::string& dir, int zoom)
    : impl_(std::make_unique<Impl>(dir, zoom)) {}

ViewshedComputer::~ViewshedComputer() = default;

std::string ViewshedComputer::run(const std::string& params_json) const {
    try {
        return impl_->run(json::parse(params_json));
    } catch (const std::exception& e) {
        return json{{"error", e.what()}}.dump();
    }
}

} // namespace cpp_web_ui
