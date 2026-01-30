/**
 * JSON Reader Implementation — Recursive descent parser
 */

#include "json_reader.hpp"
#include <fstream>
#include <sstream>
#include <cctype>
#include <cstdlib>
#include <stdexcept>

namespace sim {

// ═══════════════════════════════════════════════════════════════
// Parser internals
// ═══════════════════════════════════════════════════════════════

namespace {

class Parser {
public:
    explicit Parser(const std::string& input) : src_(input), pos_(0) {}

    JsonValue parse() {
        skip_whitespace();
        JsonValue val = parse_value();
        skip_whitespace();
        return val;
    }

private:
    const std::string& src_;
    size_t pos_;

    char peek() const {
        if (pos_ >= src_.size()) return '\0';
        return src_[pos_];
    }

    char advance() {
        if (pos_ >= src_.size()) throw error("Unexpected end of input");
        return src_[pos_++];
    }

    void expect(char c) {
        char got = advance();
        if (got != c) {
            throw error(std::string("Expected '") + c + "', got '" + got + "'");
        }
    }

    void skip_whitespace() {
        while (pos_ < src_.size() && std::isspace(static_cast<unsigned char>(src_[pos_]))) {
            pos_++;
        }
    }

    std::runtime_error error(const std::string& msg) const {
        return std::runtime_error("JSON parse error at position " +
                                  std::to_string(pos_) + ": " + msg);
    }

    JsonValue parse_value() {
        skip_whitespace();
        char c = peek();

        if (c == '"') return parse_string_value();
        if (c == '{') return parse_object();
        if (c == '[') return parse_array();
        if (c == 't' || c == 'f') return parse_bool();
        if (c == 'n') return parse_null();
        if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) return parse_number();

        throw error(std::string("Unexpected character: '") + c + "'");
    }

    JsonValue parse_string_value() {
        return JsonValue(parse_string());
    }

    std::string parse_string() {
        expect('"');
        std::string result;
        while (true) {
            if (pos_ >= src_.size()) throw error("Unterminated string");
            char c = src_[pos_++];

            if (c == '"') break;

            if (c == '\\') {
                if (pos_ >= src_.size()) throw error("Unterminated escape");
                char esc = src_[pos_++];
                switch (esc) {
                    case '"':  result += '"'; break;
                    case '\\': result += '\\'; break;
                    case '/':  result += '/'; break;
                    case 'b':  result += '\b'; break;
                    case 'f':  result += '\f'; break;
                    case 'n':  result += '\n'; break;
                    case 'r':  result += '\r'; break;
                    case 't':  result += '\t'; break;
                    case 'u': {
                        // Unicode escape: \uXXXX — simplified to ASCII
                        if (pos_ + 4 > src_.size()) throw error("Incomplete \\u escape");
                        std::string hex = src_.substr(pos_, 4);
                        pos_ += 4;
                        unsigned long code = std::strtoul(hex.c_str(), nullptr, 16);
                        if (code < 128) {
                            result += static_cast<char>(code);
                        } else {
                            // UTF-8 encode (simplified: BMP only)
                            if (code < 0x800) {
                                result += static_cast<char>(0xC0 | (code >> 6));
                                result += static_cast<char>(0x80 | (code & 0x3F));
                            } else {
                                result += static_cast<char>(0xE0 | (code >> 12));
                                result += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
                                result += static_cast<char>(0x80 | (code & 0x3F));
                            }
                        }
                        break;
                    }
                    default:
                        throw error(std::string("Unknown escape: \\") + esc);
                }
            } else {
                result += c;
            }
        }
        return result;
    }

    JsonValue parse_number() {
        size_t start = pos_;
        if (peek() == '-') pos_++;

        // Integer part
        if (peek() == '0') {
            pos_++;
        } else if (std::isdigit(static_cast<unsigned char>(peek()))) {
            while (std::isdigit(static_cast<unsigned char>(peek()))) pos_++;
        } else {
            throw error("Expected digit in number");
        }

        // Fractional part
        if (peek() == '.') {
            pos_++;
            if (!std::isdigit(static_cast<unsigned char>(peek()))) {
                throw error("Expected digit after decimal point");
            }
            while (std::isdigit(static_cast<unsigned char>(peek()))) pos_++;
        }

        // Exponent
        if (peek() == 'e' || peek() == 'E') {
            pos_++;
            if (peek() == '+' || peek() == '-') pos_++;
            if (!std::isdigit(static_cast<unsigned char>(peek()))) {
                throw error("Expected digit in exponent");
            }
            while (std::isdigit(static_cast<unsigned char>(peek()))) pos_++;
        }

        std::string numstr = src_.substr(start, pos_ - start);
        double val = std::strtod(numstr.c_str(), nullptr);
        return JsonValue(val);
    }

    JsonValue parse_bool() {
        if (src_.compare(pos_, 4, "true") == 0) {
            pos_ += 4;
            return JsonValue(true);
        }
        if (src_.compare(pos_, 5, "false") == 0) {
            pos_ += 5;
            return JsonValue(false);
        }
        throw error("Expected 'true' or 'false'");
    }

    JsonValue parse_null() {
        if (src_.compare(pos_, 4, "null") == 0) {
            pos_ += 4;
            return JsonValue();
        }
        throw error("Expected 'null'");
    }

    JsonValue parse_object() {
        expect('{');
        JsonValue obj;
        obj.set_object();

        skip_whitespace();
        if (peek() == '}') {
            pos_++;
            return obj;
        }

        while (true) {
            skip_whitespace();
            std::string key = parse_string();
            skip_whitespace();
            expect(':');
            skip_whitespace();
            JsonValue val = parse_value();
            obj.add_member(key, std::move(val));

            skip_whitespace();
            if (peek() == ',') {
                pos_++;
            } else {
                break;
            }
        }

        skip_whitespace();
        expect('}');
        return obj;
    }

    JsonValue parse_array() {
        expect('[');
        JsonValue arr;
        arr.set_array();

        skip_whitespace();
        if (peek() == ']') {
            pos_++;
            return arr;
        }

        while (true) {
            skip_whitespace();
            arr.add_element(parse_value());

            skip_whitespace();
            if (peek() == ',') {
                pos_++;
            } else {
                break;
            }
        }

        skip_whitespace();
        expect(']');
        return arr;
    }
};

}  // anonymous namespace

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

JsonValue JsonReader::parse(const std::string& json) {
    Parser parser(json);
    return parser.parse();
}

JsonValue JsonReader::parse_file(const std::string& filename) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Cannot open JSON file: " + filename);
    }

    std::ostringstream ss;
    ss << file.rdbuf();
    return parse(ss.str());
}

}  // namespace sim
