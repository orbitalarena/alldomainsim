cmake_minimum_required(VERSION 3.20)
project(AllDomainSim VERSION 0.1.0 LANGUAGES CXX)

# C++ Standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Build type
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Compiler flags
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0 -Wall -Wextra -pedantic")
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native -DNDEBUG")

# Export compile commands for IDEs
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Output directories
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# Find dependencies (optional)
find_package(Eigen3 QUIET)
if(Eigen3_FOUND)
    message(STATUS "Found Eigen3: ${EIGEN3_INCLUDE_DIR}")
endif()

# Include directories
include_directories(
    ${CMAKE_SOURCE_DIR}/src
)
if(Eigen3_FOUND)
    include_directories(${EIGEN3_INCLUDE_DIR})
endif()

# Add subdirectories
add_subdirectory(src/core)
add_subdirectory(src/physics)
add_subdirectory(src/coordinate)
add_subdirectory(src/entities)
add_subdirectory(src/propagators)
add_subdirectory(src/io)
add_subdirectory(src/utils)
add_subdirectory(src/targeting)
add_subdirectory(src/debris)
add_subdirectory(src/tactics)
add_subdirectory(src/data)
add_subdirectory(src/fom)
add_subdirectory(src/distributed)

# Main simulation executable
add_executable(sim_engine
    src/main.cpp
)

target_link_libraries(sim_engine
    core
    physics
    entities
    coordinate
    propagators
    io
    utils
)

# Demo executable
add_executable(demo
    src/demo.cpp
)

target_link_libraries(demo
    core
    physics
    entities
    coordinate
    propagators
    io
    utils
)

# Rendezvous demo executable
add_executable(rendezvous_demo
    src/rendezvous_demo.cpp
)

target_link_libraries(rendezvous_demo
    core
    physics
    entities
    coordinate
    propagators
    io
    utils
)

# GEO rendezvous demo executable
add_executable(geo_rendezvous_demo
    src/geo_rendezvous_demo.cpp
)

target_link_libraries(geo_rendezvous_demo
    core
    physics
    entities
    coordinate
    propagators
    io
    utils
)

# Satellite tour demo - 30 target rendezvous
add_executable(sat_tour_demo
    src/sat_tour_demo.cpp
)

target_link_libraries(sat_tour_demo
    core
    physics
    entities
    coordinate
    propagators
    io
    utils
)

# Export all satellites from TLE catalog
add_executable(export_all_sats
    src/export_all_sats.cpp
)

target_link_libraries(export_all_sats
    core
    physics
    coordinate
    io
)

# ORD to JFK flight simulation
add_executable(ord_jfk_flight
    src/ord_jfk_flight.cpp
)

target_link_libraries(ord_jfk_flight
    core
    physics
    entities
    coordinate
)

# Dogfight demo - 4v4 BVR combat simulation
add_executable(dogfight_demo
    src/dogfight_demo.cpp
)

target_link_libraries(dogfight_demo
    core
    physics
    entities
    coordinate
    tactics
    debris
)

# GEO Collision demo - satellite collision with orbital debris
add_executable(collision_demo
    src/collision_demo.cpp
)

target_link_libraries(collision_demo
    core
    physics
    coordinate
    propagators
    targeting
    debris
)

# LEO Imaging Satellite Constellation demo
add_executable(leo_imager_demo
    src/leo_imager_demo.cpp
)

target_link_libraries(leo_imager_demo
    core
    physics
)

# Apollo Lunar Return demo
add_executable(lunar_return_demo
    src/lunar_return_demo.cpp
)

target_link_libraries(lunar_return_demo
    core
    physics
    entities
    coordinate
    propagators
)

# GPS PDOP Grid Calculator
add_executable(gps_pdop_demo
    src/gps_pdop_demo.cpp
)

target_link_libraries(gps_pdop_demo
    core
    physics
    coordinate
    io
)

# LEO Sensor Revisit Calculator
add_executable(leo_sensor_revisit
    src/leo_sensor_revisit.cpp
)

target_link_libraries(leo_sensor_revisit
    core
    physics
    coordinate
)

# GEO Interactive Simulation demo
add_executable(geo_sim_demo
    src/geo_sim_demo.cpp
)

target_link_libraries(geo_sim_demo
    core
    physics
    coordinate
    propagators
)

# Launch-to-Intercept Trajectory Solver demo
add_executable(launch_intercept_demo
    src/launch_intercept_demo.cpp
)

target_link_libraries(launch_intercept_demo
    core
    physics
    coordinate
    propagators
)

# Launch profile sweep (diagnostic)
add_executable(launch_sweep
    src/launch_sweep.cpp
)

target_link_libraries(launch_sweep
    core
    physics
    coordinate
    propagators
)

# Simple gravity turn diagnostic
add_executable(simple_gravity_turn
    src/simple_gravity_turn.cpp
)

target_link_libraries(simple_gravity_turn
    core
    physics
    coordinate
)

# Perturbation fidelity comparison demo
add_executable(perturbation_demo
    src/perturbation_demo.cpp
)

target_link_libraries(perturbation_demo
    core
    physics
    coordinate
    propagators
)

# Crushed-It multi-phase mission demo
add_executable(crushed_it_demo
    src/crushed_it_demo.cpp
)

target_link_libraries(crushed_it_demo
    core
    physics
    entities
    coordinate
    propagators
    io
    utils
)

# Interplanetary trajectory demo (Phase 4)
add_executable(interplanetary_demo
    src/interplanetary_demo.cpp
)

target_link_libraries(interplanetary_demo
    core
    physics
    coordinate
    propagators
)

# Distributed simulation demo
add_executable(distributed_demo
    src/distributed_demo.cpp
)

target_link_libraries(distributed_demo
    core
    distributed
    pthread
)

# Testing
enable_testing()
add_subdirectory(tests)

# Installation
install(TARGETS sim_engine
    RUNTIME DESTINATION bin
)

# Print configuration summary
message(STATUS "=== All-Domain Simulation Environment ===")
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "C++ compiler: ${CMAKE_CXX_COMPILER}")
message(STATUS "C++ standard: ${CMAKE_CXX_STANDARD}")
message(STATUS "Install prefix: ${CMAKE_INSTALL_PREFIX}")
