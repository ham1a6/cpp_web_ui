#pragma once
#include <memory>
#include <string>

namespace cpp_web_ui {

// Computes 3-D radar coverage envelopes and vertical cross-sections from
// terrain-RGB tiles (Terrarium encoding).  Drop-in C++ replacement for
// scripts/compute_viewshed.py — same JSON input/output contract.
class ViewshedComputer {
public:
    // terrain_rgb_dir: path to the web/terrain-rgb/ directory
    // zoom: tile zoom level used for elevation lookups (default 12)
    explicit ViewshedComputer(const std::string& terrain_rgb_dir, int zoom = 12);
    ~ViewshedComputer();

    // Accepts the same JSON object that compute_viewshed.py reads from stdin.
    // Returns the same JSON object that compute_viewshed.py writes to stdout.
    // Returns a JSON error object on failure.
    std::string run(const std::string& params_json) const;

    ViewshedComputer(const ViewshedComputer&)            = delete;
    ViewshedComputer& operator=(const ViewshedComputer&) = delete;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace cpp_web_ui
