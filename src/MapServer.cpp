#define CPPHTTPLIB_THREAD_POOL_COUNT 64
#include "httplib.h"
#include "json.hpp"
#include "shared_types.h"
#include <cpp_web_ui/MapServer.hpp>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>

using json = nlohmann::json;
namespace fs = std::filesystem;

// ---------- internal helpers ------------------------------------------------

namespace {

struct SseBroker {
    std::mutex mu;
    std::set<httplib::DataSink*> clients;

    void add(httplib::DataSink& s)    { std::lock_guard lk(mu); clients.insert(&s); }
    void remove(httplib::DataSink& s) { std::lock_guard lk(mu); clients.erase(&s);  }

    void broadcast(const std::string& payload) {
        std::string msg = "data: " + payload + "\n\n";
        std::lock_guard lk(mu);
        for (auto* s : clients) s->write(msg.c_str(), msg.size());
    }

    size_t count() { std::lock_guard lk(mu); return clients.size(); }
};

static std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    return {std::istreambuf_iterator<char>(f), {}};
}

static std::string mimeOf(const std::string& ext) {
    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".css")  return "text/css";
    if (ext == ".js")   return "application/javascript";
    if (ext == ".png")  return "image/png";
    return "application/octet-stream";
}

static std::string makeETag(const fs::path& p) {
    auto sz    = fs::file_size(p);
    auto mtime = fs::last_write_time(p).time_since_epoch().count();
    char buf[64];
    std::snprintf(buf, sizeof(buf), "\"%zx-%llx\"", sz, (unsigned long long)mtime);
    return buf;
}

static void serveFile(const httplib::Request& req, httplib::Response& res,
                      const fs::path& file, bool isTile) {
    const std::string etag = makeETag(file);
    if (req.has_header("If-None-Match") &&
        req.get_header_value("If-None-Match") == etag) {
        res.status = 304;
        return;
    }
    res.set_header("Cache-Control",
                   isTile ? "public, max-age=300, must-revalidate" : "no-cache");
    res.set_header("ETag", etag);
    res.set_content(readFile(file), mimeOf(file.extension().string()));
}

// Try common locations to find the web/ directory.
static fs::path detectWebRoot() {
    if (const char* env = std::getenv("CPP_WEB_UI_WEB_ROOT")) {
        fs::path p(env);
        if (fs::exists(p / "index.html")) return p;
    }
    char self[4096]{};
    if (readlink("/proc/self/exe", self, sizeof(self) - 1) > 0) {
        fs::path bin = fs::path(self).parent_path();
        for (const char* rel : {"../web", "../../web", "web"}) {
            fs::path c = bin / rel;
            if (fs::exists(c / "index.html")) return c;
        }
    }
#ifdef CPP_WEB_UI_INSTALL_PREFIX
    {
        fs::path c = fs::path(CPP_WEB_UI_INSTALL_PREFIX) / "share/cpp_web_ui/web";
        if (fs::exists(c / "index.html")) return c;
    }
#endif
    return {};
}

// Scan web_root/tiles/ for the highest zoom level that contains at least one
// PNG file.  Returns -1 if the tiles directory does not exist or is empty.
static int detectMaxNativeZoom(const fs::path& tiles_dir) {
    if (!fs::exists(tiles_dir)) return -1;
    int max_z = -1;
    std::error_code ec;
    for (int z = 0; z <= 20; ++z) {
        fs::path zdir = tiles_dir / std::to_string(z);
        if (!fs::is_directory(zdir, ec)) continue;
        bool found = false;
        for (const auto& xdir : fs::directory_iterator(zdir, ec)) {
            if (!xdir.is_directory()) continue;
            for (const auto& f : fs::directory_iterator(xdir.path(), ec)) {
                if (f.path().extension() == ".png") { found = true; break; }
            }
            if (found) break;
        }
        if (found) max_z = z;
    }
    return max_z;
}

} // anonymous namespace

// ---------- MapServer::Impl -------------------------------------------------

namespace cpp_web_ui {

struct MapServer::Impl {
    MapConfig config;

    // Symbol table — single source of truth for SSE snapshot
    std::mutex sym_mu;
    std::map<std::string, json> symbols;   // label -> {lat,lon,label,type}
    std::set<std::string> shm_labels;      // labels currently owned by SHM

    SseBroker       sse;
    httplib::Server svr;
    fs::path        web_root;

    // Custom POST routes registered via MapServer::addRoute() before start()
    std::vector<std::pair<std::string, MapServer::PostHandler>> custom_routes;

    std::thread         server_thread;
    std::thread         shm_thread;
    std::atomic<bool>   running{false};
    std::atomic<bool>   stop_req{false};

    // SHM reader state
    int            shm_fd      = -1;
    SharedMapData* shm_ptr     = nullptr;
    uint32_t       shm_last_ver = 0;

    // ---- Snapshot / broadcast -----------------------------------------------

    // Caller must hold sym_mu.
    std::string snapshotJsonLocked() const {
        json arr = json::array();
        for (const auto& [lbl, sym] : symbols) arr.push_back(sym);
        return arr.dump();
    }

    void broadcastSnapshot() {
        std::string payload;
        { std::lock_guard lk(sym_mu); payload = snapshotJsonLocked(); }
        sse.broadcast(payload);
    }

    // ---- HTTP routes --------------------------------------------------------

    void setupRoutes() {
        // Configuration endpoint consumed by app.js on page load
        svr.Get("/api/config", [this](const httplib::Request&, httplib::Response& res) {
            json cfg;
            cfg["center"]          = {config.center_lat, config.center_lon};
            cfg["zoom"]            = config.initial_zoom;
            cfg["tile_url"]        = config.tile_url;
            cfg["attribution"]     = config.tile_attribution;
            cfg["min_zoom"]        = config.min_zoom;
            cfg["max_zoom"]        = config.max_zoom;
            cfg["max_native_zoom"] = config.max_native_zoom;
            cfg["overlay_url"]         = config.overlay_url;
            cfg["overlay_attribution"] = config.overlay_attribution;
            cfg["overlay_opacity"]     = config.overlay_opacity;
            cfg["title"]           = config.title;
            res.set_header("Cache-Control", "no-cache");
            res.set_content(cfg.dump(), "application/json");
        });

        // One-shot snapshot
        svr.Get("/api/positions", [this](const httplib::Request&, httplib::Response& res) {
            std::string payload;
            { std::lock_guard lk(sym_mu); payload = snapshotJsonLocked(); }
            res.set_header("Access-Control-Allow-Origin", "*");
            res.set_content(payload, "application/json");
        });

        // SSE stream
        svr.Get("/events", [this](const httplib::Request&, httplib::Response& res) {
            res.set_header("Cache-Control", "no-cache");
            res.set_header("Access-Control-Allow-Origin", "*");
            res.set_chunked_content_provider(
                "text/event-stream",
                [this](size_t, httplib::DataSink& sink) {
                    sse.add(sink);
                    // Send current state immediately on connect
                    {
                        std::string msg;
                        { std::lock_guard lk(sym_mu); msg = "data: " + snapshotJsonLocked() + "\n\n"; }
                        sink.write(msg.c_str(), msg.size());
                    }
                    while (sink.is_writable())
                        std::this_thread::sleep_for(std::chrono::milliseconds(200));
                    sse.remove(sink);
                    return true;
                });
        });

        // POST /api/symbols   → setSymbol(label, lat, lon, type)
        svr.Post("/api/symbols", [this](const httplib::Request& req, httplib::Response& res) {
            auto body = json::parse(req.body, nullptr, false);
            if (body.is_discarded() || !body.contains("label")) {
                res.status = 400;
                res.set_content(R"({"error":"label required"})", "application/json");
                return;
            }
            const std::string lbl  = body["label"].get<std::string>();
            const double      lat  = body.value("lat",  0.0);
            const double      lon  = body.value("lon",  0.0);
            const std::string type = body.value("type", "unknown");
            if (lbl.empty() || lbl.size() > 31) {
                res.status = 400;
                res.set_content(R"({"error":"label must be 1-31 chars"})", "application/json");
                return;
            }
            { std::lock_guard lk(sym_mu);
              symbols[lbl] = {{"lat", lat}, {"lon", lon}, {"label", lbl}, {"type", type}}; }
            broadcastSnapshot();
            res.set_content("{}", "application/json");
        });

        // DELETE /api/symbols          → clearSymbols()   (exact path first)
        svr.Delete("/api/symbols", [this](const httplib::Request&, httplib::Response& res) {
            { std::lock_guard lk(sym_mu); symbols.clear(); shm_labels.clear(); }
            broadcastSnapshot();
            res.set_content("{}", "application/json");
        });

        // DELETE /api/symbols/:label   → removeSymbol(label)
        svr.Delete(R"(/api/symbols/([^/]+))",
                   [this](const httplib::Request& req, httplib::Response& res) {
            const std::string lbl = req.matches[1];
            { std::lock_guard lk(sym_mu); symbols.erase(lbl); shm_labels.erase(lbl); }
            broadcastSnapshot();
            res.set_content("{}", "application/json");
        });

        // Custom POST routes registered by the user via addRoute()
        for (const auto& [path, handler] : custom_routes) {
            svr.Post(path, [handler](const httplib::Request& req, httplib::Response& res) {
                std::string result = handler(req.body);
                res.set_content(result, "application/json");
            });
        }

        // Static file serving
        svr.Get("/.*", [this](const httplib::Request& req, httplib::Response& res) {
            if (web_root.empty()) {
                res.status = 503;
                res.set_content("web_root not configured; set MapConfig::web_root "
                                "or $CPP_WEB_UI_WEB_ROOT", "text/plain");
                return;
            }
            std::string path = req.path == "/" ? "/index.html" : req.path;
            fs::path file = web_root / path.substr(1);
            if (!fs::exists(file) || !fs::is_regular_file(file)) {
                res.status = 404;
                return;
            }
            bool isTile = path.size() > 7 && path.compare(0, 7, "/tiles/") == 0;
            serveFile(req, res, file, isTile);
        });
    }

    // ---- SHM polling --------------------------------------------------------

    bool openShm() {
        if (shm_ptr) return true;
        shm_fd = shm_open(config.shm_name.c_str(), O_RDONLY, 0);
        if (shm_fd < 0) return false;
        shm_ptr = static_cast<SharedMapData*>(
            mmap(nullptr, sizeof(SharedMapData), PROT_READ, MAP_SHARED, shm_fd, 0));
        if (shm_ptr == MAP_FAILED) { shm_ptr = nullptr; return false; }
        return true;
    }

    void closeShm() {
        if (shm_ptr)    { munmap(shm_ptr, sizeof(SharedMapData)); shm_ptr = nullptr; }
        if (shm_fd >= 0){ ::close(shm_fd); shm_fd = -1; }
    }

    void pollShm() {
        if (!openShm()) return;

        SharedMapData local;
        std::memcpy(&local, shm_ptr, sizeof(local));
        if (local.version == shm_last_ver) return;
        shm_last_ver = local.version;

        uint32_t cnt = std::min(local.count, static_cast<uint32_t>(MAX_SYMBOLS));
        std::set<std::string> seen;

        {
            std::lock_guard lk(sym_mu);
            for (uint32_t i = 0; i < cnt; ++i) {
                const auto& s = local.symbols[i];
                if (!s.active) continue;
                std::string lbl(s.label);
                seen.insert(lbl);
                shm_labels.insert(lbl);
                symbols[lbl] = {{"lat",   s.lat},
                                {"lon",   s.lon},
                                {"label", lbl},
                                {"type",  std::string(s.type)}};
            }
            for (auto it = shm_labels.begin(); it != shm_labels.end(); ) {
                if (!seen.count(*it)) { symbols.erase(*it); it = shm_labels.erase(it); }
                else ++it;
            }
        }
        broadcastSnapshot();
    }

    void shmPollerLoop() {
        while (!stop_req.load()) {
            pollShm();
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
};

// ---------- MapServer public API -------------------------------------------

MapServer::MapServer(MapConfig config) : impl_(std::make_unique<Impl>()) {
    impl_->config = std::move(config);

    if (!impl_->config.web_root.empty()) {
        impl_->web_root = impl_->config.web_root;
    } else {
        impl_->web_root = detectWebRoot();
        if (impl_->web_root.empty())
            std::fprintf(stderr,
                "cpp_web_ui: web_root not found — set MapConfig::web_root "
                "or $CPP_WEB_UI_WEB_ROOT\n");
        else
            std::fprintf(stderr, "cpp_web_ui: web_root = %s\n",
                         impl_->web_root.c_str());
    }

    // Auto-detect max_native_zoom / max_zoom from the tiles directory so
    // the /api/config response reflects newly generated higher-zoom tiles
    // without any code change.
    if (impl_->config.max_native_zoom < 0 || impl_->config.max_zoom < 0) {
        int detected = -1;
        if (!impl_->web_root.empty())
            detected = detectMaxNativeZoom(impl_->web_root / "tiles");
        if (detected < 0) detected = 10;   // sensible fallback
        if (impl_->config.max_native_zoom < 0)
            impl_->config.max_native_zoom = detected;
        if (impl_->config.max_zoom < 0)
            impl_->config.max_zoom = impl_->config.max_native_zoom;
        std::fprintf(stderr,
            "cpp_web_ui: tiles detected max_native_zoom=%d  max_zoom=%d\n",
            impl_->config.max_native_zoom, impl_->config.max_zoom);
    }
}

MapServer::~MapServer() { stop(); }

void MapServer::start() {
    bool expected = false;
    if (!impl_->running.compare_exchange_strong(expected, true))
        throw std::runtime_error("MapServer already running");

    impl_->stop_req = false;
    impl_->setupRoutes();

    impl_->server_thread = std::thread([this]() {
        impl_->svr.listen("0.0.0.0", impl_->config.port);
        impl_->running = false;
    });

    if (!impl_->config.shm_name.empty()) {
        impl_->shm_thread = std::thread([this]() { impl_->shmPollerLoop(); });
    }
}

void MapServer::stop() {
    if (!impl_->running.load() && !impl_->stop_req.load()) return;
    impl_->stop_req = true;
    impl_->svr.stop();
    if (impl_->server_thread.joinable()) impl_->server_thread.join();
    if (impl_->shm_thread.joinable())    impl_->shm_thread.join();
    impl_->closeShm();
}

void MapServer::wait() {
    if (impl_->server_thread.joinable()) impl_->server_thread.join();
}

bool MapServer::isRunning() const { return impl_->running.load(); }
int  MapServer::port() const      { return impl_->config.port; }

void MapServer::setSymbol(const std::string& label, double lat, double lon,
                           const std::string& type) {
    { std::lock_guard lk(impl_->sym_mu);
      impl_->symbols[label] = {{"lat",   lat}, {"lon",   lon},
                                {"label", label}, {"type",  type}}; }
    impl_->broadcastSnapshot();
}

void MapServer::removeSymbol(const std::string& label) {
    { std::lock_guard lk(impl_->sym_mu);
      impl_->symbols.erase(label);
      impl_->shm_labels.erase(label); }
    impl_->broadcastSnapshot();
}

void MapServer::clearSymbols() {
    { std::lock_guard lk(impl_->sym_mu);
      impl_->symbols.clear();
      impl_->shm_labels.clear(); }
    impl_->broadcastSnapshot();
}

void MapServer::addRoute(const std::string& path, PostHandler handler) {
    impl_->custom_routes.emplace_back(path, std::move(handler));
}

} // namespace cpp_web_ui
