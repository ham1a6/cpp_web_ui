#pragma once
#include <memory>
#include <string>

namespace cpp_web_ui {

// Writes symbol positions to a POSIX shared memory segment.
// The running map_server process picks up changes automatically.
//
// Use this when the data producer is a separate process from the server.
// For in-process use, MapServer::setSymbol() is simpler.
//
// Usage:
//   cpp_web_ui::ShmPublisher pub;
//   pub.open();
//   pub.setSymbol("Alpha", 35.69, 139.69, "friendly");
//
class ShmPublisher {
public:
    explicit ShmPublisher(const std::string& shm_name = "/map_positions");
    ~ShmPublisher();

    // Create/open the shared memory segment. Returns false on error.
    bool open();
    void close();
    bool isOpen() const;

    // Add or update a symbol and write to SHM immediately.
    void setSymbol(const std::string& label, double lat, double lon,
                   const std::string& type = "unknown");

    // Remove a symbol and write to SHM immediately.
    void removeSymbol(const std::string& label);

    // Remove all symbols and write to SHM immediately.
    void clearSymbols();

    ShmPublisher(const ShmPublisher&)            = delete;
    ShmPublisher& operator=(const ShmPublisher&) = delete;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace cpp_web_ui
