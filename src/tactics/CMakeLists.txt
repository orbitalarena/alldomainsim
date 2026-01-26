add_library(tactics
    tactical_ai.cpp
    missile_guidance.cpp
)

target_include_directories(tactics PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(tactics
    core
)
