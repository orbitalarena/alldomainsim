add_library(propagators
    # Source files will be added as modules are implemented
)

target_include_directories(propagators PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(propagators
    core
)
