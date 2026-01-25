add_library(utils INTERFACE)

target_include_directories(utils INTERFACE
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(utils INTERFACE
    core
)
