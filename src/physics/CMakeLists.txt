add_library(physics
    gravity_model.cpp
    orbital_elements.cpp
    atmosphere_model.cpp
    maneuver_planner.cpp
    proximity_ops.cpp
)

target_include_directories(physics PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(physics
    core
)
