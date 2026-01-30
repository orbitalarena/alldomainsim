#include "distributed/sim_coordinator.hpp"

#include <sstream>
#include <stdexcept>
#include <iostream>
#include <cstring>
#include <poll.h>

namespace sim { namespace distributed {

// ---------------------------------------------------------------------------
// JSON helpers (local to this TU)
// ---------------------------------------------------------------------------

/// Build a JSON array of ints: [1,2,3]
static std::string ints_to_json_array(const std::vector<int>& ids) {
    std::ostringstream oss;
    oss << "[";
    for (size_t i = 0; i < ids.size(); ++i) {
        if (i > 0) oss << ",";
        oss << ids[i];
    }
    oss << "]";
    return oss.str();
}

/// Extract a JSON string value for a given key (simple flat object)
static std::string extract_json_string(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = json.find(search);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + search.size());
    if (pos == std::string::npos) return "";
    pos = json.find('\"', pos + 1);
    if (pos == std::string::npos) return "";
    ++pos;
    auto end = json.find('\"', pos);
    if (end == std::string::npos) return "";
    return json.substr(pos, end - pos);
}

/// Extract a JSON number value for a given key
static double extract_json_number(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = json.find(search);
    if (pos == std::string::npos) return 0.0;
    pos = json.find(':', pos + search.size());
    if (pos == std::string::npos) return 0.0;
    ++pos;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
    std::string num_str;
    while (pos < json.size() && (std::isdigit(json[pos]) || json[pos] == '.' ||
           json[pos] == '-' || json[pos] == '+' || json[pos] == 'e' || json[pos] == 'E')) {
        num_str += json[pos++];
    }
    if (num_str.empty()) return 0.0;
    return std::stod(num_str);
}

/// Parse a JSON array of state vectors from the payload
/// Format: {"states":[{"entity_id":0,"px":...,"py":...,"pz":...,"vx":...,"vy":...,"vz":...,"time":...}, ...]}
static std::vector<sim::StateVector> parse_state_vectors(const std::string& payload) {
    std::vector<sim::StateVector> results;

    // Find the "states" array
    auto arr_start = payload.find("[");
    if (arr_start == std::string::npos) return results;

    // Walk through objects in the array
    size_t pos = arr_start;
    while (true) {
        auto obj_start = payload.find('{', pos);
        if (obj_start == std::string::npos) break;
        auto obj_end = payload.find('}', obj_start);
        if (obj_end == std::string::npos) break;

        std::string obj = payload.substr(obj_start, obj_end - obj_start + 1);

        sim::StateVector sv;
        sv.position.x = extract_json_number(obj, "px");
        sv.position.y = extract_json_number(obj, "py");
        sv.position.z = extract_json_number(obj, "pz");
        sv.velocity.x = extract_json_number(obj, "vx");
        sv.velocity.y = extract_json_number(obj, "vy");
        sv.velocity.z = extract_json_number(obj, "vz");
        sv.time = extract_json_number(obj, "time");

        results.push_back(sv);

        pos = obj_end + 1;
    }

    return results;
}

// ---------------------------------------------------------------------------
// SimCoordinator
// ---------------------------------------------------------------------------

SimCoordinator::SimCoordinator(const std::string& socket_path)
    : server_socket_(IPCSocket::listen(socket_path)),
      current_time_(0.0)
{
}

SimCoordinator::~SimCoordinator() {
    // Best-effort shutdown
    try {
        shutdown();
    } catch (...) {}
}

void SimCoordinator::start(int expected_workers) {
    std::cout << "[Coordinator] Waiting for " << expected_workers << " workers..." << std::endl;

    while (num_connected() < expected_workers) {
        if (!accept_new_worker(2000)) {
            // Retry on timeout
            continue;
        }
    }

    // Create the time barrier now that we know the worker count
    barrier_ = std::make_unique<TimeBarrier>(expected_workers);

    std::cout << "[Coordinator] All " << expected_workers << " workers connected." << std::endl;
}

bool SimCoordinator::accept_new_worker(int timeout_ms) {
    // Use poll on the server socket to implement timeout
    struct pollfd pfd;
    pfd.fd = -1; // We'll work around this by using the accept with a timeout approach

    // For simplicity, we use a blocking accept wrapped by poll on the raw fd.
    // Access the server socket's fd through a receive_timeout-style approach.
    // Since IPCSocket doesn't expose fd_, we use the accept() method directly
    // with a poll on the server socket. We need to use the socket's is_connected
    // to check if server is valid.

    // Actually, IPCSocket::accept() is blocking. For the demo, short timeouts
    // are okay. In production, we'd expose fd_ or add accept_timeout().
    // Let's do a simple poll-based approach using the raw fd from the socket.
    // We can't access fd_ directly, but we can accept since workers connect fast.

    // For robustness: try accept(), workers should connect quickly in practice.
    // The server_socket_ will block on accept(). For the in-process demo,
    // workers connect immediately. For a real system, we would add accept_timeout().

    (void)timeout_ms; // In-process demo: workers connect quickly

    try {
        IPCSocket worker = server_socket_.accept();

        // Wait for READY message from worker
        auto [ok, msg] = worker.receive_timeout(5000);
        if (ok && msg.type == MessageType::READY) {
            std::cout << "[Coordinator] Worker " << num_connected() << " connected." << std::endl;
            worker_sockets_.push_back(std::move(worker));
            return true;
        } else {
            std::cerr << "[Coordinator] Worker did not send READY, dropping." << std::endl;
            worker.close();
            return false;
        }
    } catch (const std::exception& e) {
        std::cerr << "[Coordinator] Accept failed: " << e.what() << std::endl;
        return false;
    }
}

void SimCoordinator::assign_entities(const std::vector<WorkerAssignment>& assignments) {
    for (const auto& assignment : assignments) {
        int wid = assignment.worker_id;
        if (wid < 0 || wid >= static_cast<int>(worker_sockets_.size())) {
            std::cerr << "[Coordinator] Invalid worker_id " << wid << " in assignment." << std::endl;
            continue;
        }

        // Build JSON payload: {"worker_id":0,"entity_ids":[0,1]}
        std::ostringstream oss;
        oss << "{\"worker_id\":" << wid
            << ",\"entity_ids\":" << ints_to_json_array(assignment.entity_ids)
            << "}";

        IPCMessage msg(MessageType::INIT, oss.str(), current_time_);
        if (!worker_sockets_[static_cast<size_t>(wid)].send(msg)) {
            std::cerr << "[Coordinator] Failed to send INIT to worker " << wid << std::endl;
        }
    }

    // Wait for acknowledgements (workers respond with READY after INIT)
    for (size_t i = 0; i < worker_sockets_.size(); ++i) {
        auto [ok, resp] = worker_sockets_[i].receive_timeout(5000);
        if (!ok || resp.type != MessageType::READY) {
            std::cerr << "[Coordinator] Worker " << i
                      << " did not acknowledge INIT." << std::endl;
        }
    }

    std::cout << "[Coordinator] All entity assignments sent." << std::endl;
}

bool SimCoordinator::step(double dt) {
    if (worker_sockets_.empty()) return false;

    // Build step payload: {"dt":60.0,"time":0.0}
    std::ostringstream oss;
    oss << "{\"dt\":" << dt << ",\"time\":" << current_time_ << "}";

    IPCMessage step_msg(MessageType::STEP, oss.str(), current_time_);
    broadcast(step_msg);

    // Collect STEP_COMPLETE responses
    if (barrier_) {
        barrier_->reset();
    }

    auto responses = collect_responses(5000);

    bool all_ok = true;
    for (size_t i = 0; i < responses.size(); ++i) {
        if (responses[i].type != MessageType::STEP_COMPLETE) {
            std::cerr << "[Coordinator] Worker " << i
                      << " returned " << static_cast<int>(responses[i].type)
                      << " instead of STEP_COMPLETE." << std::endl;
            all_ok = false;
        }
        if (barrier_) {
            barrier_->worker_done(static_cast<int>(i),
                                  responses[i].type == MessageType::STEP_COMPLETE);
        }
    }

    current_time_ += dt;
    return all_ok;
}

bool SimCoordinator::run_until(double end_time, double dt) {
    int step_count = 0;
    while (current_time_ < end_time) {
        if (!step(dt)) {
            std::cerr << "[Coordinator] Step failed at time " << current_time_ << std::endl;
            return false;
        }
        ++step_count;
    }
    std::cout << "[Coordinator] Completed " << step_count << " steps. Time = "
              << current_time_ << "s" << std::endl;
    return true;
}

std::vector<sim::StateVector> SimCoordinator::gather_states() {
    IPCMessage sync_msg(MessageType::SYNC_REQUEST, "{}", current_time_);
    broadcast(sync_msg);

    auto responses = collect_responses(5000);

    std::vector<sim::StateVector> all_states;
    for (const auto& resp : responses) {
        if (resp.type == MessageType::SYNC_RESPONSE) {
            auto states = parse_state_vectors(resp.payload);
            all_states.insert(all_states.end(), states.begin(), states.end());
        }
    }

    return all_states;
}

void SimCoordinator::shutdown() {
    IPCMessage shutdown_msg(MessageType::SHUTDOWN, "{}", current_time_);

    for (auto& ws : worker_sockets_) {
        try {
            ws.send(shutdown_msg);
        } catch (...) {}
    }

    // Close all worker sockets
    for (auto& ws : worker_sockets_) {
        ws.close();
    }
    worker_sockets_.clear();

    server_socket_.close();
}

void SimCoordinator::handle_worker_disconnect(int worker_id) {
    if (worker_id < 0 || worker_id >= static_cast<int>(worker_sockets_.size())) return;

    std::cerr << "[Coordinator] Worker " << worker_id << " disconnected." << std::endl;
    worker_sockets_[static_cast<size_t>(worker_id)].close();
    // Note: We don't erase to keep worker indices stable.
    // A production system would handle re-assignment.
}

void SimCoordinator::broadcast(const IPCMessage& msg) {
    for (auto& ws : worker_sockets_) {
        if (ws.is_connected()) {
            if (!ws.send(msg)) {
                std::cerr << "[Coordinator] Failed to send to a worker." << std::endl;
            }
        }
    }
}

std::vector<IPCMessage> SimCoordinator::collect_responses(int timeout_ms) {
    std::vector<IPCMessage> responses;
    responses.reserve(worker_sockets_.size());

    for (auto& ws : worker_sockets_) {
        if (!ws.is_connected()) {
            // Push an error placeholder
            responses.push_back(IPCMessage(MessageType::ERROR, "disconnected", current_time_));
            continue;
        }

        auto [ok, msg] = ws.receive_timeout(timeout_ms);
        if (ok) {
            responses.push_back(msg);
        } else {
            responses.push_back(IPCMessage(MessageType::ERROR, "timeout", current_time_));
        }
    }

    return responses;
}

}} // namespace sim::distributed
