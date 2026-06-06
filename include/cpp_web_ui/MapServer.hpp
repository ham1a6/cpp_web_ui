#pragma once
#include <memory>
#include <string>

namespace cpp_web_ui {

struct MapConfig {
    // ---- HTTP server -------------------------------------------------------
    int port = 9000;

    // Path to web/ directory (index.html, app.js, tiles/, ...).
    // Empty = auto-detect from executable location or $CPP_WEB_UI_WEB_ROOT.
    std::string web_root;

    // POSIX SHM segment name to poll for symbol updates (e.g. "/map_positions").
    // Empty (default) = no SHM polling; use setSymbol() directly.
    std::string shm_name;

    // ---- Map initial view --------------------------------------------------
    double center_lat   = 36.0;
    double center_lon   = 137.5;
    int    initial_zoom = 6;

    // ---- Tile layer --------------------------------------------------------
    std::string tile_url         = "/tiles/{z}/{x}/{y}.png";
    std::string tile_attribution = "Elevation: © JAXA AW3D30";
    int min_zoom        = 5;

    // -1 = auto-detect at startup by scanning web_root/tiles/ directory.
    // Set explicitly when using an external tile URL (e.g. OpenStreetMap).
    int max_native_zoom = -1;   // detected value reported on stderr at startup
    int max_zoom        = -1;   // default: = max_native_zoom (no upscaling; sharp at all zoom levels)

    // ---- UI ---------------------------------------------------------------
    std::string title = "Map";
};

// HTTP map server that streams symbol updates to the browser via SSE.
//
// Minimal usage:
//   cpp_web_ui::MapServer server;
//   server.start();
//   server.setSymbol("Alpha", 35.69, 139.69, "friendly");
//
class MapServer {
public:
    explicit MapServer(MapConfig config = {});
    ~MapServer();

    // Start the HTTP server in a background thread.
    // Throws std::runtime_error if already running or port is in use.
    void start();

    // Signal the server to stop and join the background thread.
    void stop();

    // Block until the server exits (useful in CLI main() after start()).
    void wait();

    bool isRunning() const;
    int  port() const;

    // Thread-safe: add or update a symbol; immediately pushed to SSE clients.
    void setSymbol(const std::string& label, double lat, double lon,
                   const std::string& type = "unknown");

    // Thread-safe: remove a symbol by label.
    void removeSymbol(const std::string& label);

    // Thread-safe: remove all symbols.
    void clearSymbols();

    MapServer(const MapServer&)            = delete;
    MapServer& operator=(const MapServer&) = delete;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace cpp_web_ui
