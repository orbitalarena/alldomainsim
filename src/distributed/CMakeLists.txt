add_library(distributed
    ipc_socket.cpp
    sim_coordinator.cpp
    sim_worker.cpp
    time_barrier.cpp
)

target_include_directories(distributed PUBLIC
    ${CMAKE_SOURCE_DIR}/src
)

target_link_libraries(distributed
    core
)
