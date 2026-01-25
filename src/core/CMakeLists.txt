add_library(core
    state_vector.cpp
    physics_domain.cpp
    simulation_engine.cpp
)

target_include_directories(core PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(core
    Eigen3::Eigen
)
