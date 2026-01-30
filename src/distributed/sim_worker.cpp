#include "distributed/sim_worker.hpp"

#include <sstream>
#include <iostream>
#include <stdexcept>
#include <cstring>

namespace sim { namespace distributed {

// ---------------------------------------------------------------------------
// JSON helpers (local to this TU)
// ---------------------------------------------------------------------------

/// Extract a JSON number value for a given key
static double extract_number(const std::string& json, const std::string& key) {
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

/// Parse integer array from JSON: [0,1,2]
static std::vector<int> parse_int_array(const std::string& json, const std::string& key) {
    std::vector<int> result;

    // Find the key, then find the [ ... ] array
    std::string search = "\"" + key + "\"";
    auto pos = json.find(search);
    if (pos == std::string::npos) return result;

    auto arr_start = json.find('[', pos);
    if (arr_start == std::string::npos) return result;
    auto arr_end = json.find(']', arr_start);
    if (arr_end == std::string::npos) return result;

    std::string arr = json.substr(arr_start + 1, arr_end - arr_start - 1);

    // Split by commas and parse ints
    std::istringstream iss(arr);
    std::string token;
    while (std::getline(iss, token, ',')) {
        // Trim whitespace
        size_t start = token.find_first_not_of(" \t");
        if (start == std::string::npos) continue;
        size_t end = token.find_last_not_of(" \t");
        token = token.substr(start, end - start + 1);
        if (!token.empty()) {
            result.push_back(std::stoi(token));
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// SimWorker
// ---------------------------------------------------------------------------

SimWorker::SimWorker(const std::string& socket_path)
    : socket_path_(socket_path)
{
    // Default update function: no-op
    update_fn_ = [](int, double, sim::StateVector&) {};
}

SimWorker::~SimWorker() {
    socket_.close();
}

bool SimWorker::connect() {
    try {
        socket_ = IPCSocket::connect(socket_path_);

        // Send READY to coordinator
        IPCMessage ready(MessageType::READY, "{}", 0.0);
        return socket_.send(ready);
    } catch (const std::exception& e) {
        std::cerr << "[Worker] Connection failed: " << e.what() << std::endl;
        return false;
    }
}

void SimWorker::run() {
    if (!socket_.is_connected()) {
        std::cerr << "[Worker] Not connected, cannot run." << std::endl;
        return;
    }

    bool running = true;
    while (running) {
        try {
            IPCMessage msg = socket_.receive();

            switch (msg.type) {
                case MessageType::INIT:
                    handle_init(msg);
                    break;

                case MessageType::STEP:
                    handle_step(msg);
                    break;

                case MessageType::SYNC_REQUEST:
                    handle_sync_request(msg);
                    break;

                case MessageType::SHUTDOWN:
                    std::cout << "[Worker] Received SHUTDOWN." << std::endl;
                    running = false;
                    break;

                default:
                    std::cerr << "[Worker] Unknown message type: "
                              << static_cast<int>(msg.type) << std::endl;
                    break;
            }
        } catch (const std::exception& e) {
            std::cerr << "[Worker] Error in event loop: " << e.what() << std::endl;
            running = false;
        }
    }

    socket_.close();
}

void SimWorker::set_update_function(UpdateFunction fn) {
    update_fn_ = std::move(fn);
}

void SimWorker::handle_init(const IPCMessage& msg) {
    // Parse entity IDs from payload: {"worker_id":0,"entity_ids":[0,1]}
    entity_ids_ = parse_int_array(msg.payload, "entity_ids");

    // Create a StateVector for each entity
    states_.clear();
    states_.resize(entity_ids_.size());

    // Initialize time from the message timestamp
    for (auto& sv : states_) {
        sv.time = msg.timestamp;
    }

    std::cout << "[Worker] Initialized with " << entity_ids_.size() << " entities: ";
    for (size_t i = 0; i < entity_ids_.size(); ++i) {
        if (i > 0) std::cout << ", ";
        std::cout << entity_ids_[i];
    }
    std::cout << std::endl;

    // Acknowledge with READY
    IPCMessage ack(MessageType::READY, "{}", msg.timestamp);
    socket_.send(ack);
}

void SimWorker::handle_step(const IPCMessage& msg) {
    // Parse dt from payload: {"dt":60.0,"time":0.0}
    double dt = extract_number(msg.payload, "dt");

    // Update each entity
    for (size_t i = 0; i < entity_ids_.size(); ++i) {
        update_fn_(entity_ids_[i], dt, states_[i]);
        states_[i].time += dt;
    }

    // Send STEP_COMPLETE
    IPCMessage complete(MessageType::STEP_COMPLETE, "{}", msg.timestamp + dt);
    socket_.send(complete);
}

void SimWorker::handle_sync_request(const IPCMessage& msg) {
    std::string payload = serialize_states();

    IPCMessage response(MessageType::SYNC_RESPONSE, payload, msg.timestamp);
    socket_.send(response);
}

std::string SimWorker::serialize_states() const {
    std::ostringstream oss;
    oss << "{\"states\":[";

    for (size_t i = 0; i < states_.size(); ++i) {
        if (i > 0) oss << ",";

        const auto& sv = states_[i];
        int eid = (i < entity_ids_.size()) ? entity_ids_[i] : -1;

        oss << "{"
            << "\"entity_id\":" << eid
            << ",\"px\":" << sv.position.x
            << ",\"py\":" << sv.position.y
            << ",\"pz\":" << sv.position.z
            << ",\"vx\":" << sv.velocity.x
            << ",\"vy\":" << sv.velocity.y
            << ",\"vz\":" << sv.velocity.z
            << ",\"time\":" << sv.time
            << "}";
    }

    oss << "]}";
    return oss.str();
}

}} // namespace sim::distributed
