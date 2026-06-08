#include <cpp_web_ui/MapServer.hpp>
#include "shared_types.h"   // SHM_NAME constant
#include <cstdio>
#include <cstdlib>

int main(int argc, char* argv[]) {
    cpp_web_ui::MapConfig cfg;
    cfg.shm_name = SHM_NAME;   // poll shared memory written by shm_writer

    // GSI pale map overlay for road/building outlines on top of JAXA terrain.
    // Set CFG_NO_OVERLAY=1 to disable.
    if (!std::getenv("CFG_NO_OVERLAY")) {
        cfg.overlay_url =
            "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
        cfg.overlay_attribution =
            "<a href='https://maps.gsi.go.jp/development/ichiran.html'"
            " target='_blank'>国土地理院</a>";
        cfg.overlay_opacity = 0.5;
    }

    if (argc > 1) cfg.port     = std::atoi(argv[1]);
    if (argc > 2) cfg.web_root = argv[2];

    cpp_web_ui::MapServer server(cfg);
    server.start();

    std::printf("map_server: http://localhost:%d\n", cfg.port);

    server.wait();   // blocks until Ctrl-C / svr.stop()
    return 0;
}
