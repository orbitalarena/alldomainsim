add_library(entities
    entity.cpp
    satellite.cpp
)

target_include_directories(entities PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(entities
    core
)
