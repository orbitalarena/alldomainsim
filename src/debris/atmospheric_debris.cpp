#include "atmospheric_debris.hpp"
#include <cmath>
#include <random>
#include <chrono>

namespace sim {

AtmosphericDebris::AtmosphericDebris(int id, int source_id, int team_id,
                                     double lat, double lon, double alt,
                                     double vel_e, double vel_n, double vel_u,
                                     double mass, double drag_area, double drag_coeff)
    : id(id)
    , source_id(source_id)
    , team_id(team_id)
    , latitude(lat)
    , longitude(lon)
    , altitude(alt)
    , vel_east(vel_e)
    , vel_north(vel_n)
    , vel_up(vel_u)
    , mass(mass)
    , drag_area(drag_area)
    , drag_coeff(drag_coeff)
    , is_falling(true)
    , time_since_creation(0.0) {
}

void AtmosphericDebris::update(double dt) {
    if (!is_falling) return;

    time_since_creation += dt;

    // Atmospheric density (exponential model)
    double rho = RHO_SEA_LEVEL * std::exp(-altitude / SCALE_HEIGHT);

    // Current speed
    double speed = get_speed();

    // Apply drag
    if (speed > 0.1 && mass > 0.0) {
        double drag_force = 0.5 * rho * speed * speed * drag_coeff * drag_area;
        double drag_accel = drag_force / mass;

        // Drag opposes velocity
        vel_east -= (vel_east / speed) * drag_accel * dt;
        vel_north -= (vel_north / speed) * drag_accel * dt;
        vel_up -= (vel_up / speed) * drag_accel * dt;
    }

    // Apply gravity
    vel_up -= GRAVITY * dt;

    // Update position
    // Approximate conversion for small movements
    double meters_per_deg_lat = 111132.0;  // At equator, varies with latitude
    double meters_per_deg_lon = 111132.0 * std::cos(latitude * M_PI / 180.0);

    if (meters_per_deg_lon > 1.0) {
        longitude += (vel_east * dt) / meters_per_deg_lon;
    }
    latitude += (vel_north * dt) / meters_per_deg_lat;
    altitude += vel_up * dt;

    // Check for ground impact
    if (altitude <= 0.0) {
        altitude = 0.0;
        is_falling = false;
        vel_east = 0.0;
        vel_north = 0.0;
        vel_up = 0.0;
    }
}

double AtmosphericDebris::get_speed() const {
    return std::sqrt(vel_east * vel_east + vel_north * vel_north + vel_up * vel_up);
}

std::vector<AtmosphericDebris> create_atmospheric_debris_field(
    int source_id,
    int team_id,
    double lat, double lon, double alt,
    double heading, double speed,
    int num_pieces,
    double min_mass,
    double max_mass,
    uint32_t random_seed) {

    std::vector<AtmosphericDebris> debris;
    debris.reserve(num_pieces);

    // Setup random generator
    std::mt19937 rng;
    if (random_seed == 0) {
        rng.seed(static_cast<uint32_t>(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    } else {
        rng.seed(random_seed);
    }

    std::uniform_real_distribution<double> mass_dist(min_mass, max_mass);
    std::uniform_real_distribution<double> angle_dist(0.0, 2.0 * M_PI);
    std::uniform_real_distribution<double> scatter_dist(0.3, 1.0);  // Scatter factor
    std::uniform_real_distribution<double> area_factor_dist(0.01, 0.05);  // m^2 per kg

    // Convert heading to radians (0 = North, clockwise)
    double heading_rad = heading * M_PI / 180.0;

    // Base velocity in ENU
    double base_vel_east = speed * std::sin(heading_rad);
    double base_vel_north = speed * std::cos(heading_rad);
    double base_vel_up = 0.0;  // Assume level flight at explosion

    for (int i = 0; i < num_pieces; i++) {
        double piece_mass = mass_dist(rng);
        double piece_area = piece_mass * area_factor_dist(rng);

        // Scatter velocity
        double scatter_speed = speed * scatter_dist(rng);
        double scatter_azimuth = angle_dist(rng);
        double scatter_elevation = angle_dist(rng) * 0.5 - M_PI / 4;  // -45 to +45 deg

        double scatter_horiz = scatter_speed * std::cos(scatter_elevation);
        double scatter_east = scatter_horiz * std::sin(scatter_azimuth);
        double scatter_north = scatter_horiz * std::cos(scatter_azimuth);
        double scatter_up = scatter_speed * std::sin(scatter_elevation);

        // Combine base velocity with scatter
        double vel_e = base_vel_east * 0.5 + scatter_east;
        double vel_n = base_vel_north * 0.5 + scatter_north;
        double vel_u = base_vel_up + scatter_up;

        debris.emplace_back(
            i,              // id
            source_id,      // source_id
            team_id,        // team_id
            lat, lon, alt,  // position
            vel_e, vel_n, vel_u,  // velocity
            piece_mass,     // mass
            piece_area,     // drag_area
            1.2             // drag_coeff (tumbling debris)
        );
    }

    return debris;
}

bool simulate_debris_until_landing(
    std::vector<AtmosphericDebris>& debris,
    double dt,
    double max_time,
    double record_interval) {

    double elapsed = 0.0;

    while (elapsed < max_time) {
        bool any_falling = false;

        for (auto& d : debris) {
            if (d.is_falling) {
                d.update(dt);
                any_falling = true;
            }
        }

        if (!any_falling) {
            return true;  // All debris has landed
        }

        elapsed += dt;
    }

    return false;  // Timeout
}

} // namespace sim
