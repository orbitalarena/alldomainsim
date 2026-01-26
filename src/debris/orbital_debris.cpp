#include "orbital_debris.hpp"
#include <cmath>
#include <random>
#include <chrono>
#include <algorithm>

namespace sim {

OrbitalDebris::OrbitalDebris(int id, int source_id, const StateVector& state,
                             double mass, double size)
    : id(id)
    , source_id(source_id)
    , state(state)
    , mass(mass)
    , size(size)
    , active(true)
    , time(0.0)
    , cached_sma(0.0)
    , cached_ecc(0.0)
    , cached_inc(0.0)
    , elements_valid(false) {
}

namespace {
    // Gravitational acceleration with optional J2
    Vec3 compute_acceleration(const Vec3& pos, bool use_j2) {
        double r = pos.norm();
        double r2 = r * r;
        double r3 = r2 * r;

        Vec3 acc;

        // Two-body
        double coeff = -OrbitalDebris::MU / r3;
        acc.x = coeff * pos.x;
        acc.y = coeff * pos.y;
        acc.z = coeff * pos.z;

        // J2 perturbation
        if (use_j2) {
            double r5 = r2 * r3;
            double z2 = pos.z * pos.z;
            double re2 = OrbitalDebris::RE * OrbitalDebris::RE;

            double j2_coeff = 1.5 * OrbitalDebris::J2 * OrbitalDebris::MU * re2 / r5;
            double z_factor = 5.0 * z2 / r2;

            acc.x += j2_coeff * pos.x * (z_factor - 1.0);
            acc.y += j2_coeff * pos.y * (z_factor - 1.0);
            acc.z += j2_coeff * pos.z * (z_factor - 3.0);
        }

        return acc;
    }
}

void OrbitalDebris::propagate(double dt, bool use_j2) {
    if (!active) return;

    // RK4 integration
    Vec3 p0 = state.position;
    Vec3 v0 = state.velocity;

    // k1
    Vec3 a1 = compute_acceleration(p0, use_j2);
    Vec3 v1 = v0;

    // k2
    Vec3 p2, v2;
    p2.x = p0.x + 0.5 * dt * v1.x;
    p2.y = p0.y + 0.5 * dt * v1.y;
    p2.z = p0.z + 0.5 * dt * v1.z;
    v2.x = v0.x + 0.5 * dt * a1.x;
    v2.y = v0.y + 0.5 * dt * a1.y;
    v2.z = v0.z + 0.5 * dt * a1.z;
    Vec3 a2 = compute_acceleration(p2, use_j2);

    // k3
    Vec3 p3, v3;
    p3.x = p0.x + 0.5 * dt * v2.x;
    p3.y = p0.y + 0.5 * dt * v2.y;
    p3.z = p0.z + 0.5 * dt * v2.z;
    v3.x = v0.x + 0.5 * dt * a2.x;
    v3.y = v0.y + 0.5 * dt * a2.y;
    v3.z = v0.z + 0.5 * dt * a2.z;
    Vec3 a3 = compute_acceleration(p3, use_j2);

    // k4
    Vec3 p4, v4;
    p4.x = p0.x + dt * v3.x;
    p4.y = p0.y + dt * v3.y;
    p4.z = p0.z + dt * v3.z;
    v4.x = v0.x + dt * a3.x;
    v4.y = v0.y + dt * a3.y;
    v4.z = v0.z + dt * a3.z;
    Vec3 a4 = compute_acceleration(p4, use_j2);

    // Final update
    state.position.x = p0.x + (dt / 6.0) * (v1.x + 2.0*v2.x + 2.0*v3.x + v4.x);
    state.position.y = p0.y + (dt / 6.0) * (v1.y + 2.0*v2.y + 2.0*v3.y + v4.y);
    state.position.z = p0.z + (dt / 6.0) * (v1.z + 2.0*v2.z + 2.0*v3.z + v4.z);

    state.velocity.x = v0.x + (dt / 6.0) * (a1.x + 2.0*a2.x + 2.0*a3.x + a4.x);
    state.velocity.y = v0.y + (dt / 6.0) * (a1.y + 2.0*a2.y + 2.0*a3.y + a4.y);
    state.velocity.z = v0.z + (dt / 6.0) * (a1.z + 2.0*a2.z + 2.0*a3.z + a4.z);

    time += dt;
    elements_valid = false;

    // Check for reentry
    if (has_reentered()) {
        active = false;
    }
}

void OrbitalDebris::compute_orbital_elements() const {
    if (elements_valid) return;

    double r = state.position.norm();
    double v = state.velocity.norm();

    // Specific energy
    double energy = 0.5 * v * v - MU / r;

    // Semi-major axis
    cached_sma = -MU / (2.0 * energy);

    // Angular momentum
    Vec3 h;
    h.x = state.position.y * state.velocity.z - state.position.z * state.velocity.y;
    h.y = state.position.z * state.velocity.x - state.position.x * state.velocity.z;
    h.z = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
    double h_mag = h.norm();

    // Eccentricity vector
    Vec3 e_vec;
    double r_dot_v = state.position.x * state.velocity.x +
                     state.position.y * state.velocity.y +
                     state.position.z * state.velocity.z;

    e_vec.x = (v * v / MU - 1.0 / r) * state.position.x - (r_dot_v / MU) * state.velocity.x;
    e_vec.y = (v * v / MU - 1.0 / r) * state.position.y - (r_dot_v / MU) * state.velocity.y;
    e_vec.z = (v * v / MU - 1.0 / r) * state.position.z - (r_dot_v / MU) * state.velocity.z;

    cached_ecc = e_vec.norm();

    // Inclination
    cached_inc = std::acos(h.z / h_mag);

    elements_valid = true;
}

double OrbitalDebris::get_sma() const {
    compute_orbital_elements();
    return cached_sma;
}

double OrbitalDebris::get_eccentricity() const {
    compute_orbital_elements();
    return cached_ecc;
}

double OrbitalDebris::get_inclination_deg() const {
    compute_orbital_elements();
    return cached_inc * 180.0 / M_PI;
}

double OrbitalDebris::get_period() const {
    double a = get_sma();
    if (a <= 0) return 0.0;  // Hyperbolic
    return 2.0 * M_PI * std::sqrt(a * a * a / MU);
}

bool OrbitalDebris::has_reentered() const {
    compute_orbital_elements();
    double perigee = cached_sma * (1.0 - cached_ecc);
    return perigee < (RE + REENTRY_ALT);
}

std::vector<OrbitalDebris> create_collision_debris(
    const StateVector& sat1,
    const StateVector& sat2,
    int num_pieces,
    double collision_time,
    double mass_ratio,
    uint32_t random_seed) {

    std::vector<OrbitalDebris> debris;
    debris.reserve(num_pieces);

    // Setup random generator
    std::mt19937 rng;
    if (random_seed == 0) {
        rng.seed(static_cast<uint32_t>(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    } else {
        rng.seed(random_seed);
    }

    std::uniform_real_distribution<double> unit_dist(0.0, 1.0);
    std::uniform_real_distribution<double> scatter_dist(0.1, 0.5);

    // Collision point (midpoint)
    Vec3 collision_pos;
    collision_pos.x = (sat1.position.x + sat2.position.x) / 2.0;
    collision_pos.y = (sat1.position.y + sat2.position.y) / 2.0;
    collision_pos.z = (sat1.position.z + sat2.position.z) / 2.0;

    // Combined velocity (momentum-weighted center of mass velocity)
    double total_mass = 1.0 + mass_ratio;
    Vec3 combined_vel;
    combined_vel.x = (sat1.velocity.x + mass_ratio * sat2.velocity.x) / total_mass;
    combined_vel.y = (sat1.velocity.y + mass_ratio * sat2.velocity.y) / total_mass;
    combined_vel.z = (sat1.velocity.z + mass_ratio * sat2.velocity.z) / total_mass;

    // Relative velocity (determines scatter magnitude)
    Vec3 rel_vel;
    rel_vel.x = sat1.velocity.x - sat2.velocity.x;
    rel_vel.y = sat1.velocity.y - sat2.velocity.y;
    rel_vel.z = sat1.velocity.z - sat2.velocity.z;
    double rel_speed = rel_vel.norm();

    // Distribute debris between both satellites
    int from_sat1 = static_cast<int>(num_pieces / (1.0 + 1.0/mass_ratio));
    int from_sat2 = num_pieces - from_sat1;

    for (int i = 0; i < num_pieces; i++) {
        int source = (i < from_sat1) ? 1 : 2;

        // Random scatter direction (uniform on sphere)
        double theta = 2.0 * M_PI * unit_dist(rng);
        double phi = std::acos(2.0 * unit_dist(rng) - 1.0);

        double scatter_fraction = scatter_dist(rng);
        double scatter_speed = rel_speed * scatter_fraction;

        Vec3 scatter_dir;
        scatter_dir.x = std::sin(phi) * std::cos(theta);
        scatter_dir.y = std::sin(phi) * std::sin(theta);
        scatter_dir.z = std::cos(phi);

        StateVector debris_state;
        debris_state.position = collision_pos;
        debris_state.velocity.x = combined_vel.x + scatter_speed * scatter_dir.x;
        debris_state.velocity.y = combined_vel.y + scatter_speed * scatter_dir.y;
        debris_state.velocity.z = combined_vel.z + scatter_speed * scatter_dir.z;

        // Random mass and size
        double mass = 0.01 + 9.99 * unit_dist(rng);  // 0.01 to 10 kg
        double size = 0.01 + 0.49 * unit_dist(rng);  // 0.01 to 0.5 m

        OrbitalDebris d(i, source, debris_state, mass, size);
        d.time = collision_time;
        debris.push_back(d);
    }

    return debris;
}

std::vector<OrbitalDebris> create_explosion_debris(
    const StateVector& satellite,
    int num_pieces,
    double explosion_dv,
    double explosion_time,
    uint32_t random_seed) {

    std::vector<OrbitalDebris> debris;
    debris.reserve(num_pieces);

    std::mt19937 rng;
    if (random_seed == 0) {
        rng.seed(static_cast<uint32_t>(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    } else {
        rng.seed(random_seed);
    }

    std::uniform_real_distribution<double> unit_dist(0.0, 1.0);
    std::uniform_real_distribution<double> dv_dist(0.0, explosion_dv);

    for (int i = 0; i < num_pieces; i++) {
        // Random direction (uniform on sphere)
        double theta = 2.0 * M_PI * unit_dist(rng);
        double phi = std::acos(2.0 * unit_dist(rng) - 1.0);

        double dv = dv_dist(rng);

        Vec3 dv_dir;
        dv_dir.x = std::sin(phi) * std::cos(theta);
        dv_dir.y = std::sin(phi) * std::sin(theta);
        dv_dir.z = std::cos(phi);

        StateVector debris_state;
        debris_state.position = satellite.position;
        debris_state.velocity.x = satellite.velocity.x + dv * dv_dir.x;
        debris_state.velocity.y = satellite.velocity.y + dv * dv_dir.y;
        debris_state.velocity.z = satellite.velocity.z + dv * dv_dir.z;

        double mass = 0.01 + 4.99 * unit_dist(rng);
        double size = 0.01 + 0.29 * unit_dist(rng);

        OrbitalDebris d(i, 0, debris_state, mass, size);
        d.time = explosion_time;
        debris.push_back(d);
    }

    return debris;
}

std::vector<OrbitalDebrisTrajectory> propagate_debris_field(
    std::vector<OrbitalDebris>& debris,
    double duration,
    double dt,
    bool use_j2,
    double record_interval) {

    std::vector<OrbitalDebrisTrajectory> trajectories;

    bool recording = (record_interval > 0.0);
    if (recording) {
        trajectories.resize(debris.size());
        for (size_t i = 0; i < debris.size(); i++) {
            trajectories[i].debris_id = debris[i].id;
        }
    }

    double elapsed = 0.0;
    double next_record = 0.0;

    while (elapsed < duration) {
        // Record if needed
        if (recording && elapsed >= next_record) {
            for (size_t i = 0; i < debris.size(); i++) {
                if (debris[i].active) {
                    trajectories[i].times.push_back(elapsed);
                    trajectories[i].states.push_back(debris[i].state);
                }
            }
            next_record += record_interval;
        }

        // Propagate all active debris
        for (auto& d : debris) {
            d.propagate(dt, use_j2);
        }

        elapsed += dt;
    }

    return trajectories;
}

DebrisFieldStats compute_debris_stats(const std::vector<OrbitalDebris>& debris) {
    DebrisFieldStats stats;
    stats.total_count = static_cast<int>(debris.size());
    stats.active_count = 0;
    stats.reentered_count = 0;
    stats.min_sma_km = 1e12;
    stats.max_sma_km = 0.0;
    stats.mean_sma_km = 0.0;
    stats.min_perigee_km = 1e12;
    stats.max_apogee_km = 0.0;

    double sum_sma = 0.0;
    int count = 0;

    for (const auto& d : debris) {
        if (d.active) {
            stats.active_count++;
            double sma = d.get_sma() / 1000.0;  // Convert to km
            double ecc = d.get_eccentricity();
            double perigee = sma * (1.0 - ecc);
            double apogee = sma * (1.0 + ecc);

            if (sma > 0) {  // Skip hyperbolic orbits
                stats.min_sma_km = std::min(stats.min_sma_km, sma);
                stats.max_sma_km = std::max(stats.max_sma_km, sma);
                stats.min_perigee_km = std::min(stats.min_perigee_km, perigee);
                stats.max_apogee_km = std::max(stats.max_apogee_km, apogee);
                sum_sma += sma;
                count++;
            }
        } else {
            stats.reentered_count++;
        }
    }

    if (count > 0) {
        stats.mean_sma_km = sum_sma / count;
    }

    stats.spread_km = stats.max_sma_km - stats.min_sma_km;

    return stats;
}

} // namespace sim
