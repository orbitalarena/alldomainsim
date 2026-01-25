add_library(physics
    # Source files will be added as modules are implemented
)

target_include_directories(physics PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(physics
    core
)
