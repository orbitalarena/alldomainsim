#ifndef SIM_SIM_COORDINATOR_HPP
#define SIM_SIM_COORDINATOR_HPP

#include "ipc_socket.hpp"
#include "time_barrier.hpp"
#include "core/state_vector.hpp"
#include <vector>
#include <string>
#include <memory>

namespace sim { namespace distributed {

/**
 * @brief Assignment of entity IDs to a specific worker
 */
struct WorkerAssignment {
    int worker_id;
    std::vector<int> entity_ids;
};

/**
 * @brief Coordinator process that manages workers and orchestrates time-stepped simulation
 *
 * The coordinator:
 * 1. Listens on a Unix domain socket for worker connections
 * 2. Assigns entities to workers via INIT messages
 * 3. Steps the simulation by broadcasting STEP and waiting for STEP_COMPLETE
 * 4. Gathers state via SYNC_REQUEST / SYNC_RESPONSE
 * 5. Shuts down workers with SHUTDOWN
 */
class SimCoordinator {
public:
    explicit SimCoordinator(const std::string& socket_path);
    ~SimCoordinator();

    /// Accept workers until expected_workers are connected
    void start(int expected_workers);

    /// Send entity assignments to each worker
    void assign_entities(const std::vector<WorkerAssignment>& assignments);

    /// Advance simulation by dt seconds. Returns false on failure.
    bool step(double dt);

    /// Run simulation from current_time_ until end_time with fixed dt
    bool run_until(double end_time, double dt);

    /// Request all workers to send their current entity states
    std::vector<sim::StateVector> gather_states();

    /// Send SHUTDOWN to all workers and close connections
    void shutdown();

    /// Try to accept a single new worker connection (with timeout)
    bool accept_new_worker(int timeout_ms = 1000);

    /// Handle a disconnected worker (remove from list)
    void handle_worker_disconnect(int worker_id);

    int num_connected() const { return static_cast<int>(worker_sockets_.size()); }

    double current_time() const { return current_time_; }

private:
    IPCSocket server_socket_;
    std::vector<IPCSocket> worker_sockets_;
    std::unique_ptr<TimeBarrier> barrier_;
    double current_time_ = 0.0;

    /// Send a message to all connected workers
    void broadcast(const IPCMessage& msg);

    /// Collect one response from each worker (with timeout)
    std::vector<IPCMessage> collect_responses(int timeout_ms = 5000);
};

}} // namespace sim::distributed

#endif // SIM_SIM_COORDINATOR_HPP
