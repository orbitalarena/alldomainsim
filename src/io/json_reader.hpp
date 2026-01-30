/**
 * Lightweight JSON Reader
 *
 * Recursive-descent parser producing a tree of JsonValue nodes.
 * Handles objects, arrays, strings, numbers (including scientific notation),
 * booleans, and null. No external dependencies.
 *
 * Usage:
 *   auto root = JsonReader::parse_file("state.json");
 *   double time = root["sim_time"].as_number();
 *   std::string name = root["entities"][0]["name"].as_string();
 */

#ifndef SIM_JSON_READER_HPP
#define SIM_JSON_READER_HPP

#include <string>
#include <vector>
#include <unordered_map>
#include <memory>
#include <stdexcept>

namespace sim {

enum class JsonType {
    NIL,
    BOOL,
    NUMBER,
    STRING,
    OBJECT,
    ARRAY
};

class JsonValue {
public:
    JsonType type = JsonType::NIL;

    // Constructors
    JsonValue() = default;
    explicit JsonValue(bool v) : type(JsonType::BOOL), bool_val_(v) {}
    explicit JsonValue(double v) : type(JsonType::NUMBER), num_val_(v) {}
    explicit JsonValue(const std::string& v) : type(JsonType::STRING), str_val_(v) {}
    explicit JsonValue(std::string&& v) : type(JsonType::STRING), str_val_(std::move(v)) {}

    // Type checks
    bool is_null()   const { return type == JsonType::NIL; }
    bool is_bool()   const { return type == JsonType::BOOL; }
    bool is_number() const { return type == JsonType::NUMBER; }
    bool is_string() const { return type == JsonType::STRING; }
    bool is_object() const { return type == JsonType::OBJECT; }
    bool is_array()  const { return type == JsonType::ARRAY; }

    // Value accessors (throw on type mismatch)
    bool as_bool() const {
        if (type != JsonType::BOOL) throw std::runtime_error("JsonValue: not a bool");
        return bool_val_;
    }

    double as_number() const {
        if (type != JsonType::NUMBER) throw std::runtime_error("JsonValue: not a number");
        return num_val_;
    }

    int as_int() const { return static_cast<int>(as_number()); }

    const std::string& as_string() const {
        if (type != JsonType::STRING) throw std::runtime_error("JsonValue: not a string");
        return str_val_;
    }

    // Safe accessors (return defaults on type mismatch)
    bool get_bool(bool def = false) const { return is_bool() ? bool_val_ : def; }
    double get_number(double def = 0.0) const { return is_number() ? num_val_ : def; }
    int get_int(int def = 0) const { return is_number() ? static_cast<int>(num_val_) : def; }
    std::string get_string(const std::string& def = "") const { return is_string() ? str_val_ : def; }

    // Object access
    const JsonValue& operator[](const std::string& key) const {
        if (type != JsonType::OBJECT) return null_value();
        auto it = obj_map_.find(key);
        if (it == obj_map_.end()) return null_value();
        return it->second;
    }

    bool has(const std::string& key) const {
        if (type != JsonType::OBJECT) return false;
        return obj_map_.count(key) > 0;
    }

    const std::unordered_map<std::string, JsonValue>& as_object() const {
        return obj_map_;
    }

    // Array access
    const JsonValue& operator[](size_t index) const {
        if (type != JsonType::ARRAY || index >= arr_val_.size()) return null_value();
        return arr_val_[index];
    }

    size_t size() const {
        if (type == JsonType::ARRAY) return arr_val_.size();
        if (type == JsonType::OBJECT) return obj_map_.size();
        return 0;
    }

    const std::vector<JsonValue>& as_array() const {
        return arr_val_;
    }

    // Mutators (for building values during parse)
    void set_object() { type = JsonType::OBJECT; }
    void set_array()  { type = JsonType::ARRAY; }

    void add_member(const std::string& key, JsonValue&& val) {
        obj_map_[key] = std::move(val);
    }

    void add_element(JsonValue&& val) {
        arr_val_.push_back(std::move(val));
    }

private:
    bool bool_val_ = false;
    double num_val_ = 0.0;
    std::string str_val_;
    std::unordered_map<std::string, JsonValue> obj_map_;
    std::vector<JsonValue> arr_val_;

    static const JsonValue& null_value() {
        static JsonValue nil;
        return nil;
    }
};

class JsonReader {
public:
    /**
     * Parse a JSON string into a JsonValue tree.
     * @throws std::runtime_error on parse errors
     */
    static JsonValue parse(const std::string& json);

    /**
     * Parse a JSON file into a JsonValue tree.
     * @throws std::runtime_error on file or parse errors
     */
    static JsonValue parse_file(const std::string& filename);
};

}  // namespace sim

#endif  // SIM_JSON_READER_HPP
