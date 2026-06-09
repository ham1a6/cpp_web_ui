#include <cpp_web_ui/ShmPublisher.hpp>
#include <cmath>
#include <cstdio>
#include <unistd.h>

// Example: ShmPublisher — feed position data from a separate process.
// Run alongside simple_usage (or any server with shm_name = SHM_NAME).

static const struct { const char* label; const char* type; double lat, lon; }
INITIAL[] = {
    // 北海道
    {"Sapporo",   "friendly", 43.062, 141.354},
    {"Kushiro",   "neutral",  42.975, 144.375},
    // 東北
    {"Sendai",    "friendly", 38.269, 140.872},
    {"Akita",     "neutral",  39.718, 140.103},
    // 関東
    {"Tokyo",     "friendly", 35.690, 139.692},
    {"Yokohama",  "friendly", 35.444, 139.638},
    // 中部
    {"Nagoya",    "neutral",  35.183, 136.906},
    {"Niigata",   "friendly", 37.916, 139.036},
    // 関西
    {"Osaka",     "enemy",    34.694, 135.502},
    {"Kyoto",     "neutral",  35.011, 135.768},
    // 中国・四国
    {"Hiroshima", "friendly", 34.396, 132.459},
    {"Kochi",     "unknown",  33.559, 133.531},
    // 九州
    {"Fukuoka",   "friendly", 33.590, 130.401},
    {"Kagoshima", "enemy",    31.560, 130.558},
    // 沖縄
    {"Naha",      "unknown",  26.212, 127.681},
};

int main() {
    cpp_web_ui::ShmPublisher pub;
    if (!pub.open()) { std::perror("ShmPublisher::open"); return 1; }

    std::printf("shm_writer: started — press Ctrl-C to stop\n");

    constexpr int N = static_cast<int>(sizeof(INITIAL) / sizeof(INITIAL[0]));
    double phase[N]{};
    for (int i = 0; i < N; ++i) phase[i] = i * (2.0 * M_PI / N);

    for (uint32_t tick = 0; ; ++tick) {
        for (int i = 0; i < N; ++i) {
            double r   = 0.008 + 0.004 * std::sin(phase[i] * 0.3);
            double lat = INITIAL[i].lat + r * std::sin(phase[i]);
            double lon = INITIAL[i].lon + r * std::cos(phase[i]);
            pub.setSymbol(INITIAL[i].label, lat, lon, INITIAL[i].type);
            phase[i] += 0.04;
        }
        if (tick % 25 == 0) std::printf("shm_writer: tick=%u\n", tick);
        usleep(200000);   // 5 Hz
    }
}
