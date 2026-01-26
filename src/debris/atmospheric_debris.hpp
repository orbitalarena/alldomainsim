#ifndef ATMOSPHERIC_DEBRIS_HPP
#define ATMOSPHERIC_DEBRIS_HPP

#include <vector>
#include <cstdint>

namespace sim {

/**
 * Atmospheric Debris Model
 *
 * Models debris falling through Earth's atmosphere with drag.
 * Used for aircraft destruction, missile intercepts, rocket breakups, etc.
 *
 * Physics:
 * - Ballistic trajectory with gravity
 * - Atmospheric drag: F_drag = 0.5 * rho * v^2 * Cd * A
 * - Exponential atmosphere model: rho = rho_0 * exp(-h/H)
 */

struct AtmosphericDebris {
    int id;
    int source_id;           // ID of the object that created this debris
    int team_id;             // Team/side identifier (optional)

    // Position (geodetic)
    double latitude;         // degrees
    double longitude;        // degrees
    double altitude;         // meters above sea level

    // Velocity (ENU - East, North, Up)
    double vel_east;         // m/s
    double vel_north;        // m/s
    double vel_up;           // m/s

    // Physical properties
    double mass;             // kg
    double drag_area;        // m^2 (cross-sectional area)
    double drag_coeff;       // dimensionless (typically 0.5-2.0)

    // State
    bool is_falling;
    double time_since_creation;  // seconds

    /**
     * Constructor
     */
    AtmosphericDebris(int id, int source_id, int team_id,
                      double lat, double lon, double alt,
                      double vel_e, double vel_n, double vel_u,
                      double mass, double drag_area, double drag_coeff = 1.0);

    /**
     * Update debris state for one timestep
     * @param dt Timestep in seconds
     */
    void update(double dt);

    /**
     * Check if debris has landed
     */
    bool has_landed() const { return !is_falling; }

    /**
     * Get current speed magnitude
     */
    double get_speed() const;

    // Physical constants
    static constexpr double GRAVITY = 9.81;           // m/s^2
    static constexpr double RHO_SEA_LEVEL = 1.225;    // kg/m^3
    static constexpr double SCALE_HEIGHT = 8500.0;    // m
    static constexpr double EARTH_RADIUS = 6371000.0; // m
};

/**
 * Create a debris field from an explosion event
 *
 * @param source_id ID of the destroyed object
 * @param team_id Team identifier
 * @param lat Latitude of explosion (degrees)
 * @param lon Longitude of explosion (degrees)
 * @param alt Altitude of explosion (meters)
 * @param heading Direction of travel at explosion (degrees, 0=North)
 * @param speed Speed at explosion (m/s)
 * @param num_pieces Number of debris pieces to create
 * @param min_mass Minimum debris mass (kg)
 * @param max_mass Maximum debris mass (kg)
 * @param random_seed Seed for reproducible randomness (0 = use time)
 * @return Vector of debris pieces
 */
std::vector<AtmosphericDebris> create_atmospheric_debris_field(
    int source_id,
    int team_id,
    double lat, double lon, double alt,
    double heading, double speed,
    int num_pieces = 12,
    double min_mass = 1.0,
    double max_mass = 50.0,
    uint32_t random_seed = 0);

/**
 * Simulate debris field until all pieces land
 *
 * @param debris Vector of debris pieces (modified in place)
 * @param dt Timestep for simulation
 * @param max_time Maximum simulation time (seconds)
 * @param record_interval Interval for recording trajectory points (0 = no recording)
 * @return True if all debris landed within max_time
 */
bool simulate_debris_until_landing(
    std::vector<AtmosphericDebris>& debris,
    double dt = 0.1,
    double max_time = 600.0,
    double record_interval = 0.0);

} // namespace sim

#endif // ATMOSPHERIC_DEBRIS_HPP
