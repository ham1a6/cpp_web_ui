// Minimal example: embed a live map and handle browser button presses.
//
// CMake usage (add_subdirectory or FetchContent):
//   find_package(cpp_web_ui REQUIRED)          # or add_subdirectory(...)
//   target_link_libraries(my_app PRIVATE cpp_web_ui::cpp_web_ui)
//
// Build this example:
//   cmake -DCPP_WEB_UI_BUILD_EXAMPLES=ON ..
//   make simple_usage
//
// -------------------------------------------------------------------------
// ブラウザのボタン → C++ 関数の呼び出し方
// -------------------------------------------------------------------------
//
//  [ブラウザ側]                       [C++ 側]
//
//  fetch('POST', '/api/alert')  -->  server.addRoute("/api/alert", handler)
//                                         |
//                                         v
//                                    ラムダ (handler) が呼ばれる
//                                    → server.setSymbol(...) など任意の処理
//
//  組み込み VAB ボタン (setSymbol / removeSymbol / clearSymbols) も
//  同じ仕組みで POST /api/symbols に対してライブラリ内部で登録済み。
//
//  カスタムエンドポイントは addRoute() で自由に追加できる。

#include <cpp_web_ui/MapServer.hpp>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <thread>

int main(int argc, char* argv[]) {
    cpp_web_ui::MapConfig cfg;
    cfg.port         = argc > 1 ? std::atoi(argv[1]) : 9000;
    cfg.title        = "Button Demo";
    cfg.center_lat   = 35.690;
    cfg.center_lon   = 139.700;
    cfg.initial_zoom = 14;   // zoom 14+ shows streets; 16+ shows individual buildings

    // GSI pale map overlay proxied through this server — works even when the
    // browser cannot reach external servers directly.
    cfg.overlay_url         = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
    cfg.overlay_attribution = "<a href='https://maps.gsi.go.jp/development/ichiran.html'"
                              " target='_blank'>国土地理院</a>";
    cfg.overlay_opacity = 0.75;
    cfg.max_zoom        = 18;  // allow zooming to building level

    cpp_web_ui::MapServer server(cfg);

    // ------------------------------------------------------------------
    // addRoute() — ブラウザのボタン押下で呼ばれる C++ ハンドラを登録
    //
    // 引数:
    //   path     : URL パス (POST メソッド)
    //   handler  : (body_json) -> response_json
    //              body_json   = ブラウザから送った JSON 文字列
    //              return 値   = ブラウザに返す JSON 文字列
    //
    // ルールは 1 つだけ: start() を呼ぶ前に登録すること。
    // ------------------------------------------------------------------

    // ---- ① 警戒シンボルを出す ----------------------------------------
    // curl -X POST http://localhost:9000/api/alert        ← curl でも呼べる
    // fetch('POST', '/api/alert')                         ← JS からも呼べる
    server.addRoute("/api/alert", [&server](const std::string& /*body*/) {
        server.setSymbol("ALERT", 35.690, 139.692, "enemy");
        std::printf("[!] /api/alert  → setSymbol(ALERT, enemy)\n");
        return std::string(R"({"ok": true, "msg": "alert activated"})");
    });

    // ---- ② 全シンボルをリセット --------------------------------------
    server.addRoute("/api/reset", [&server](const std::string& /*body*/) {
        server.clearSymbols();
        std::printf("[i] /api/reset  → clearSymbols()\n");
        return std::string(R"({"ok": true, "msg": "reset"})");
    });

    // ---- ③ JSON ボディを受け取る例 -----------------------------------
    // curl -X POST http://localhost:9000/api/echo -d '{"msg":"hello"}'
    server.addRoute("/api/echo", [](const std::string& body) {
        std::printf("[~] /api/echo   body=%s\n", body.c_str());
        return body.empty() ? std::string(R"({"echo":""})") : body;
    });

    // ---- ④ 4×4 グリッドボタン (B01〜B16) ----------------------------
    // ブラウザの VAB に表示される 16 個のボタンに処理を割り当てる例。
    // ボタン n を押すと POST /api/btn/{n} が送られる。
    for (int n = 1; n <= 16; ++n) {
        server.addRoute("/api/btn/" + std::to_string(n),
                        [n](const std::string& /*body*/) {
            std::printf("[B%02d] button %d pressed\n", n, n);
            return std::string(R"({"ok": true})");
        });
    }

    server.start();
    std::printf("Open http://localhost:%d\n\n", cfg.port);
    std::printf("Built-in VAB buttons (browser):\n");
    std::printf("  setSymbol / removeSymbol / clearSymbols\n\n");
    std::printf("Custom endpoints (curl or browser fetch):\n");
    std::printf("  POST /api/alert  → setSymbol(ALERT, enemy)\n");
    std::printf("  POST /api/reset  → clearSymbols()\n");
    std::printf("  POST /api/echo   → body をそのまま返す\n");
    std::printf("  POST /api/btn/1〜16 → VAB グリッドボタン\n\n");

    // Alpha シンボルが円を描いて移動する
    double lat = 35.690, lon = 139.692;
    for (int tick = 0; ; ++tick) {
        lat += 0.001 * std::cos(tick * 0.05);
        lon += 0.001 * std::sin(tick * 0.05);
        server.setSymbol("Alpha", lat, lon, "friendly");

        if (tick == 60) {
            server.setSymbol("Bravo", 35.444, 139.638, "neutral");
            std::printf("[*] Added Bravo at tick=%d\n", tick);
        }
        if (tick == 120) {
            server.removeSymbol("Bravo");
            std::printf("[*] Removed Bravo at tick=%d\n", tick);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
}
