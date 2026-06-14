#pragma once
#include <cstdint>

constexpr const char* SHM_NAME = "/map_positions";
constexpr int MAX_SYMBOLS = 64;

struct Symbol {
    double lat;
    double lon;
    char   label[32];
    char   type[16];  // "friendly", "enemy", "neutral", "unknown"
    int    active;    // 1 = valid entry
};

struct SharedMapData {
    uint32_t version;   // incremented on each write
    uint32_t count;
    Symbol   symbols[MAX_SYMBOLS];
};
// sizeof(Symbol)        == 72   (8+8+32+16+4 + 4 padding for double alignment)
// sizeof(SharedMapData) == 4616 (8 header + 64*72)
