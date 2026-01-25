add_library(physics
    gravity_model.cpp
)

target_include_directories(physics PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(physics
    core
)
