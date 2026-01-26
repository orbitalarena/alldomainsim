#ifndef ORBITAL_DEBRIS_HPP
#define ORBITAL_DEBRIS_HPP

#include "core/state_vector.hpp"
#include <vector>
#include <cstdint>

namespace sim {

/**
 * Orbital Debris Model
 *
 * Models debris in orbit using two-body dynamics with optional J2 perturbation.
 * Used for satellite collisions, ASAT events, upper stage explosions, etc.
 *
 * Physics:
 * - Two-body gravitational acceleration
 * - Optional J2 oblateness perturbation
 * - RK4 numerical integration
 */

struct OrbitalDebris {
    int id;
    int source_id;           // ID of the satellite that created this debris
    StateVector state;       // Current ECI state (position in m, velocity in m/s)
    double mass;             // kg (for future collision modeling)
    double size;             // characteristic dimension in meters

    bool active;             // Still being tracked
    double time;             // Current simulation time (seconds from epoch)

    // Orbital elements (computed on demand)
    mutable double cached_sma;        // Semi-major axis (m)
    mutable double cached_ecc;        // Eccentricity
    mutable double cached_inc;        // Inclination (rad)
    mutable bool elements_valid;

    /**
     * Constructor
     */
    OrbitalDebris(int id, int source_id, const StateVector& state,
                  double mass = 1.0, double size = 0.1);

    /**
     * Propagate debris state using RK4
     * @param dt Timestep in seconds
     * @param use_j2 Include J2 perturbation
     */
    void propagate(double dt, bool use_j2 = true);

    /**
     * Compute orbital elements from current state
     */
    void compute_orbital_elements() const;

    /**
     * Get semi-major axis (computes if needed)
     */
    double get_sma() const;

    /**
     * Get eccentricity (computes if needed)
     */
    double get_eccentricity() const;

    /**
     * Get inclination in degrees (computes if needed)
     */
    double get_inclination_deg() const;

    /**
     * Get orbital period in seconds
     */
    double get_period() const;

    /**
     * Check if debris has re-entered (perigee below atmosphere)
     */
    bool has_reentered() const;

    // Physical constants
    static constexpr double MU = 3.986004418e14;      // Earth GM (m^3/s^2)
    static constexpr double J2 = 1.08263e-3;          // J2 coefficient
    static constexpr double RE = 6378137.0;          // Earth equatorial radius (m)
    static constexpr double REENTRY_ALT = 120000.0;  // Reentry altitude (m)
};

/**
 * Trajectory record for visualization
 */
struct OrbitalDebrisTrajectory {
    int debris_id;
    std::vector<double> times;        // seconds from start
    std::vector<StateVector> states;  // ECI states
};

/**
 * Create orbital debris field from collision
 *
 * @param sat1 First satellite state at collision
 * @param sat2 Second satellite state at collision
 * @param num_pieces Total number of debris pieces
 * @param collision_time Time of collision (seconds from epoch)
 * @param mass_ratio Mass ratio of sat1 to sat2 (affects debris distribution)
 * @param random_seed Seed for reproducible randomness (0 = use time)
 * @return Vector of debris pieces
 */
std::vector<OrbitalDebris> create_collision_debris(
    const StateVector& sat1,
    const StateVector& sat2,
    int num_pieces = 1000,
    double collision_time = 0.0,
    double mass_ratio = 1.0,
    uint32_t random_seed = 0);

/**
 * Create orbital debris field from explosion (single object breakup)
 *
 * @param satellite Satellite state at explosion
 * @param num_pieces Number of debris pieces
 * @param explosion_dv Characteristic delta-V of explosion (m/s)
 * @param explosion_time Time of explosion (seconds from epoch)
 * @param random_seed Seed for reproducibility
 * @return Vector of debris pieces
 */
std::vector<OrbitalDebris> create_explosion_debris(
    const StateVector& satellite,
    int num_pieces = 500,
    double explosion_dv = 100.0,
    double explosion_time = 0.0,
    uint32_t random_seed = 0);

/**
 * Propagate entire debris field
 *
 * @param debris Vector of debris (modified in place)
 * @param duration Total propagation time (seconds)
 * @param dt Timestep (seconds)
 * @param use_j2 Include J2 perturbation
 * @param record_interval Interval for recording trajectories (0 = no recording)
 * @return Vector of trajectories (empty if record_interval = 0)
 */
std::vector<OrbitalDebrisTrajectory> propagate_debris_field(
    std::vector<OrbitalDebris>& debris,
    double duration,
    double dt = 10.0,
    bool use_j2 = true,
    double record_interval = 0.0);

/**
 * Get debris field statistics
 */
struct DebrisFieldStats {
    int total_count;
    int active_count;
    int reentered_count;
    double min_sma_km;
    double max_sma_km;
    double mean_sma_km;
    double min_perigee_km;
    double max_apogee_km;
    double spread_km;  // max_sma - min_sma
};

DebrisFieldStats compute_debris_stats(const std::vector<OrbitalDebris>& debris);

} // namespace sim

#endif // ORBITAL_DEBRIS_HPP
