cmake_minimum_required(VERSION 3.20)
project(cpp_web_ui VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)
find_package(OpenSSL)

# ---- Library ---------------------------------------------------------------
add_library(cpp_web_ui STATIC
    src/MapServer.cpp
    src/ShmPublisher.cpp
    src/ViewshedComputer.cpp
)
add_library(cpp_web_ui::cpp_web_ui ALIAS cpp_web_ui)

target_include_directories(cpp_web_ui
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/third_party>
        $<INSTALL_INTERFACE:include>
)
target_link_libraries(cpp_web_ui PUBLIC Threads::Threads rt)
target_compile_options(cpp_web_ui PRIVATE -O2 -Wall)

# Enable HTTPS client in cpp-httplib when OpenSSL is available.
# Used by the overlay tile proxy so browsers don't need direct internet access.
if(OpenSSL_FOUND)
    target_compile_definitions(cpp_web_ui PRIVATE CPPHTTPLIB_OPENSSL_SUPPORT)
    target_link_libraries(cpp_web_ui PUBLIC OpenSSL::SSL OpenSSL::Crypto)
    message(STATUS "cpp_web_ui: OpenSSL found — overlay tile proxy supports HTTPS")
else()
    message(WARNING "cpp_web_ui: OpenSSL not found — overlay tile proxy limited to HTTP")
endif()
# Embed install prefix so the library can auto-locate the web/ directory
target_compile_definitions(cpp_web_ui PRIVATE
    CPP_WEB_UI_INSTALL_PREFIX="${CMAKE_INSTALL_PREFIX}"
)

# ---- Examples (opt-in) -----------------------------------------------------
# simple_usage : in-process API demo (addRoute, setSymbol, overlay tiles)
# shm_writer   : ShmPublisher demo — run alongside simple_usage
option(CPP_WEB_UI_BUILD_EXAMPLES "Build example programs" OFF)
if(CPP_WEB_UI_BUILD_EXAMPLES)
    add_executable(simple_usage examples/simple_usage.cpp)
    target_link_libraries(simple_usage PRIVATE cpp_web_ui)
    target_compile_options(simple_usage PRIVATE -O2 -Wall)

    add_executable(shm_writer examples/shm_writer.cpp)
    target_link_libraries(shm_writer PRIVATE cpp_web_ui m)
    target_compile_options(shm_writer PRIVATE -O2 -Wall)
endif()

# ---- Overlay tile download (offline use) ------------------------------------
find_program(PYTHON3 python3)
if(PYTHON3)
    add_custom_target(download_overlay_tiles
        COMMAND ${PYTHON3} ${CMAKE_SOURCE_DIR}/scripts/download_overlay_tiles.py
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        COMMENT "Downloading GSI pale-map overlay tiles for offline use (zoom 5-10, all Japan)"
        USES_TERMINAL
    )
    add_custom_target(generate_terrain_rgb
        COMMAND ${PYTHON3} ${CMAKE_SOURCE_DIR}/scripts/generate_terrain_rgb.py
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        COMMENT "Generating Terrain-RGB tiles for MapLibre 3D terrain (zoom 5-12)"
        USES_TERMINAL
    )
    add_custom_target(generate_terrain_rgb_dryrun
        COMMAND ${PYTHON3} ${CMAKE_SOURCE_DIR}/scripts/generate_terrain_rgb.py --dry-run
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        COMMENT "Terrain-RGB generation plan (no files written)"
        USES_TERMINAL
    )
    add_custom_target(download_overlay_tiles_dryrun
        COMMAND ${PYTHON3} ${CMAKE_SOURCE_DIR}/scripts/download_overlay_tiles.py --dry-run
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        COMMENT "Overlay tile download plan (no files written)"
        USES_TERMINAL
    )
endif()

# ---- Tile generation (opt-in via `cmake --build . --target generate_tiles`) #
if(PYTHON3)
    add_custom_target(generate_tiles_11
        COMMAND ${PYTHON3} ${CMAKE_SOURCE_DIR}/scripts/generate_tiles.py 11 11
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        COMMENT "Generating zoom-11 tiles from JAXA AW3D30 (~1.5 GB, ~30 min)"
        USES_TERMINAL
    )
    add_custom_target(generate_tiles_12
        COMMAND ${PYTHON3} ${CMAKE_SOURCE_DIR}/scripts/generate_tiles.py 11 12
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        COMMENT "Generating zoom 11-12 tiles from JAXA AW3D30 (~8 GB, ~2 h)"
        USES_TERMINAL
    )
    add_custom_target(generate_tiles_dryrun
        COMMAND ${PYTHON3} ${CMAKE_SOURCE_DIR}/scripts/generate_tiles.py --dry-run
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        COMMENT "Tile generation plan (no files written)"
        USES_TERMINAL
    )
endif()

# ---- Install ---------------------------------------------------------------
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

install(TARGETS cpp_web_ui
    EXPORT   cpp_web_ui_targets
    ARCHIVE  DESTINATION ${CMAKE_INSTALL_LIBDIR}
)

# Public headers
install(DIRECTORY include/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
# Third-party headers (httplib, json) needed to build against the library
install(DIRECTORY third_party/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/cpp_web_ui
    FILES_MATCHING PATTERN "*.h" PATTERN "*.hpp"
)
# Web assets (tiles, HTML, JS) — auto-detected at runtime via install prefix
install(DIRECTORY web/
    DESTINATION ${CMAKE_INSTALL_DATADIR}/cpp_web_ui/web
)

# CMake package config for find_package / FetchContent
install(EXPORT cpp_web_ui_targets
    FILE      cpp_web_ui_targets.cmake
    NAMESPACE cpp_web_ui::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/cpp_web_ui
)

configure_package_config_file(
    cmake/cpp_web_ui-config.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/cpp_web_ui-config.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/cpp_web_ui
)
write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/cpp_web_ui-version.cmake
    VERSION      ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion
)
install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/cpp_web_ui-config.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/cpp_web_ui-version.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/cpp_web_ui
)
