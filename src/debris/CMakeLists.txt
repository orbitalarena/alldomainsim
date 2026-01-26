add_library(debris
    atmospheric_debris.cpp
    orbital_debris.cpp
)

target_include_directories(debris PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(debris
    core
)
