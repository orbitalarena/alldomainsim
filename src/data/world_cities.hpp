#ifndef WORLD_CITIES_HPP
#define WORLD_CITIES_HPP

#include <string>
#include <vector>
#include <unordered_map>

namespace sim {

/**
 * City data structure
 * Contains geographic and demographic information for world cities.
 */
struct City {
    int id;
    std::string name;
    std::string ascii_name;
    std::string country;
    std::string country_code;
    double latitude;       // degrees
    double longitude;      // degrees
    double elevation_m;    // meters above sea level
    int population;
    std::string timezone;
};

/**
 * World Cities Database
 *
 * Provides access to the top 1000 cities by population.
 * Data includes coordinates, elevation, population, and country info.
 *
 * Usage:
 *   WorldCities cities;
 *   cities.load("data/world_cities_1000.json");
 *
 *   // Get all cities
 *   for (const auto& city : cities.get_all()) { ... }
 *
 *   // Filter by population
 *   auto large = cities.get_by_min_population(5000000);
 *
 *   // Find by name
 *   auto tokyo = cities.find_by_name("Tokyo");
 */
class WorldCities {
public:
    WorldCities() = default;

    /**
     * Load cities from JSON file
     * @param filename Path to world_cities_1000.json
     * @return True if loaded successfully
     */
    bool load(const std::string& filename);

    /**
     * Get all loaded cities
     */
    const std::vector<City>& get_all() const { return cities_; }

    /**
     * Get number of cities
     */
    size_t size() const { return cities_.size(); }

    /**
     * Get city by ID
     * @param id City ID (0-999)
     * @return Pointer to city or nullptr if not found
     */
    const City* get_by_id(int id) const;

    /**
     * Find city by name (case-insensitive partial match)
     * @param name City name to search
     * @return Pointer to first matching city or nullptr
     */
    const City* find_by_name(const std::string& name) const;

    /**
     * Find all cities by name (case-insensitive partial match)
     * @param name City name to search
     * @return Vector of matching cities
     */
    std::vector<const City*> find_all_by_name(const std::string& name) const;

    /**
     * Get cities by country
     * @param country Country name
     * @return Vector of cities in that country
     */
    std::vector<const City*> get_by_country(const std::string& country) const;

    /**
     * Get cities with population >= threshold
     * @param min_pop Minimum population
     * @return Vector of qualifying cities
     */
    std::vector<const City*> get_by_min_population(int min_pop) const;

    /**
     * Get cities within a bounding box
     * @param min_lat Minimum latitude
     * @param max_lat Maximum latitude
     * @param min_lon Minimum longitude
     * @param max_lon Maximum longitude
     * @return Vector of cities in the region
     */
    std::vector<const City*> get_in_region(
        double min_lat, double max_lat,
        double min_lon, double max_lon) const;

    /**
     * Get cities within radius of a point
     * @param lat Center latitude
     * @param lon Center longitude
     * @param radius_km Radius in kilometers
     * @return Vector of cities within radius, sorted by distance
     */
    std::vector<const City*> get_near_point(
        double lat, double lon, double radius_km) const;

    /**
     * Get the N largest cities by population
     * @param n Number of cities to return
     * @return Vector of top N cities
     */
    std::vector<const City*> get_top_n(size_t n) const;

    /**
     * Get list of unique countries
     */
    std::vector<std::string> get_countries() const;

    /**
     * Compute distance between two cities
     * @param city1 First city
     * @param city2 Second city
     * @return Distance in kilometers
     */
    static double distance_km(const City& city1, const City& city2);

    /**
     * Compute distance from a point to a city
     * @param lat Latitude
     * @param lon Longitude
     * @param city Target city
     * @return Distance in kilometers
     */
    static double distance_km(double lat, double lon, const City& city);

private:
    std::vector<City> cities_;
    std::unordered_map<int, size_t> id_index_;  // id -> vector index
};

} // namespace sim

#endif // WORLD_CITIES_HPP
