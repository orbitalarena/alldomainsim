add_library(data
    world_cities.cpp
)

target_include_directories(data PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)
