#ifndef SIM_SIM_WORKER_HPP
#define SIM_SIM_WORKER_HPP

#include "ipc_socket.hpp"
#include "core/state_vector.hpp"
#include <vector>
#include <string>
#include <functional>

namespace sim { namespace distributed {

/**
 * @brief Worker process that simulates assigned entities
 *
 * The worker connects to a coordinator, receives entity assignments,
 * and repeatedly steps its entities forward when instructed.
 * Users provide a custom update function to define per-entity physics.
 */
class SimWorker {
public:
    explicit SimWorker(const std::string& socket_path);
    ~SimWorker();

    /// Connect to the coordinator's Unix domain socket
    bool connect();

    /// Main event loop: blocks until SHUTDOWN is received
    void run();

    /// User-provided function called for each entity on every step
    using UpdateFunction = std::function<void(int entity_id, double dt, sim::StateVector& state)>;
    void set_update_function(UpdateFunction fn);

private:
    IPCSocket socket_;
    std::string socket_path_;
    std::vector<int> entity_ids_;
    std::vector<sim::StateVector> states_;
    UpdateFunction update_fn_;

    void handle_init(const IPCMessage& msg);
    void handle_step(const IPCMessage& msg);
    void handle_sync_request(const IPCMessage& msg);
    std::string serialize_states() const;
};

}} // namespace sim::distributed

#endif // SIM_SIM_WORKER_HPP
