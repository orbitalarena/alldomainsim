/**
 * Apollo Lunar Return Demo
 *
 * Simulates an Apollo-style command module returning from the Moon:
 * 1. Start in low lunar orbit (100 km)
 * 2. Trans-Earth Injection (TEI) burn
 * 3. Coast through cislunar space
 * 4. Multiple aerobraking passes at Earth
 * 5. Orbit circularization
 * 6. Final re-entry with parachutes
 * 7. Splashdown
 */

#include <iostream>
#include <fstream>
#include <iomanip>
#include <cmath>
#include <vector>

#include "entities/command_module.hpp"
#include "physics/lunar_ephemeris.hpp"
#include "physics/multi_body_gravity.hpp"
#include "physics/aerobraking.hpp"
#include "physics/orbital_elements.hpp"
#include "coordinate/time_utils.hpp"
#include "coordinate/frame_transformer.hpp"

using namespace sim;

const double PI = 3.14159265358979323846;
const double DEG_TO_RAD = PI / 180.0;
const double RAD_TO_DEG = 180.0 / PI;

/**
 * Mission data point for JSON export
 */
struct MissionDataPoint {
    double time;                  // Mission elapsed time (s)
    std::string phase;            // Current mission phase
    Vec3 position_eci;            // ECI position (m)
    Vec3 velocity_eci;            // ECI velocity (m/s)
    double altitude_earth;        // Altitude above Earth (km)
    double altitude_moon;         // Distance from Moon center (km)
    double velocity_mag;          // Speed (m/s)
    double apogee;                // Current apogee altitude (km)
    double perigee;               // Current perigee altitude (km)
    double g_load;                // Current g-load
    double heat_flux;             // W/m²
    std::string primary_body;     // Current primary body
    double lat, lon;              // Geodetic (when near Earth)
};

/**
 * Export mission data to JSON
 */
void export_json(const std::string& filename,
                 const std::vector<MissionDataPoint>& data,
                 const std::vector<Vec3>& moon_positions,
                 double epoch_jd,
                 double record_interval) {

    std::ofstream out(filename);
    out << std::fixed << std::setprecision(6);

    out << "{\n";
    out << "  \"metadata\": {\n";
    out << "    \"scenario\": \"Apollo Lunar Return\",\n";
    out << "    \"epoch_jd\": " << epoch_jd << ",\n";
    out << "    \"record_interval_s\": " << record_interval << ",\n";
    out << "    \"total_points\": " << data.size() << ",\n";
    out << "    \"duration_hours\": " << (data.back().time / 3600.0) << "\n";
    out << "  },\n";

    // Moon trajectory
    out << "  \"moon_trajectory\": [\n";
    for (size_t i = 0; i < moon_positions.size(); i++) {
        const auto& m = moon_positions[i];
        out << "    {\"x\": " << m.x << ", \"y\": " << m.y << ", \"z\": " << m.z << "}";
        if (i < moon_positions.size() - 1) out << ",";
        out << "\n";
    }
    out << "  ],\n";

    // Command module trajectory
    out << "  \"trajectory\": [\n";
    for (size_t i = 0; i < data.size(); i++) {
        const auto& d = data[i];
        out << "    {\n";
        out << "      \"t\": " << d.time << ",\n";
        out << "      \"phase\": \"" << d.phase << "\",\n";
        out << "      \"eci\": {\"x\": " << d.position_eci.x
            << ", \"y\": " << d.position_eci.y
            << ", \"z\": " << d.position_eci.z << "},\n";
        out << "      \"vel\": {\"x\": " << d.velocity_eci.x
            << ", \"y\": " << d.velocity_eci.y
            << ", \"z\": " << d.velocity_eci.z << "},\n";
        out << "      \"alt_earth_km\": " << d.altitude_earth << ",\n";
        out << "      \"alt_moon_km\": " << d.altitude_moon << ",\n";
        out << "      \"speed_ms\": " << d.velocity_mag << ",\n";
        out << "      \"apogee_km\": " << d.apogee << ",\n";
        out << "      \"perigee_km\": " << d.perigee << ",\n";
        out << "      \"g_load\": " << d.g_load << ",\n";
        out << "      \"heat_flux\": " << d.heat_flux << ",\n";
        out << "      \"primary\": \"" << d.primary_body << "\",\n";
        out << "      \"lat\": " << d.lat << ",\n";
        out << "      \"lon\": " << d.lon << "\n";
        out << "    }";
        if (i < data.size() - 1) out << ",";
        out << "\n";
    }
    out << "  ]\n";
    out << "}\n";

    out.close();
    std::cout << "Exported to " << filename << "\n";
}

int main() {
    std::cout << "=== Apollo Aerobraking Mission ===\n\n";
    std::cout << "Scenario: Post-TEI capture into highly elliptical Earth orbit\n";
    std::cout << "Starting 50,000 x 90 km orbit for multi-pass aerobraking\n\n";

    // Mission parameters
    double epoch_jd = 2460335.0;  // Jan 25, 2024

    // Create command module
    CommandModule cm("Apollo CM", 1);

    // Get Moon state at epoch
    Vec3 moon_pos = LunarEphemeris::get_moon_position_eci(epoch_jd);
    Vec3 moon_vel = LunarEphemeris::get_moon_velocity_eci(epoch_jd);
    double moon_dist = moon_pos.norm();

    std::cout << "Moon position (ECI): [" << moon_pos.x/1e6 << ", "
              << moon_pos.y/1e6 << ", " << moon_pos.z/1e6 << "] Mm\n";
    std::cout << "Moon distance from Earth: " << moon_dist/1e6 << " Mm\n";

    // SCENARIO: Aerobraking from high Earth orbit
    // For realistic multi-pass aerobraking, we need perigee velocity < ~8 km/s
    // This requires starting from a lower apogee than lunar distance
    //
    // Scenario: After TEI and a capture burn, CM is in 100,000 x 120 km orbit
    // This gives perigee velocity of ~7 km/s, suitable for multi-pass aerobraking

    // Start at apogee of highly elliptical orbit (50,000 km altitude)
    double start_apogee_alt = 50000e3;  // 50,000 km
    double cm_earth_dist = EARTH_RADIUS + start_apogee_alt;

    // Position: arbitrary direction (prograde orbit in equatorial plane)
    Vec3 cm_pos_eci;
    cm_pos_eci.x = cm_earth_dist;
    cm_pos_eci.y = 0.0;
    cm_pos_eci.z = 0.0;

    std::cout << "CM distance from Earth: " << cm_earth_dist/1e6 << " Mm\n";

    // Velocity: Design for orbit with perigee at aerobraking altitude
    // At apogee, velocity must be PERPENDICULAR to radius (tangent to orbit)
    // Using vis-viva: v² = mu * (2/r - 1/a)

    double target_perigee_alt = 90000.0;              // 90 km (in mesosphere for meaningful drag)
    double target_perigee = EARTH_RADIUS + target_perigee_alt;
    double target_apogee = cm_earth_dist;             // Current position is apogee

    double a = (target_apogee + target_perigee) / 2.0;  // Semi-major axis
    double v_at_apogee = std::sqrt(EARTH_MU * (2.0/cm_earth_dist - 1.0/a));

    std::cout << "Target orbit: " << (target_apogee-EARTH_RADIUS)/1000 << " x "
              << target_perigee_alt/1000 << " km\n";
    std::cout << "Velocity at apogee needed: " << v_at_apogee << " m/s\n";

    // Velocity direction: PERPENDICULAR to position (tangent at apogee)
    // Cross position with Z-axis to get tangent direction
    Vec3 pos_unit;
    pos_unit.x = cm_pos_eci.x / cm_earth_dist;
    pos_unit.y = cm_pos_eci.y / cm_earth_dist;
    pos_unit.z = cm_pos_eci.z / cm_earth_dist;

    // Use cross product with Z-axis to get tangent direction
    Vec3 z_axis = {0, 0, 1};
    Vec3 tangent;
    tangent.x = pos_unit.y * z_axis.z - pos_unit.z * z_axis.y;
    tangent.y = pos_unit.z * z_axis.x - pos_unit.x * z_axis.z;
    tangent.z = pos_unit.x * z_axis.y - pos_unit.y * z_axis.x;

    double t_mag = std::sqrt(tangent.x*tangent.x + tangent.y*tangent.y + tangent.z*tangent.z);
    tangent.x /= t_mag;
    tangent.y /= t_mag;
    tangent.z /= t_mag;

    // Velocity perpendicular to position (prograde at apogee)
    Vec3 cm_vel_eci;
    cm_vel_eci.x = v_at_apogee * tangent.x;
    cm_vel_eci.y = v_at_apogee * tangent.y;
    cm_vel_eci.z = v_at_apogee * tangent.z;

    // Set CM state
    StateVector initial_state;
    initial_state.position = cm_pos_eci;
    initial_state.velocity = cm_vel_eci;
    initial_state.frame = CoordinateFrame::J2000_ECI;
    initial_state.time = 0.0;
    cm.set_state(initial_state);
    cm.set_primary_body(PrimaryBody::EARTH);  // Already in Earth's SOI

    std::cout << "\nCM initial state (post-TEI):\n";
    std::cout << "  Position (ECI): [" << cm_pos_eci.x/1e6 << ", "
              << cm_pos_eci.y/1e6 << ", " << cm_pos_eci.z/1e6 << "] Mm\n";
    std::cout << "  Velocity (ECI): [" << cm_vel_eci.x << ", "
              << cm_vel_eci.y << ", " << cm_vel_eci.z << "] m/s\n";
    std::cout << "  Speed: " << cm_vel_eci.norm() << " m/s\n";

    // Verify initial orbit parameters
    double init_apogee, init_perigee, init_ecc;
    cm.get_orbit_params(init_apogee, init_perigee, init_ecc);
    std::cout << "  Orbit: " << init_apogee/1000 << " x " << init_perigee/1000
              << " km, e=" << init_ecc << "\n";

    // No TEI needed - we start post-TEI
    double tei_time = -1.0;  // Already done
    double tei_dv_mag = 0.0;

    std::cout << "\nStarting trans-Earth coast (TEI already completed)\n";

    // Simulation parameters
    double dt_orbital = 10.0;      // 10 second step for orbital flight
    double dt_atm = 0.5;           // 0.5 second step for atmospheric flight
    double dt = dt_orbital;        // Current timestep
    double record_interval = 60.0; // Record every minute
    double last_record = -record_interval;
    double sim_time = 0.0;
    double max_mission_time = 7 * 24 * 3600;  // 7 days max

    // Data storage
    std::vector<MissionDataPoint> trajectory;
    std::vector<Vec3> moon_trajectory;
    trajectory.reserve(10000);
    moon_trajectory.reserve(10000);

    // Mission state tracking
    bool tei_executed = false;
    int aerobrake_count = 0;
    PrimaryBody last_primary = PrimaryBody::EARTH;  // Starting at Earth

    std::cout << "\n--- Starting Simulation ---\n\n";

    while (sim_time < max_mission_time &&
           cm.get_flight_phase() != CMFlightPhase::SPLASHDOWN) {

        // Update Moon state
        double current_jd = epoch_jd + sim_time / 86400.0;
        StateVector moon_state;
        moon_state.position = LunarEphemeris::get_moon_position_eci(current_jd);
        moon_state.velocity = LunarEphemeris::get_moon_velocity_eci(current_jd);
        cm.set_moon_state(moon_state);

        // TEI already executed before simulation start (simplified scenario)

        // Adjust timestep based on altitude (smaller for atmospheric flight)
        double altitude = cm.get_state().position.norm() - EARTH_RADIUS;
        if (altitude < 150000.0) {  // Below 150 km
            dt = dt_atm;
        } else if (altitude < 500000.0) {  // 150-500 km - transition region
            dt = 2.0;
        } else {
            dt = dt_orbital;
        }

        // Update CM
        cm.update(dt);
        sim_time += dt;

        // Check for SOI transition
        if (cm.get_primary_body() != last_primary) {
            std::cout << "T+" << std::fixed << std::setprecision(1) << sim_time/3600
                      << " hr: SOI TRANSITION to "
                      << primary_body_to_string(cm.get_primary_body()) << "\n";
            last_primary = cm.get_primary_body();
        }

        // Check for aerobraking
        if (cm.get_flight_phase() == CMFlightPhase::AEROBRAKING &&
            cm.aerobrake_pass_count > aerobrake_count) {
            aerobrake_count = cm.aerobrake_pass_count;
            double apogee, perigee, ecc;
            cm.get_orbit_params(apogee, perigee, ecc);
            std::cout << "T+" << std::fixed << std::setprecision(1) << sim_time/3600
                      << " hr: AEROBRAKE PASS #" << aerobrake_count << " complete\n";
            std::cout << "  New orbit: " << apogee/1000 << " x " << perigee/1000 << " km\n";
            std::cout << "  Max G: " << cm.max_g_experienced << " g\n";
        }

        // Record data
        if (sim_time - last_record >= record_interval) {
            MissionDataPoint point;
            point.time = sim_time;
            point.phase = cm_phase_to_string(cm.get_flight_phase());
            point.position_eci = cm.get_state().position;
            point.velocity_eci = cm.get_state().velocity;
            point.velocity_mag = cm.get_state().velocity.norm();

            // Altitudes
            point.altitude_earth = (cm.get_state().position.norm() - EARTH_RADIUS) / 1000.0;

            Vec3 pos_mci = MultiBodyGravity::eci_to_mci(
                cm.get_state().position, moon_state.position);
            point.altitude_moon = pos_mci.norm() / 1000.0;

            // Orbital elements
            double apogee, perigee, ecc;
            cm.get_orbit_params(apogee, perigee, ecc);
            point.apogee = apogee / 1000.0;
            point.perigee = perigee / 1000.0;

            // Atmospheric state
            CMAtmosphericState atm = cm.get_atmospheric_state();
            point.g_load = atm.g_load;
            point.heat_flux = atm.heat_flux;

            point.primary_body = primary_body_to_string(cm.get_primary_body());

            // Geodetic coordinates (for Earth reference)
            GeodeticCoord geo = FrameTransformer::eci_to_geodetic(
                cm.get_state().position, current_jd);
            point.lat = geo.latitude;
            point.lon = geo.longitude;

            trajectory.push_back(point);
            moon_trajectory.push_back(moon_state.position);

            last_record = sim_time;
        }

        // Progress output every hour
        static int last_hour = -1;
        int current_hour = static_cast<int>(sim_time / 3600);
        if (current_hour > last_hour && current_hour % 6 == 0) {
            std::cout << "T+" << current_hour << " hr: "
                      << cm_phase_to_string(cm.get_flight_phase())
                      << ", Alt(Earth)=" << std::fixed << std::setprecision(0)
                      << (cm.get_state().position.norm() - EARTH_RADIUS)/1000 << " km\n";
            last_hour = current_hour;
        }

    }

    // Final status
    std::cout << "\n=== MISSION COMPLETE ===\n";
    std::cout << "Final phase: " << cm_phase_to_string(cm.get_flight_phase()) << "\n";
    std::cout << "Mission duration: " << std::fixed << std::setprecision(1)
              << sim_time/3600 << " hours (" << sim_time/86400 << " days)\n";
    std::cout << "Aerobraking passes: " << cm.aerobrake_pass_count << "\n";
    std::cout << "Max G experienced: " << cm.max_g_experienced << " g\n";
    std::cout << "Total heat absorbed: " << cm.total_heat_absorbed/1e6 << " MJ/m²\n";

    // Splashdown location
    GeodeticCoord landing = FrameTransformer::eci_to_geodetic(
        cm.get_state().position, epoch_jd + sim_time/86400.0);
    std::cout << "Splashdown: " << landing.latitude << "° N, "
              << landing.longitude << "° E\n";

    // Export data
    export_json("visualization/cesium/lunar_return_data.json",
                trajectory, moon_trajectory, epoch_jd, record_interval);

    std::cout << "\nRecorded " << trajectory.size() << " trajectory points\n";

    return 0;
}
