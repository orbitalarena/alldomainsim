#include "world_cities.hpp"
#include <fstream>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>

namespace sim {

namespace {
    // Simple JSON parsing helpers (avoiding external dependencies)
    std::string trim(const std::string& s) {
        size_t start = s.find_first_not_of(" \t\n\r\"");
        size_t end = s.find_last_not_of(" \t\n\r\"");
        return (start == std::string::npos) ? "" : s.substr(start, end - start + 1);
    }

    std::string to_lower(const std::string& s) {
        std::string result = s;
        std::transform(result.begin(), result.end(), result.begin(),
                      [](unsigned char c) { return std::tolower(c); });
        return result;
    }

    double haversine_km(double lat1, double lon1, double lat2, double lon2) {
        const double R = 6371.0;  // Earth radius in km
        const double DEG_TO_RAD = M_PI / 180.0;

        double dlat = (lat2 - lat1) * DEG_TO_RAD;
        double dlon = (lon2 - lon1) * DEG_TO_RAD;
        lat1 *= DEG_TO_RAD;
        lat2 *= DEG_TO_RAD;

        double a = std::sin(dlat/2) * std::sin(dlat/2) +
                   std::cos(lat1) * std::cos(lat2) *
                   std::sin(dlon/2) * std::sin(dlon/2);
        double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1-a));
        return R * c;
    }

    // Extract string value from JSON
    std::string extract_string(const std::string& json, const std::string& key) {
        std::string search = "\"" + key + "\"";
        size_t pos = json.find(search);
        if (pos == std::string::npos) return "";

        pos = json.find(':', pos);
        if (pos == std::string::npos) return "";

        size_t start = json.find('"', pos + 1);
        if (start == std::string::npos) return "";

        size_t end = json.find('"', start + 1);
        if (end == std::string::npos) return "";

        return json.substr(start + 1, end - start - 1);
    }

    // Extract number value from JSON
    double extract_number(const std::string& json, const std::string& key) {
        std::string search = "\"" + key + "\"";
        size_t pos = json.find(search);
        if (pos == std::string::npos) return 0.0;

        pos = json.find(':', pos);
        if (pos == std::string::npos) return 0.0;

        // Skip whitespace
        pos++;
        while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;

        // Find end of number
        size_t end = pos;
        while (end < json.size() &&
               (std::isdigit(json[end]) || json[end] == '.' ||
                json[end] == '-' || json[end] == '+' || json[end] == 'e' || json[end] == 'E')) {
            end++;
        }

        if (end == pos) return 0.0;
        return std::stod(json.substr(pos, end - pos));
    }

    int extract_int(const std::string& json, const std::string& key) {
        return static_cast<int>(extract_number(json, key));
    }
}

bool WorldCities::load(const std::string& filename) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        return false;
    }

    // Read entire file
    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string content = buffer.str();
    file.close();

    cities_.clear();
    id_index_.clear();

    // Find the cities array
    size_t cities_start = content.find("\"cities\"");
    if (cities_start == std::string::npos) return false;

    cities_start = content.find('[', cities_start);
    if (cities_start == std::string::npos) return false;

    // Parse each city object
    size_t pos = cities_start;
    while (true) {
        size_t obj_start = content.find('{', pos);
        if (obj_start == std::string::npos) break;

        size_t obj_end = content.find('}', obj_start);
        if (obj_end == std::string::npos) break;

        std::string city_json = content.substr(obj_start, obj_end - obj_start + 1);

        City city;
        city.id = extract_int(city_json, "id");
        city.name = extract_string(city_json, "name");
        city.ascii_name = extract_string(city_json, "ascii_name");
        city.country = extract_string(city_json, "country");
        city.country_code = extract_string(city_json, "country_code");
        city.latitude = extract_number(city_json, "latitude");
        city.longitude = extract_number(city_json, "longitude");
        city.elevation_m = extract_number(city_json, "elevation_m");
        city.population = extract_int(city_json, "population");
        city.timezone = extract_string(city_json, "timezone");

        if (!city.name.empty()) {
            id_index_[city.id] = cities_.size();
            cities_.push_back(city);
        }

        pos = obj_end + 1;

        // Check for end of array
        size_t next_obj = content.find('{', pos);
        size_t array_end = content.find(']', pos);
        if (array_end != std::string::npos &&
            (next_obj == std::string::npos || array_end < next_obj)) {
            break;
        }
    }

    return !cities_.empty();
}

const City* WorldCities::get_by_id(int id) const {
    auto it = id_index_.find(id);
    if (it == id_index_.end()) return nullptr;
    return &cities_[it->second];
}

const City* WorldCities::find_by_name(const std::string& name) const {
    std::string lower_name = to_lower(name);
    for (const auto& city : cities_) {
        if (to_lower(city.name).find(lower_name) != std::string::npos ||
            to_lower(city.ascii_name).find(lower_name) != std::string::npos) {
            return &city;
        }
    }
    return nullptr;
}

std::vector<const City*> WorldCities::find_all_by_name(const std::string& name) const {
    std::vector<const City*> results;
    std::string lower_name = to_lower(name);
    for (const auto& city : cities_) {
        if (to_lower(city.name).find(lower_name) != std::string::npos ||
            to_lower(city.ascii_name).find(lower_name) != std::string::npos) {
            results.push_back(&city);
        }
    }
    return results;
}

std::vector<const City*> WorldCities::get_by_country(const std::string& country) const {
    std::vector<const City*> results;
    std::string lower_country = to_lower(country);
    for (const auto& city : cities_) {
        if (to_lower(city.country).find(lower_country) != std::string::npos) {
            results.push_back(&city);
        }
    }
    return results;
}

std::vector<const City*> WorldCities::get_by_min_population(int min_pop) const {
    std::vector<const City*> results;
    for (const auto& city : cities_) {
        if (city.population >= min_pop) {
            results.push_back(&city);
        }
    }
    return results;
}

std::vector<const City*> WorldCities::get_in_region(
    double min_lat, double max_lat,
    double min_lon, double max_lon) const {

    std::vector<const City*> results;
    for (const auto& city : cities_) {
        if (city.latitude >= min_lat && city.latitude <= max_lat &&
            city.longitude >= min_lon && city.longitude <= max_lon) {
            results.push_back(&city);
        }
    }
    return results;
}

std::vector<const City*> WorldCities::get_near_point(
    double lat, double lon, double radius_km) const {

    std::vector<std::pair<double, const City*>> results;
    for (const auto& city : cities_) {
        double dist = haversine_km(lat, lon, city.latitude, city.longitude);
        if (dist <= radius_km) {
            results.push_back({dist, &city});
        }
    }

    // Sort by distance
    std::sort(results.begin(), results.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });

    std::vector<const City*> sorted;
    for (const auto& pair : results) {
        sorted.push_back(pair.second);
    }
    return sorted;
}

std::vector<const City*> WorldCities::get_top_n(size_t n) const {
    std::vector<const City*> results;
    size_t count = std::min(n, cities_.size());
    for (size_t i = 0; i < count; i++) {
        results.push_back(&cities_[i]);
    }
    return results;
}

std::vector<std::string> WorldCities::get_countries() const {
    std::set<std::string> country_set;
    for (const auto& city : cities_) {
        country_set.insert(city.country);
    }
    return std::vector<std::string>(country_set.begin(), country_set.end());
}

double WorldCities::distance_km(const City& city1, const City& city2) {
    return haversine_km(city1.latitude, city1.longitude,
                        city2.latitude, city2.longitude);
}

double WorldCities::distance_km(double lat, double lon, const City& city) {
    return haversine_km(lat, lon, city.latitude, city.longitude);
}

} // namespace sim
