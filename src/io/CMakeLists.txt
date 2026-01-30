add_library(io
    tle_parser.cpp
    json_reader.cpp
    checkpoint.cpp
)

target_include_directories(io PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(io
    core
    entities
)
