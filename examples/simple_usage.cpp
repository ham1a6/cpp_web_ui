// Minimal example: embed a live map in your own C++ application.
//
// CMake usage (add_subdirectory or FetchContent):
//   find_package(cpp_web_ui REQUIRED)          # or add_subdirectory(...)
//   target_link_libraries(my_app PRIVATE cpp_web_ui::cpp_web_ui)
//
// Build this example:
//   cmake -DCPP_WEB_UI_BUILD_EXAMPLES=ON ..
//   make simple_usage

#include <cpp_web_ui/MapServer.hpp>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>

int main() {
    cpp_web_ui::MapConfig cfg;
    cfg.port         = 9000;
    cfg.title        = "My Tracker";
    cfg.center_lat   = 35.690;
    cfg.center_lon   = 139.692;
    cfg.initial_zoom = 8;

    // To use OpenStreetMap tiles instead of local JAXA tiles, uncomment:
    // cfg.tile_url        = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    // cfg.tile_attribution = "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>";
    // cfg.min_zoom = 3; cfg.max_zoom = 19; cfg.max_native_zoom = 19;

    cpp_web_ui::MapServer server(cfg);
    server.start();
    std::printf("Open http://localhost:%d in your browser\n", cfg.port);

    // Simulate two moving symbols
    double lat = 35.690, lon = 139.692;
    for (int tick = 0; ; ++tick) {
        lat += 0.001 * std::cos(tick * 0.05);
        lon += 0.001 * std::sin(tick * 0.05);
        server.setSymbol("Alpha", lat, lon, "friendly");

        double lat2 = 35.444 + 0.005 * std::sin(tick * 0.07);
        server.setSymbol("Bravo", lat2, 139.638, "neutral");

        if (tick == 60) {
            server.removeSymbol("Bravo");
            std::printf("Removed Bravo at tick=%d\n", tick);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
}
