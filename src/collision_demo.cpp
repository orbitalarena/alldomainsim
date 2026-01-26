#include <iostream>
#include <fstream>
#include <cmath>
#include <vector>
#include <iomanip>
#include <cstdlib>
#include <ctime>

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/gravity_model.hpp"
#include "propagators/rk4_integrator.hpp"

using namespace sim;

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;
constexpr double GEO_RADIUS = 42164.0e3;  // m from Earth center

// Orbital debris piece
struct OrbitalDebris {
    int id;
    int source_sat;  // 0 = chase, 1 = target
    StateVector state;
    std::vector<StateVector> trajectory;
    bool active = true;
};

// RIC frame for targeting
struct RICFrame {
    Vec3 R, I, C;
};

RICFrame compute_ric_frame(const StateVector& state) {
    RICFrame ric;
    double r_mag = state.position.norm();
    ric.R.x = state.position.x / r_mag;
    ric.R.y = state.position.y / r_mag;
    ric.R.z = state.position.z / r_mag;

    Vec3 h;
    h.x = state.position.y * state.velocity.z - state.position.z * state.velocity.y;
    h.y = state.position.z * state.velocity.x - state.position.x * state.velocity.z;
    h.z = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
    double h_mag = h.norm();
    ric.C.x = h.x / h_mag;
    ric.C.y = h.y / h_mag;
    ric.C.z = h.z / h_mag;

    ric.I.x = ric.C.y * ric.R.z - ric.C.z * ric.R.y;
    ric.I.y = ric.C.z * ric.R.x - ric.C.x * ric.R.z;
    ric.I.z = ric.C.x * ric.R.y - ric.C.y * ric.R.x;

    return ric;
}

Vec3 compute_ric_position(const StateVector& chase, const StateVector& target) {
    Vec3 rel_eci;
    rel_eci.x = chase.position.x - target.position.x;
    rel_eci.y = chase.position.y - target.position.y;
    rel_eci.z = chase.position.z - target.position.z;

    RICFrame ric = compute_ric_frame(target);
    Vec3 rel_ric;
    rel_ric.x = rel_eci.x * ric.R.x + rel_eci.y * ric.R.y + rel_eci.z * ric.R.z;
    rel_ric.y = rel_eci.x * ric.I.x + rel_eci.y * ric.I.y + rel_eci.z * ric.I.z;
    rel_ric.z = rel_eci.x * ric.C.x + rel_eci.y * ric.C.y + rel_eci.z * ric.C.z;
    return rel_ric;
}

Vec3 ric_to_eci_velocity(const Vec3& dv_ric, const StateVector& target) {
    RICFrame ric = compute_ric_frame(target);
    Vec3 dv_eci;
    dv_eci.x = dv_ric.x * ric.R.x + dv_ric.y * ric.I.x + dv_ric.z * ric.C.x;
    dv_eci.y = dv_ric.x * ric.R.y + dv_ric.y * ric.I.y + dv_ric.z * ric.C.y;
    dv_eci.z = dv_ric.x * ric.R.z + dv_ric.y * ric.I.z + dv_ric.z * ric.C.z;
    return dv_eci;
}

// Generate random number between -1 and 1
double random_symmetric() {
    return (std::rand() / (double)RAND_MAX) * 2.0 - 1.0;
}

// Create debris field from collision
// Momentum conservation: debris velocity = weighted combination of both satellite velocities + explosion scatter
std::vector<OrbitalDebris> create_orbital_debris(
    const StateVector& sat1, const StateVector& sat2,
    int num_pieces, double collision_time) {

    std::vector<OrbitalDebris> debris;

    // Combined momentum at collision point
    // Assuming equal mass satellites, combined velocity = (v1 + v2) / 2
    // But for debris, each piece inherits some portion of combined momentum plus scatter
    Vec3 combined_vel;
    combined_vel.x = (sat1.velocity.x + sat2.velocity.x) / 2.0;
    combined_vel.y = (sat1.velocity.y + sat2.velocity.y) / 2.0;
    combined_vel.z = (sat1.velocity.z + sat2.velocity.z) / 2.0;

    // Collision point (midpoint)
    Vec3 collision_pos;
    collision_pos.x = (sat1.position.x + sat2.position.x) / 2.0;
    collision_pos.y = (sat1.position.y + sat2.position.y) / 2.0;
    collision_pos.z = (sat1.position.z + sat2.position.z) / 2.0;

    // Relative velocity magnitude (energy available for scatter)
    Vec3 rel_vel;
    rel_vel.x = sat1.velocity.x - sat2.velocity.x;
    rel_vel.y = sat1.velocity.y - sat2.velocity.y;
    rel_vel.z = sat1.velocity.z - sat2.velocity.z;
    double rel_speed = rel_vel.norm();

    std::cout << "Collision parameters:" << std::endl;
    std::cout << "  Combined velocity magnitude: " << combined_vel.norm() << " m/s" << std::endl;
    std::cout << "  Relative velocity: " << rel_speed << " m/s" << std::endl;
    std::cout << "  Creating " << num_pieces << " debris pieces" << std::endl;

    for (int i = 0; i < num_pieces; i++) {
        OrbitalDebris d;
        d.id = i;
        d.source_sat = (i % 2);  // Alternate source attribution
        d.state.time = collision_time;

        // Position: small random offset from collision point (within 10m)
        d.state.position.x = collision_pos.x + random_symmetric() * 10.0;
        d.state.position.y = collision_pos.y + random_symmetric() * 10.0;
        d.state.position.z = collision_pos.z + random_symmetric() * 10.0;

        // Velocity: combined momentum + random scatter
        // Scatter velocity is fraction of relative velocity, distributed randomly
        // Larger pieces get less scatter, smaller pieces get more
        double scatter_fraction = 0.1 + 0.4 * (std::rand() / (double)RAND_MAX);  // 10-50% of rel_vel
        double scatter_speed = rel_speed * scatter_fraction;

        // Random direction for scatter (uniform on sphere)
        double theta = 2.0 * PI * (std::rand() / (double)RAND_MAX);
        double phi = std::acos(2.0 * (std::rand() / (double)RAND_MAX) - 1.0);
        Vec3 scatter_dir;
        scatter_dir.x = std::sin(phi) * std::cos(theta);
        scatter_dir.y = std::sin(phi) * std::sin(theta);
        scatter_dir.z = std::cos(phi);

        d.state.velocity.x = combined_vel.x + scatter_speed * scatter_dir.x;
        d.state.velocity.y = combined_vel.y + scatter_speed * scatter_dir.y;
        d.state.velocity.z = combined_vel.z + scatter_speed * scatter_dir.z;

        d.trajectory.push_back(d.state);
        debris.push_back(d);
    }

    return debris;
}

int main() {
    std::srand(static_cast<unsigned>(std::time(nullptr)));

    std::cout << "=== GEO Collision Simulation ===" << std::endl;
    std::cout << "Two satellites 1 degree apart, intercepting and colliding" << std::endl;
    std::cout << "Creating 1000 debris pieces with orbital physics" << std::endl;

    double mu = GravityModel::EARTH_MU;
    double n_geo = std::sqrt(mu / std::pow(GEO_RADIUS, 3));
    double v_geo = std::sqrt(mu / GEO_RADIUS);
    double geo_period = 2.0 * PI / n_geo;

    std::cout << "\nGEO parameters:" << std::endl;
    std::cout << "  Radius: " << GEO_RADIUS / 1e3 << " km" << std::endl;
    std::cout << "  Period: " << geo_period / 3600.0 << " hours" << std::endl;
    std::cout << "  Orbital velocity: " << v_geo << " m/s" << std::endl;

    // Set up satellites - 1 degree apart in GEO
    OrbitalElements chase_elements, target_elements;

    chase_elements.semi_major_axis = GEO_RADIUS;
    chase_elements.eccentricity = 0.0;
    chase_elements.inclination = 0.0;
    chase_elements.raan = 0.0;
    chase_elements.arg_periapsis = 0.0;
    chase_elements.true_anomaly = 0.0;

    double separation_deg = 1.0;
    target_elements.semi_major_axis = GEO_RADIUS;
    target_elements.eccentricity = 0.0;
    target_elements.inclination = 0.0;
    target_elements.raan = 0.0;
    target_elements.arg_periapsis = 0.0;
    target_elements.true_anomaly = separation_deg * DEG_TO_RAD;

    StateVector chase = OrbitalMechanics::elements_to_state(chase_elements, mu);
    chase.time = 0.0;
    StateVector target = OrbitalMechanics::elements_to_state(target_elements, mu);
    target.time = 0.0;

    // Initial relative state
    Vec3 r0_ric = compute_ric_position(chase, target);
    double init_range = r0_ric.norm();

    std::cout << "\nInitial conditions:" << std::endl;
    std::cout << "  Separation: " << separation_deg << " degrees" << std::endl;
    std::cout << "  Range: " << init_range / 1e3 << " km" << std::endl;
    std::cout << "  In-track separation: " << r0_ric.y / 1e3 << " km" << std::endl;

    // Gravity derivative function for RK4
    auto deriv_func = [](const StateVector& s) {
        return GravityModel::compute_derivatives(s, false);
    };

    // Newton-Raphson iterative targeting for precise intercept
    std::cout << "\n=== Newton-Raphson Targeting ===" << std::endl;

    double transfer_time = 12.0 * 3600.0;  // 12 hour transfer
    Vec3 dv_ric = {0, 0, 0};

    // Initial guess using simple formula
    dv_ric.x = r0_ric.y * n_geo / 4.0;
    dv_ric.y = 0.0;

    double best_range = 1e12;
    Vec3 best_dv = dv_ric;

    for (int iter = 0; iter < 20; iter++) {
        // Test this delta-V
        StateVector test_chase = OrbitalMechanics::elements_to_state(chase_elements, mu);
        test_chase.time = 0.0;
        StateVector test_target = OrbitalMechanics::elements_to_state(target_elements, mu);
        test_target.time = 0.0;

        Vec3 dv_eci = ric_to_eci_velocity(dv_ric, test_target);
        test_chase.velocity.x += dv_eci.x;
        test_chase.velocity.y += dv_eci.y;
        test_chase.velocity.z += dv_eci.z;

        // Propagate to transfer time
        double test_dt = 60.0;
        for (double t = test_dt; t <= transfer_time; t += test_dt) {
            test_chase = RK4Integrator::step(test_chase, test_dt, deriv_func);
            test_target = RK4Integrator::step(test_target, test_dt, deriv_func);
        }

        Vec3 final_ric = compute_ric_position(test_chase, test_target);
        double final_range = final_ric.norm();

        if (final_range < best_range) {
            best_range = final_range;
            best_dv = dv_ric;
        }

        std::cout << "Iter " << iter << ": dV_R=" << dv_ric.x << ", dV_I=" << dv_ric.y
                  << " -> Range=" << final_range/1e3 << " km" << std::endl;

        if (final_range < 100.0) {  // Good enough, we'll get closer with fine steps
            break;
        }

        // Newton-Raphson correction using numerical Jacobian
        double eps = 0.1;  // m/s perturbation

        // Perturb radial
        Vec3 dv_r_plus = dv_ric; dv_r_plus.x += eps;
        StateVector c_rp = OrbitalMechanics::elements_to_state(chase_elements, mu);
        StateVector t_rp = OrbitalMechanics::elements_to_state(target_elements, mu);
        Vec3 dv_rp = ric_to_eci_velocity(dv_r_plus, t_rp);
        c_rp.velocity.x += dv_rp.x; c_rp.velocity.y += dv_rp.y; c_rp.velocity.z += dv_rp.z;
        for (double t = test_dt; t <= transfer_time; t += test_dt) {
            c_rp = RK4Integrator::step(c_rp, test_dt, deriv_func);
            t_rp = RK4Integrator::step(t_rp, test_dt, deriv_func);
        }
        Vec3 ric_rp = compute_ric_position(c_rp, t_rp);

        // Perturb in-track
        Vec3 dv_i_plus = dv_ric; dv_i_plus.y += eps;
        StateVector c_ip = OrbitalMechanics::elements_to_state(chase_elements, mu);
        StateVector t_ip = OrbitalMechanics::elements_to_state(target_elements, mu);
        Vec3 dv_ip = ric_to_eci_velocity(dv_i_plus, t_ip);
        c_ip.velocity.x += dv_ip.x; c_ip.velocity.y += dv_ip.y; c_ip.velocity.z += dv_ip.z;
        for (double t = test_dt; t <= transfer_time; t += test_dt) {
            c_ip = RK4Integrator::step(c_ip, test_dt, deriv_func);
            t_ip = RK4Integrator::step(t_ip, test_dt, deriv_func);
        }
        Vec3 ric_ip = compute_ric_position(c_ip, t_ip);

        // Jacobian: d(R,I)/d(dv_R, dv_I)
        double dR_dvR = (ric_rp.x - final_ric.x) / eps;
        double dI_dvR = (ric_rp.y - final_ric.y) / eps;
        double dR_dvI = (ric_ip.x - final_ric.x) / eps;
        double dI_dvI = (ric_ip.y - final_ric.y) / eps;

        // Solve J * delta_dv = -[R, I]
        double det = dR_dvR * dI_dvI - dR_dvI * dI_dvR;
        if (std::abs(det) < 1e-12) break;

        double delta_dvR = (-dI_dvI * final_ric.x + dR_dvI * final_ric.y) / det;
        double delta_dvI = (dI_dvR * final_ric.x - dR_dvR * final_ric.y) / det;

        // Damped update
        double damping = 0.7;
        dv_ric.x += damping * delta_dvR;
        dv_ric.y += damping * delta_dvI;
    }

    dv_ric = best_dv;
    std::cout << "\nFinal targeting solution:" << std::endl;
    std::cout << "  Delta-V radial: " << dv_ric.x << " m/s" << std::endl;
    std::cout << "  Delta-V in-track: " << dv_ric.y << " m/s" << std::endl;
    std::cout << "  Expected min range: " << best_range/1e3 << " km" << std::endl;

    // Reset and apply the burn
    chase = OrbitalMechanics::elements_to_state(chase_elements, mu);
    chase.time = 0.0;
    target = OrbitalMechanics::elements_to_state(target_elements, mu);
    target.time = 0.0;

    Vec3 dv_eci = ric_to_eci_velocity(dv_ric, target);
    chase.velocity.x += dv_eci.x;
    chase.velocity.y += dv_eci.y;
    chase.velocity.z += dv_eci.z;

    // Simulation parameters
    double record_interval = 60.0;  // Record every minute
    double collision_threshold = 100.0;  // 100 meters (close proximity event)
    int num_debris = 1000;
    double post_collision_duration = 72.0 * 3600.0;  // 72 hours after collision

    std::vector<StateVector> chase_trajectory, target_trajectory;
    chase_trajectory.push_back(chase);
    target_trajectory.push_back(target);

    std::cout << "\n=== Simulating Approach ===" << std::endl;

    double collision_time = -1.0;
    StateVector chase_at_collision, target_at_collision;
    double last_record = 0.0;
    double prev_range = 1e12;
    bool passed_closest = false;

    // Phase 1: Simulate until collision (use adaptive time step)
    double t = 0.0;
    while (t < 24.0 * 3600.0) {
        Vec3 ric = compute_ric_position(chase, target);
        double range = ric.norm();

        // Adaptive time step: smaller when close
        double dt;
        if (range < 1000.0) dt = 0.1;       // 0.1s when <1km
        else if (range < 10000.0) dt = 1.0;  // 1s when <10km
        else if (range < 100000.0) dt = 10.0; // 10s when <100km
        else dt = 60.0;  // 60s otherwise

        chase = RK4Integrator::step(chase, dt, deriv_func);
        chase.time = t + dt;
        target = RK4Integrator::step(target, dt, deriv_func);
        target.time = t + dt;
        t += dt;

        ric = compute_ric_position(chase, target);
        range = ric.norm();

        // Detect if we're at closest approach (range started increasing)
        if (range > prev_range && prev_range < 1e6 && !passed_closest) {
            passed_closest = true;
            std::cout << "\nClosest approach: " << prev_range << " m at T+" << (t-dt)/3600.0 << "h" << std::endl;
        }

        if (t - last_record >= record_interval || range < 1000.0) {
            chase_trajectory.push_back(chase);
            target_trajectory.push_back(target);
            last_record = t;

            // Only print hourly updates plus close approach
            bool print = false;
            if (std::fmod(t, 3600.0) < record_interval + dt) print = true;
            if (range < 1000.0 && std::fmod(t, 60.0) < dt + 1) print = true;

            if (print) {
                std::cout << "T+" << t/3600.0 << "h: Range = " << range/1e3 << " km" << std::endl;
            }
        }

        // Check for collision
        if (range < collision_threshold) {
            collision_time = t;
            chase_at_collision = chase;
            target_at_collision = target;

            std::cout << "\n*** COLLISION DETECTED ***" << std::endl;
            std::cout << "  Time: T+" << collision_time/3600.0 << " hours" << std::endl;
            std::cout << "  Range: " << range << " meters" << std::endl;

            chase_trajectory.push_back(chase);
            target_trajectory.push_back(target);
            break;
        }

        prev_range = range;

        // If we passed closest approach and range is growing, we missed
        if (passed_closest && range > 100000.0) {
            break;
        }
    }

    if (collision_time < 0) {
        std::cerr << "No collision detected - satellites missed" << std::endl;
        return 1;
    }

    // Phase 2: Create debris
    std::cout << "\n=== Creating Debris Field ===" << std::endl;
    std::vector<OrbitalDebris> debris = create_orbital_debris(
        chase_at_collision, target_at_collision, num_debris, collision_time);

    // Phase 3: Propagate debris with orbital mechanics
    std::cout << "\n=== Propagating Debris (72 hours) ===" << std::endl;

    double debris_dt = 60.0;  // 1 minute steps for debris
    double debris_record_interval = 300.0;  // Record every 5 minutes

    for (double t = collision_time + debris_dt; t <= collision_time + post_collision_duration; t += debris_dt) {
        for (auto& d : debris) {
            if (!d.active) continue;

            d.state = RK4Integrator::step(d.state, debris_dt, deriv_func);
            d.state.time = t;

            // Check if debris re-entered (unlikely at GEO, but check anyway)
            double alt = d.state.position.norm() - 6371.0e3;
            if (alt < 100.0e3) {  // Below 100km
                d.active = false;
            }

            // Record at intervals
            if (std::fmod(t - collision_time, debris_record_interval) < debris_dt) {
                d.trajectory.push_back(d.state);
            }
        }

        // Progress update
        if (std::fmod(t - collision_time, 6.0 * 3600.0) < debris_dt) {
            int active_count = 0;
            for (const auto& d : debris) if (d.active) active_count++;
            std::cout << "T+" << (t - collision_time)/3600.0 << "h after collision: "
                      << active_count << " debris active" << std::endl;
        }
    }

    // Compute debris spread statistics
    std::cout << "\n=== Debris Spread Analysis ===" << std::endl;

    double min_sma = 1e12, max_sma = 0;
    double min_inc = 180, max_inc = 0;
    double min_ecc = 1.0, max_ecc = 0;

    for (const auto& d : debris) {
        if (!d.active || d.trajectory.empty()) continue;

        const StateVector& final_state = d.trajectory.back();
        OrbitalElements elem = OrbitalMechanics::state_to_elements(final_state, mu);

        min_sma = std::min(min_sma, elem.semi_major_axis);
        max_sma = std::max(max_sma, elem.semi_major_axis);
        min_ecc = std::min(min_ecc, elem.eccentricity);
        max_ecc = std::max(max_ecc, elem.eccentricity);
        min_inc = std::min(min_inc, elem.inclination * RAD_TO_DEG);
        max_inc = std::max(max_inc, elem.inclination * RAD_TO_DEG);
    }

    std::cout << "Semi-major axis: " << min_sma/1e3 << " - " << max_sma/1e3 << " km" << std::endl;
    std::cout << "Eccentricity: " << min_ecc << " - " << max_ecc << std::endl;
    std::cout << "Inclination: " << min_inc << " - " << max_inc << " deg" << std::endl;

    // Export to JSON
    std::cout << "\n=== Exporting Data ===" << std::endl;

    std::ofstream json("collision_data.json");
    json << std::fixed << std::setprecision(6);
    json << "{\n";
    json << "  \"metadata\": {\n";
    json << "    \"scenario\": \"GEO Satellite Collision\",\n";
    json << "    \"initial_separation_deg\": " << separation_deg << ",\n";
    json << "    \"collision_time_hours\": " << collision_time/3600.0 << ",\n";
    json << "    \"debris_count\": " << num_debris << ",\n";
    json << "    \"post_collision_hours\": " << post_collision_duration/3600.0 << ",\n";
    json << "    \"geo_radius_km\": " << GEO_RADIUS/1e3 << ",\n";
    json << "    \"min_sma_km\": " << min_sma/1e3 << ",\n";
    json << "    \"max_sma_km\": " << max_sma/1e3 << ",\n";
    json << "    \"min_ecc\": " << min_ecc << ",\n";
    json << "    \"max_ecc\": " << max_ecc << "\n";
    json << "  },\n";

    // Satellites (pre-collision)
    json << "  \"satellites\": [\n";
    json << "    {\"name\": \"Chase\", \"color\": \"#00FF00\", \"trajectory\": [\n";
    for (size_t i = 0; i < chase_trajectory.size(); i++) {
        json << "      {\"t\": " << chase_trajectory[i].time
             << ", \"x\": " << chase_trajectory[i].position.x
             << ", \"y\": " << chase_trajectory[i].position.y
             << ", \"z\": " << chase_trajectory[i].position.z << "}";
        if (i < chase_trajectory.size() - 1) json << ",";
        json << "\n";
    }
    json << "    ]},\n";

    json << "    {\"name\": \"Target\", \"color\": \"#FF0000\", \"trajectory\": [\n";
    for (size_t i = 0; i < target_trajectory.size(); i++) {
        json << "      {\"t\": " << target_trajectory[i].time
             << ", \"x\": " << target_trajectory[i].position.x
             << ", \"y\": " << target_trajectory[i].position.y
             << ", \"z\": " << target_trajectory[i].position.z << "}";
        if (i < target_trajectory.size() - 1) json << ",";
        json << "\n";
    }
    json << "    ]}\n";
    json << "  ],\n";

    // Debris
    json << "  \"debris\": [\n";
    int debris_exported = 0;
    for (size_t i = 0; i < debris.size(); i++) {
        const auto& d = debris[i];
        if (d.trajectory.size() < 2) continue;

        if (debris_exported > 0) json << ",\n";
        json << "    {\"id\": " << d.id << ", \"source\": " << d.source_sat << ", \"trajectory\": [\n";
        for (size_t j = 0; j < d.trajectory.size(); j++) {
            json << "      {\"t\": " << d.trajectory[j].time
                 << ", \"x\": " << d.trajectory[j].position.x
                 << ", \"y\": " << d.trajectory[j].position.y
                 << ", \"z\": " << d.trajectory[j].position.z << "}";
            if (j < d.trajectory.size() - 1) json << ",";
            json << "\n";
        }
        json << "    ]}";
        debris_exported++;
    }
    json << "\n  ]\n";
    json << "}\n";
    json.close();

    std::cout << "Exported " << debris_exported << " debris trajectories to collision_data.json" << std::endl;

    return 0;
}
