add_library(physics
    gravity_model.cpp
    orbital_elements.cpp
    atmosphere_model.cpp
    maneuver_planner.cpp
    proximity_ops.cpp
    nonlinear_rendezvous.cpp
    lunar_ephemeris.cpp
    multi_body_gravity.cpp
    aerobraking.cpp
    launch_trajectory_solver.cpp
)

target_include_directories(physics PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(physics
    core
    propagators
    targeting
)
