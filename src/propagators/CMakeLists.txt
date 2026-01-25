add_library(propagators
    rk4_integrator.cpp
)

target_include_directories(propagators PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(propagators
    core
)
