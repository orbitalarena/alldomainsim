#include "distributed/ipc_socket.hpp"

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <poll.h>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <sstream>
#include <algorithm>

namespace sim { namespace distributed {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static std::string message_type_to_string(MessageType t) {
    switch (t) {
        case MessageType::INIT:          return "INIT";
        case MessageType::STEP:          return "STEP";
        case MessageType::SYNC_REQUEST:  return "SYNC_REQUEST";
        case MessageType::SHUTDOWN:      return "SHUTDOWN";
        case MessageType::READY:         return "READY";
        case MessageType::STEP_COMPLETE: return "STEP_COMPLETE";
        case MessageType::SYNC_RESPONSE: return "SYNC_RESPONSE";
        case MessageType::ERROR:         return "ERROR";
    }
    return "UNKNOWN";
}

static MessageType string_to_message_type(const std::string& s) {
    if (s == "INIT")          return MessageType::INIT;
    if (s == "STEP")          return MessageType::STEP;
    if (s == "SYNC_REQUEST")  return MessageType::SYNC_REQUEST;
    if (s == "SHUTDOWN")      return MessageType::SHUTDOWN;
    if (s == "READY")         return MessageType::READY;
    if (s == "STEP_COMPLETE") return MessageType::STEP_COMPLETE;
    if (s == "SYNC_RESPONSE") return MessageType::SYNC_RESPONSE;
    return MessageType::ERROR;
}

/// Escape a string for JSON embedding (handles quotes, backslash, newlines)
static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 16);
    for (char c : s) {
        switch (c) {
            case '\"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;      break;
        }
    }
    return out;
}

/// Unescape a JSON string value (inverse of json_escape)
static std::string json_unescape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '\\' && i + 1 < s.size()) {
            switch (s[i + 1]) {
                case '\"': out += '\"'; ++i; break;
                case '\\': out += '\\'; ++i; break;
                case 'n':  out += '\n'; ++i; break;
                case 'r':  out += '\r'; ++i; break;
                case 't':  out += '\t'; ++i; break;
                default:   out += s[i]; break;
            }
        } else {
            out += s[i];
        }
    }
    return out;
}

/// Extract the string value for a given key from a simple JSON object
static std::string json_get_string(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = json.find(search);
    if (pos == std::string::npos) return "";

    // Skip past key, colon, and opening quote
    pos = json.find(':', pos + search.size());
    if (pos == std::string::npos) return "";
    pos = json.find('\"', pos + 1);
    if (pos == std::string::npos) return "";
    ++pos; // skip opening quote

    // Find closing quote (handling escaped quotes)
    std::string value;
    for (size_t i = pos; i < json.size(); ++i) {
        if (json[i] == '\\' && i + 1 < json.size()) {
            value += json[i];
            value += json[i + 1];
            ++i;
        } else if (json[i] == '\"') {
            break;
        } else {
            value += json[i];
        }
    }
    return json_unescape(value);
}

/// Extract a numeric value for a given key from a simple JSON object
static double json_get_number(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    auto pos = json.find(search);
    if (pos == std::string::npos) return 0.0;

    pos = json.find(':', pos + search.size());
    if (pos == std::string::npos) return 0.0;
    ++pos;

    // Skip whitespace
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;

    // Read number
    std::string num_str;
    while (pos < json.size() && (std::isdigit(json[pos]) || json[pos] == '.' ||
           json[pos] == '-' || json[pos] == '+' || json[pos] == 'e' || json[pos] == 'E')) {
        num_str += json[pos++];
    }
    if (num_str.empty()) return 0.0;
    return std::stod(num_str);
}

// ---------------------------------------------------------------------------
// Construction / Destruction / Move
// ---------------------------------------------------------------------------

IPCSocket::IPCSocket() : fd_(-1), is_server_(false) {}

IPCSocket::~IPCSocket() {
    close();
}

IPCSocket::IPCSocket(IPCSocket&& other) noexcept
    : fd_(other.fd_), is_server_(other.is_server_), socket_path_(std::move(other.socket_path_))
{
    other.fd_ = -1;
    other.is_server_ = false;
}

IPCSocket& IPCSocket::operator=(IPCSocket&& other) noexcept {
    if (this != &other) {
        close();
        fd_ = other.fd_;
        is_server_ = other.is_server_;
        socket_path_ = std::move(other.socket_path_);
        other.fd_ = -1;
        other.is_server_ = false;
    }
    return *this;
}

// ---------------------------------------------------------------------------
// Static factory methods
// ---------------------------------------------------------------------------

IPCSocket IPCSocket::listen(const std::string& socket_path) {
    // Remove stale socket file if it exists
    ::unlink(socket_path.c_str());

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        throw std::runtime_error("Failed to create Unix domain socket: " +
                                 std::string(std::strerror(errno)));
    }

    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, socket_path.c_str(), sizeof(addr.sun_path) - 1);

    if (::bind(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        throw std::runtime_error("Failed to bind socket to " + socket_path + ": " +
                                 std::string(std::strerror(errno)));
    }

    if (::listen(fd, 5) < 0) {
        ::close(fd);
        ::unlink(socket_path.c_str());
        throw std::runtime_error("Failed to listen on socket: " +
                                 std::string(std::strerror(errno)));
    }

    IPCSocket sock;
    sock.fd_ = fd;
    sock.is_server_ = true;
    sock.socket_path_ = socket_path;
    return sock;
}

IPCSocket IPCSocket::connect(const std::string& socket_path) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        throw std::runtime_error("Failed to create Unix domain socket: " +
                                 std::string(std::strerror(errno)));
    }

    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, socket_path.c_str(), sizeof(addr.sun_path) - 1);

    if (::connect(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        throw std::runtime_error("Failed to connect to " + socket_path + ": " +
                                 std::string(std::strerror(errno)));
    }

    IPCSocket sock;
    sock.fd_ = fd;
    sock.is_server_ = false;
    return sock;
}

IPCSocket IPCSocket::accept() {
    if (!is_server_ || fd_ < 0) {
        throw std::runtime_error("Cannot accept on non-server or closed socket");
    }

    struct sockaddr_un client_addr;
    socklen_t client_len = sizeof(client_addr);
    int client_fd = ::accept(fd_, reinterpret_cast<struct sockaddr*>(&client_addr), &client_len);
    if (client_fd < 0) {
        throw std::runtime_error("Failed to accept connection: " +
                                 std::string(std::strerror(errno)));
    }

    IPCSocket sock;
    sock.fd_ = client_fd;
    sock.is_server_ = false;
    return sock;
}

// ---------------------------------------------------------------------------
// Send / Receive
// ---------------------------------------------------------------------------

bool IPCSocket::send(const IPCMessage& msg) {
    if (fd_ < 0) return false;
    std::string data = serialize_message(msg);
    return send_raw(data);
}

IPCMessage IPCSocket::receive() {
    if (fd_ < 0) {
        throw std::runtime_error("Cannot receive on closed socket");
    }
    std::string data = receive_raw();
    return deserialize_message(data);
}

std::pair<bool, IPCMessage> IPCSocket::receive_timeout(int timeout_ms) {
    if (fd_ < 0) {
        return {false, IPCMessage()};
    }

    struct pollfd pfd;
    pfd.fd = fd_;
    pfd.events = POLLIN;
    pfd.revents = 0;

    int ret = ::poll(&pfd, 1, timeout_ms);
    if (ret <= 0) {
        // Timeout or error
        return {false, IPCMessage()};
    }

    if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
        return {false, IPCMessage()};
    }

    if (pfd.revents & POLLIN) {
        try {
            IPCMessage msg = receive();
            return {true, msg};
        } catch (...) {
            return {false, IPCMessage()};
        }
    }

    return {false, IPCMessage()};
}

void IPCSocket::close() {
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    // Remove socket file if we were the server
    if (is_server_ && !socket_path_.empty()) {
        ::unlink(socket_path_.c_str());
        socket_path_.clear();
        is_server_ = false;
    }
}

bool IPCSocket::is_connected() const {
    return fd_ >= 0;
}

// ---------------------------------------------------------------------------
// Frame protocol: [4-byte big-endian length][payload]
// ---------------------------------------------------------------------------

bool IPCSocket::send_raw(const std::string& data) {
    if (fd_ < 0) return false;

    uint32_t len = static_cast<uint32_t>(data.size());

    // Big-endian length prefix
    unsigned char header[4];
    header[0] = static_cast<unsigned char>((len >> 24) & 0xFF);
    header[1] = static_cast<unsigned char>((len >> 16) & 0xFF);
    header[2] = static_cast<unsigned char>((len >> 8)  & 0xFF);
    header[3] = static_cast<unsigned char>((len)       & 0xFF);

    // Send header
    ssize_t total = 0;
    while (total < 4) {
        ssize_t n = ::write(fd_, header + total, 4 - static_cast<size_t>(total));
        if (n <= 0) return false;
        total += n;
    }

    // Send payload
    total = 0;
    ssize_t payload_len = static_cast<ssize_t>(data.size());
    while (total < payload_len) {
        ssize_t n = ::write(fd_, data.data() + total, static_cast<size_t>(payload_len - total));
        if (n <= 0) return false;
        total += n;
    }

    return true;
}

std::string IPCSocket::receive_raw() {
    if (fd_ < 0) {
        throw std::runtime_error("Cannot receive on closed socket");
    }

    // Read 4-byte length header
    unsigned char header[4];
    ssize_t total = 0;
    while (total < 4) {
        ssize_t n = ::read(fd_, header + total, 4 - static_cast<size_t>(total));
        if (n <= 0) {
            throw std::runtime_error("Connection closed while reading header");
        }
        total += n;
    }

    uint32_t len = (static_cast<uint32_t>(header[0]) << 24) |
                   (static_cast<uint32_t>(header[1]) << 16) |
                   (static_cast<uint32_t>(header[2]) << 8)  |
                   (static_cast<uint32_t>(header[3]));

    if (len == 0) return "";
    if (len > 10 * 1024 * 1024) {  // 10 MB safety limit
        throw std::runtime_error("Message too large: " + std::to_string(len) + " bytes");
    }

    // Read payload
    std::string data(len, '\0');
    total = 0;
    ssize_t payload_len = static_cast<ssize_t>(len);
    while (total < payload_len) {
        ssize_t n = ::read(fd_, &data[static_cast<size_t>(total)],
                           static_cast<size_t>(payload_len - total));
        if (n <= 0) {
            throw std::runtime_error("Connection closed while reading payload");
        }
        total += n;
    }

    return data;
}

// ---------------------------------------------------------------------------
// JSON serialization (no external library)
// ---------------------------------------------------------------------------

std::string IPCSocket::serialize_message(const IPCMessage& msg) {
    std::ostringstream oss;
    oss << "{\"type\":\"" << message_type_to_string(msg.type) << "\""
        << ",\"payload\":\"" << json_escape(msg.payload) << "\""
        << ",\"timestamp\":" << std::to_string(msg.timestamp)
        << "}";
    return oss.str();
}

IPCMessage IPCSocket::deserialize_message(const std::string& json) {
    IPCMessage msg;
    msg.type = string_to_message_type(json_get_string(json, "type"));
    msg.payload = json_get_string(json, "payload");
    msg.timestamp = json_get_number(json, "timestamp");
    return msg;
}

}} // namespace sim::distributed
