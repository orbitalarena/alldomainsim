add_library(utils
    # Source files will be added as modules are implemented
)

target_include_directories(utils PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(utils
    core
)
