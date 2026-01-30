add_library(physics
    gravity_model.cpp
    orbital_elements.cpp
    atmosphere_model.cpp
    maneuver_planner.cpp
    proximity_ops.cpp
    nonlinear_rendezvous.cpp
    lunar_ephemeris.cpp
    solar_ephemeris.cpp
    multi_body_gravity.cpp
    aerobraking.cpp
    launch_trajectory_solver.cpp
    solar_radiation_pressure.cpp
    orbital_perturbations.cpp
    aerodynamics_6dof.cpp
    synthetic_camera.cpp
    planetary_ephemeris.cpp
    interplanetary_planner.cpp
    mars_atmosphere.cpp
    nbody_gravity.cpp
    gravity_assist.cpp
    low_thrust.cpp
    mission_sequence.cpp
)

target_include_directories(physics PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(physics
    core
    propagators
    targeting
)
