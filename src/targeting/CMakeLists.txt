add_library(targeting
    ric_frame.cpp
    cw_targeting.cpp
)

target_include_directories(targeting PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(targeting
    core
)
