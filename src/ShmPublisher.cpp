#include <cpp_web_ui/ShmPublisher.hpp>
#include "shared_types.h"

#include <cstring>
#include <map>
#include <string>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>

namespace cpp_web_ui {

struct ShmPublisher::Impl {
    std::string    shm_name;
    int            fd  = -1;
    SharedMapData* ptr = nullptr;
    uint32_t       ver = 0;

    struct Entry { double lat, lon; std::string type; };
    std::map<std::string, Entry> local;

    void flush() {
        if (!ptr) return;
        uint32_t i = 0;
        for (const auto& [lbl, e] : local) {
            if (i >= MAX_SYMBOLS) break;
            auto& s  = ptr->symbols[i++];
            s.lat    = e.lat;
            s.lon    = e.lon;
            s.active = 1;
            std::strncpy(s.label, lbl.c_str(),    sizeof(s.label) - 1);
            std::strncpy(s.type,  e.type.c_str(), sizeof(s.type)  - 1);
            s.label[sizeof(s.label) - 1] = '\0';
            s.type [sizeof(s.type)  - 1] = '\0';
        }
        for (; i < MAX_SYMBOLS; ++i) ptr->symbols[i].active = 0;
        ptr->count   = static_cast<uint32_t>(local.size());
        ptr->version = ++ver;
    }
};

ShmPublisher::ShmPublisher(const std::string& shm_name)
    : impl_(std::make_unique<Impl>()) {
    impl_->shm_name = shm_name;
}

ShmPublisher::~ShmPublisher() { close(); }

bool ShmPublisher::open() {
    impl_->fd = shm_open(impl_->shm_name.c_str(), O_CREAT | O_RDWR, 0666);
    if (impl_->fd < 0) return false;
    if (ftruncate(impl_->fd, sizeof(SharedMapData)) < 0) return false;
    impl_->ptr = static_cast<SharedMapData*>(
        mmap(nullptr, sizeof(SharedMapData), PROT_READ | PROT_WRITE,
             MAP_SHARED, impl_->fd, 0));
    if (impl_->ptr == MAP_FAILED) { impl_->ptr = nullptr; return false; }
    return true;
}

void ShmPublisher::close() {
    if (impl_->ptr) { munmap(impl_->ptr, sizeof(SharedMapData)); impl_->ptr = nullptr; }
    if (impl_->fd >= 0) { ::close(impl_->fd); impl_->fd = -1; }
}

bool ShmPublisher::isOpen() const { return impl_->ptr != nullptr; }

void ShmPublisher::setSymbol(const std::string& label, double lat, double lon,
                              const std::string& type) {
    impl_->local[label] = {lat, lon, type};
    impl_->flush();
}

void ShmPublisher::removeSymbol(const std::string& label) {
    impl_->local.erase(label);
    impl_->flush();
}

void ShmPublisher::clearSymbols() {
    impl_->local.clear();
    impl_->flush();
}

} // namespace cpp_web_ui
