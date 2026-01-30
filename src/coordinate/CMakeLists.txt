add_library(coordinate
    time_utils.cpp
    frame_transformer.cpp
)

target_include_directories(coordinate PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(coordinate
    core
    physics
)
