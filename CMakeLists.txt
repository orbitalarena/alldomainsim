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
