add_library(coordinate
    # Source files will be added as modules are implemented
)

target_include_directories(coordinate PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(coordinate
    core
)
