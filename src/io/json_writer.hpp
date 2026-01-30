/**
 * Lightweight JSON Writer (header-only)
 *
 * Produces well-formed JSON with optional indentation.
 * No external dependencies — just writes to an ostream.
 *
 * Usage:
 *   std::ofstream f("out.json");
 *   JsonWriter w(f);
 *   w.begin_object();
 *     w.key("name").value("test");
 *     w.key("count").value(42);
 *     w.key("items").begin_array();
 *       w.value(1); w.value(2); w.value(3);
 *     w.end_array();
 *   w.end_object();
 */

#ifndef SIM_JSON_WRITER_HPP
#define SIM_JSON_WRITER_HPP

#include <ostream>
#include <string>
#include <vector>
#include <cmath>
#include <iomanip>
#include <sstream>

namespace sim {

class JsonWriter {
public:
    explicit JsonWriter(std::ostream& os, int indent_size = 2)
        : os_(os), indent_size_(indent_size) {}

    // ── Structure ──

    JsonWriter& begin_object() {
        if (!expect_value_) write_separator();
        os_ << '{';
        expect_value_ = false;
        push_scope(OBJECT);
        return *this;
    }

    JsonWriter& end_object() {
        pop_scope();
        newline();
        os_ << '}';
        return *this;
    }

    JsonWriter& begin_array() {
        if (!expect_value_) write_separator();
        os_ << '[';
        expect_value_ = false;
        push_scope(ARRAY);
        return *this;
    }

    JsonWriter& end_array() {
        pop_scope();
        newline();
        os_ << ']';
        return *this;
    }

    // ── Keys (object members) ──

    JsonWriter& key(const std::string& k) {
        write_separator();
        os_ << '"';
        write_escaped(k);
        os_ << "\": ";
        expect_value_ = true;
        return *this;
    }

    // ── Values ──

    JsonWriter& value(const std::string& v) {
        if (!expect_value_) write_separator();
        os_ << '"';
        write_escaped(v);
        os_ << '"';
        expect_value_ = false;
        return *this;
    }

    JsonWriter& value(const char* v) {
        return value(std::string(v));
    }

    JsonWriter& value(int v) {
        if (!expect_value_) write_separator();
        os_ << v;
        expect_value_ = false;
        return *this;
    }

    JsonWriter& value(size_t v) {
        if (!expect_value_) write_separator();
        os_ << v;
        expect_value_ = false;
        return *this;
    }

    JsonWriter& value(double v) {
        if (!expect_value_) write_separator();
        if (std::isnan(v) || std::isinf(v)) {
            os_ << "null";
        } else {
            // Use enough precision for scientific data
            os_ << std::setprecision(15) << v;
        }
        expect_value_ = false;
        return *this;
    }

    JsonWriter& value(bool v) {
        if (!expect_value_) write_separator();
        os_ << (v ? "true" : "false");
        expect_value_ = false;
        return *this;
    }

    JsonWriter& null_value() {
        if (!expect_value_) write_separator();
        os_ << "null";
        expect_value_ = false;
        return *this;
    }

    // ── Convenience: key-value pair ──

    template<typename T>
    JsonWriter& kv(const std::string& k, const T& v) {
        key(k);
        value(v);
        return *this;
    }

private:
    enum ScopeType { OBJECT, ARRAY };

    struct Scope {
        ScopeType type;
        int count = 0;  // Number of items written at this level
    };

    std::ostream& os_;
    int indent_size_;
    std::vector<Scope> stack_;
    bool expect_value_ = false;

    void push_scope(ScopeType type) {
        stack_.push_back({type, 0});
    }

    void pop_scope() {
        if (!stack_.empty()) {
            stack_.pop_back();
        }
        if (!stack_.empty()) {
            stack_.back().count++;
        }
    }

    void write_separator() {
        if (expect_value_) return;  // After key — no comma/newline needed

        if (!stack_.empty()) {
            auto& scope = stack_.back();
            if (scope.count > 0) {
                os_ << ',';
            }
            newline();
            scope.count++;
        }
    }

    void newline() {
        os_ << '\n';
        int depth = static_cast<int>(stack_.size());
        for (int i = 0; i < depth * indent_size_; i++) {
            os_ << ' ';
        }
    }

    void write_escaped(const std::string& s) {
        for (char c : s) {
            switch (c) {
                case '"':  os_ << "\\\""; break;
                case '\\': os_ << "\\\\"; break;
                case '\b': os_ << "\\b";  break;
                case '\f': os_ << "\\f";  break;
                case '\n': os_ << "\\n";  break;
                case '\r': os_ << "\\r";  break;
                case '\t': os_ << "\\t";  break;
                default:
                    if (static_cast<unsigned char>(c) < 0x20) {
                        // Control character — hex escape
                        char buf[8];
                        std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(c));
                        os_ << buf;
                    } else {
                        os_ << c;
                    }
                    break;
            }
        }
    }
};

}  // namespace sim

#endif  // SIM_JSON_WRITER_HPP
