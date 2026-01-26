add_library(entities
    entity.cpp
    satellite.cpp
    launch_vehicle.cpp
    aircraft.cpp
    fighter.cpp
    command_module.cpp
)

target_include_directories(entities PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(entities
    core
    coordinate
    physics
    propagators
)
