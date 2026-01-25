add_library(io
    # Source files will be added as modules are implemented
)

target_include_directories(io PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(io
    core
)
