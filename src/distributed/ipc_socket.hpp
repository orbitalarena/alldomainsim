#ifndef SIM_IPC_SOCKET_HPP
#define SIM_IPC_SOCKET_HPP

#include <string>
#include <utility>

namespace sim { namespace distributed {

enum class MessageType {
    INIT,           // coordinator -> worker
    STEP,           // coordinator -> worker
    SYNC_REQUEST,   // coordinator -> worker
    SHUTDOWN,       // coordinator -> worker
    READY,          // worker -> coordinator
    STEP_COMPLETE,  // worker -> coordinator
    SYNC_RESPONSE,  // worker -> coordinator
    ERROR           // worker -> coordinator
};

struct IPCMessage {
    MessageType type;
    std::string payload;   // JSON string
    double timestamp;

    IPCMessage() : type(MessageType::ERROR), timestamp(0.0) {}
    IPCMessage(MessageType t, const std::string& p, double ts)
        : type(t), payload(p), timestamp(ts) {}
};

class IPCSocket {
public:
    IPCSocket();
    ~IPCSocket();

    // Move-only (no copy)
    IPCSocket(IPCSocket&& other) noexcept;
    IPCSocket& operator=(IPCSocket&& other) noexcept;
    IPCSocket(const IPCSocket&) = delete;
    IPCSocket& operator=(const IPCSocket&) = delete;

    /// Create a listening server socket at the given Unix domain path
    static IPCSocket listen(const std::string& socket_path);

    /// Connect to a listening server at the given Unix domain path
    static IPCSocket connect(const std::string& socket_path);

    /// Accept an incoming connection (blocking)
    IPCSocket accept();

    /// Send a message (length-prefixed JSON frame)
    bool send(const IPCMessage& msg);

    /// Receive a message (blocking)
    IPCMessage receive();

    /// Receive with timeout; returns {true, msg} on success, {false, {}} on timeout
    std::pair<bool, IPCMessage> receive_timeout(int timeout_ms);

    /// Close the socket
    void close();

    /// Check if the socket is connected
    bool is_connected() const;

private:
    int fd_ = -1;
    bool is_server_ = false;
    std::string socket_path_;

    // Frame protocol: [4-byte big-endian length][JSON payload]
    bool send_raw(const std::string& data);
    std::string receive_raw();

    static std::string serialize_message(const IPCMessage& msg);
    static IPCMessage deserialize_message(const std::string& json);
};

}} // namespace sim::distributed

#endif // SIM_IPC_SOCKET_HPP
