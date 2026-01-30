/**
 * Interplanetary Transfer Planner Implementation
 *
 * Uses Lambert's problem to design transfers between planets. The workflow:
 *   1. Get planet positions/velocities from PlanetaryEphemeris at launch/arrival
 *   2. Solve Lambert's problem (ManeuverPlanner::solve_lambert) with mu = SUN_MU
 *   3. v_inf = v_transfer - v_planet at each end
 *   4. C3 = |v_inf|^2 (converted km^2/s^2)
 *   5. Delta-V from parking orbits via vis-viva at planet SOI boundary
 *
 * Porkchop plots sweep a grid of launch/arrival dates.
 * Mission legs sample the heliocentric Keplerian arc for visualization.
 */

#include "interplanetary_planner.hpp"
#include "vec3_ops.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

static constexpr double PI = 3.14159265358979323846;
static constexpr double TWO_PI = 2.0 * PI;

// ─────────────────────────────────────────────────────────────
// Departure delta-V from circular parking orbit
// ─────────────────────────────────────────────────────────────

double InterplanetaryPlanner::departure_delta_v(double c3, double parking_radius,
                                                 double mu_body) {
    // Circular parking orbit velocity
    double v_park = std::sqrt(mu_body / parking_radius);

    // Hyperbolic periapsis velocity (vis-viva with v_inf^2 = C3)
    // C3 is in km^2/s^2, convert to m^2/s^2 by multiplying by 1e6
    double v_hyp = std::sqrt(c3 * 1e6 + 2.0 * mu_body / parking_radius);

    return v_hyp - v_park;
}

// ─────────────────────────────────────────────────────────────
// Capture delta-V into circular orbit
// ─────────────────────────────────────────────────────────────

double InterplanetaryPlanner::capture_delta_v(double v_inf, double capture_radius,
                                               double mu_body) {
    // Hyperbolic periapsis velocity
    double v_hyp = std::sqrt(v_inf * v_inf + 2.0 * mu_body / capture_radius);

    // Circular orbit velocity at capture radius
    double v_circ = std::sqrt(mu_body / capture_radius);

    return v_hyp - v_circ;
}

// ─────────────────────────────────────────────────────────────
// Compute a single interplanetary transfer
// ─────────────────────────────────────────────────────────────

C3Result InterplanetaryPlanner::compute_transfer(Planet departure, Planet arrival,
                                                  double launch_jd, double arrival_jd,
                                                  double departure_parking_alt,
                                                  double arrival_parking_alt) {
    C3Result result;
    result.valid = false;
    result.c3_departure = 0.0;
    result.c3_arrival = 0.0;
    result.v_inf_departure = 0.0;
    result.v_inf_arrival = 0.0;
    result.total_delta_v = 0.0;
    result.v_departure_hci = Vec3::Zero();
    result.v_arrival_hci = Vec3::Zero();
    result.tof = 0.0;

    // Time of flight must be positive
    double tof = (arrival_jd - launch_jd) * 86400.0;  // Convert days to seconds
    if (tof <= 0.0) {
        return result;
    }

    // Get planet positions and velocities at departure and arrival
    Vec3 r1 = PlanetaryEphemeris::get_position_hci(departure, launch_jd);
    Vec3 r2 = PlanetaryEphemeris::get_position_hci(arrival, arrival_jd);
    Vec3 v_planet_dep = PlanetaryEphemeris::get_velocity_hci(departure, launch_jd);
    Vec3 v_planet_arr = PlanetaryEphemeris::get_velocity_hci(arrival, arrival_jd);

    // Solve Lambert's problem with solar gravitational parameter
    LambertSolution lambert = ManeuverPlanner::solve_lambert(r1, r2, tof, SUN_MU, true);
    if (!lambert.valid) {
        return result;
    }

    // V-infinity vectors: transfer velocity minus planet velocity
    Vec3 v_inf_dep = lambert.v1 - v_planet_dep;
    Vec3 v_inf_arr = lambert.v2 - v_planet_arr;

    // V-infinity magnitudes
    double v_inf_dep_mag = v_inf_dep.norm();
    double v_inf_arr_mag = v_inf_arr.norm();

    // C3 = v_inf^2 in m^2/s^2, convert to km^2/s^2
    double c3_dep = (v_inf_dep_mag * v_inf_dep_mag) / 1e6;
    double c3_arr = (v_inf_arr_mag * v_inf_arr_mag) / 1e6;

    // Get planet physical constants for delta-V computation
    const PlanetaryConstants& dep_const = PlanetaryConstants::get(departure);
    const PlanetaryConstants& arr_const = PlanetaryConstants::get(arrival);

    double r_park_dep = dep_const.radius + departure_parking_alt;
    double r_park_arr = arr_const.radius + arrival_parking_alt;

    // Departure delta-V (from parking orbit to departure hyperbola)
    double dv_dep = departure_delta_v(c3_dep, r_park_dep, dep_const.mu);

    // Capture delta-V (from arrival hyperbola to capture orbit)
    double dv_arr = capture_delta_v(v_inf_arr_mag, r_park_arr, arr_const.mu);

    // Populate result
    result.c3_departure = c3_dep;
    result.c3_arrival = c3_arr;
    result.v_inf_departure = v_inf_dep_mag;
    result.v_inf_arrival = v_inf_arr_mag;
    result.total_delta_v = dv_dep + dv_arr;
    result.v_departure_hci = lambert.v1;
    result.v_arrival_hci = lambert.v2;
    result.tof = tof;
    result.valid = true;

    return result;
}

// ─────────────────────────────────────────────────────────────
// Generate porkchop plot
// ─────────────────────────────────────────────────────────────

std::vector<PorkchopPoint> InterplanetaryPlanner::generate_porkchop(
    Planet departure, Planet arrival,
    double launch_jd_start, double launch_jd_end, int launch_steps,
    double arrival_jd_start, double arrival_jd_end, int arrival_steps) {

    std::vector<PorkchopPoint> grid;
    grid.reserve(static_cast<size_t>(launch_steps) * static_cast<size_t>(arrival_steps));

    double launch_step = (launch_steps > 1) ?
        (launch_jd_end - launch_jd_start) / (launch_steps - 1) : 0.0;
    double arrival_step = (arrival_steps > 1) ?
        (arrival_jd_end - arrival_jd_start) / (arrival_steps - 1) : 0.0;

    // Row-major order: arrival row (outer), launch column (inner)
    for (int j = 0; j < arrival_steps; ++j) {
        double arr_jd = arrival_jd_start + j * arrival_step;

        for (int i = 0; i < launch_steps; ++i) {
            double lnch_jd = launch_jd_start + i * launch_step;

            PorkchopPoint pt;
            pt.launch_jd = lnch_jd;
            pt.arrival_jd = arr_jd;

            // Skip points where arrival is at or before launch
            if (arr_jd <= lnch_jd) {
                pt.c3_departure = 0.0;
                pt.c3_arrival = 0.0;
                pt.total_delta_v = 0.0;
                pt.valid = false;
                grid.push_back(pt);
                continue;
            }

            C3Result transfer = compute_transfer(departure, arrival, lnch_jd, arr_jd);

            pt.c3_departure = transfer.c3_departure;
            pt.c3_arrival = transfer.c3_arrival;
            pt.total_delta_v = transfer.total_delta_v;
            pt.valid = transfer.valid;

            grid.push_back(pt);
        }
    }

    return grid;
}

// ─────────────────────────────────────────────────────────────
// Build a mission leg with sampled trajectory
// ─────────────────────────────────────────────────────────────

MissionLeg InterplanetaryPlanner::build_leg(Planet departure, Planet arrival,
                                             double launch_jd, double arrival_jd,
                                             int num_samples) {
    MissionLeg leg;
    leg.name = std::string(planet_to_string(departure)) + " to " +
               std::string(planet_to_string(arrival));
    leg.departure_body = departure;
    leg.arrival_body = arrival;
    leg.departure_jd = launch_jd;
    leg.arrival_jd = arrival_jd;
    leg.delta_v = 0.0;
    leg.v_inf_departure = Vec3::Zero();
    leg.v_inf_arrival = Vec3::Zero();

    double tof = (arrival_jd - launch_jd) * 86400.0;
    if (tof <= 0.0 || num_samples < 2) {
        return leg;
    }

    // Get departure position and planet velocity
    Vec3 r1 = PlanetaryEphemeris::get_position_hci(departure, launch_jd);
    Vec3 v_planet_dep = PlanetaryEphemeris::get_velocity_hci(departure, launch_jd);
    Vec3 v_planet_arr = PlanetaryEphemeris::get_velocity_hci(arrival, arrival_jd);

    // Solve Lambert to get transfer orbit velocities
    Vec3 r2 = PlanetaryEphemeris::get_position_hci(arrival, arrival_jd);
    LambertSolution lambert = ManeuverPlanner::solve_lambert(r1, r2, tof, SUN_MU, true);
    if (!lambert.valid) {
        return leg;
    }

    // V-infinity vectors
    Vec3 v_inf_dep = lambert.v1 - v_planet_dep;
    Vec3 v_inf_arr = lambert.v2 - v_planet_arr;

    leg.v_inf_departure = v_inf_dep;
    leg.v_inf_arrival = v_inf_arr;

    // Compute total delta-V (departure + capture with default 200km parking orbits)
    double v_inf_dep_mag = v_inf_dep.norm();
    double v_inf_arr_mag = v_inf_arr.norm();
    double c3_dep = (v_inf_dep_mag * v_inf_dep_mag) / 1e6;

    const PlanetaryConstants& dep_const = PlanetaryConstants::get(departure);
    const PlanetaryConstants& arr_const = PlanetaryConstants::get(arrival);
    double r_park_dep = dep_const.radius + 200e3;
    double r_park_arr = arr_const.radius + 200e3;

    leg.delta_v = departure_delta_v(c3_dep, r_park_dep, dep_const.mu) +
                  capture_delta_v(v_inf_arr_mag, r_park_arr, arr_const.mu);

    // Build a StateVector at departure for the transfer orbit (heliocentric)
    StateVector dep_state;
    dep_state.position = r1;
    dep_state.velocity = lambert.v1;
    dep_state.frame = CoordinateFrame::HELIOCENTRIC_J2000;
    dep_state.time = 0.0;

    // Convert to heliocentric Keplerian elements
    OrbitalElements transfer_elements = OrbitalMechanics::state_to_elements(dep_state, SUN_MU);

    // Mean motion for the transfer orbit
    double a = transfer_elements.semi_major_axis;
    if (a <= 0.0 || std::isnan(a) || std::isinf(a)) {
        // Degenerate orbit -- cannot propagate Keplerian elements
        return leg;
    }
    double n = std::sqrt(SUN_MU / (a * a * a));  // Mean motion [rad/s]

    // Initial mean anomaly at departure
    double M0 = transfer_elements.mean_anomaly;

    // Sample the transfer arc at uniform time intervals
    double dt_step = tof / (num_samples - 1);

    leg.trajectory.reserve(num_samples);

    for (int k = 0; k < num_samples; ++k) {
        double t = k * dt_step;

        // Propagate mean anomaly
        double M = OrbitalMechanics::propagate_mean_anomaly(M0, n, t);

        // Solve Kepler's equation for true anomaly
        double nu = OrbitalMechanics::mean_to_true_anomaly(M, transfer_elements.eccentricity);

        // Build elements at this time (same orbit, different true anomaly)
        OrbitalElements sample_elem = transfer_elements;
        sample_elem.true_anomaly = nu;
        sample_elem.mean_anomaly = M;

        // Convert back to Cartesian state (heliocentric)
        StateVector sample_state = OrbitalMechanics::elements_to_state(sample_elem, SUN_MU);
        sample_state.frame = CoordinateFrame::HELIOCENTRIC_J2000;
        sample_state.time = t;

        // Filter NaN positions
        if (std::isnan(sample_state.position.x) ||
            std::isnan(sample_state.position.y) ||
            std::isnan(sample_state.position.z)) {
            continue;
        }

        leg.trajectory.push_back(sample_state);
    }

    return leg;
}

// ─────────────────────────────────────────────────────────────
// Compute departure asymptote direction
// ─────────────────────────────────────────────────────────────

Vec3 InterplanetaryPlanner::compute_departure_asymptote(Planet departure, Planet arrival,
                                                         double launch_jd, double arrival_jd) {
    double tof = (arrival_jd - launch_jd) * 86400.0;
    if (tof <= 0.0) {
        return Vec3::Zero();
    }

    // Get departure planet state
    Vec3 r1 = PlanetaryEphemeris::get_position_hci(departure, launch_jd);
    Vec3 r2 = PlanetaryEphemeris::get_position_hci(arrival, arrival_jd);
    Vec3 v_planet_dep = PlanetaryEphemeris::get_velocity_hci(departure, launch_jd);

    // Solve Lambert
    LambertSolution lambert = ManeuverPlanner::solve_lambert(r1, r2, tof, SUN_MU, true);
    if (!lambert.valid) {
        return Vec3::Zero();
    }

    // V-infinity at departure
    Vec3 v_inf = lambert.v1 - v_planet_dep;
    double mag = v_inf.norm();
    if (mag < 1e-10) {
        return Vec3::Zero();
    }

    // Return unit vector
    return v_inf / mag;
}

}  // namespace sim
