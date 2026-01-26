# Figures of Merit library

add_library(fom
    gps_pdop.cpp
    sensor_revisit.cpp
)

target_include_directories(fom PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(fom
    physics
    io
)
