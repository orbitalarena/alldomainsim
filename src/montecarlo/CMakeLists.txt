add_library(montecarlo
    mc_world.cpp
    orbital_combat_ai.cpp
    kinetic_kill.cpp
    scenario_parser.cpp
    mc_runner.cpp
    mc_results.cpp
    replay_writer.cpp
    flight3dof.cpp
    waypoint_patrol_ai.cpp
    intercept_ai.cpp
    radar_sensor.cpp
    sam_battery.cpp
    a2a_missile.cpp
    event_system.cpp
)

target_include_directories(montecarlo PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(montecarlo PUBLIC physics core io)
