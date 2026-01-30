#include "distributed/sim_coordinator.hpp"
#include "distributed/sim_worker.hpp"
#include "core/state_vector.hpp"

#include <thread>
#include <chrono>
#include <iostream>
#include <iomanip>
#include <cmath>
#include <string>
#include <csignal>
#include <unistd.h>

// ---------------------------------------------------------------------------
// Distributed Simulation Demo
//
// Demonstrates federated simulation of a 4-satellite constellation split
// across two worker processes (threads in this demo).
//
// Coordinator assigns:
//   Worker 0 -> entities 0, 1  (400 km circular, incl 0 and 45 deg)
//   Worker 1 -> entities 2, 3  (800 km circular, incl 90 and 30 deg)
//
// Each worker propagates simple circular orbits using Keplerian motion:
//   theta(t) = theta_0 + n * t    where n = sqrt(mu / a^3)
//   position = R(i) * [a*cos(theta), a*sin(theta), 0]^T
//
// The coordinator steps 100 times at dt = 60s (100 minutes total),
// then gathers final states and prints positions.
// ---------------------------------------------------------------------------

static const double MU_EARTH = 3.986004418e14;  // m^3/s^2
static const double R_EARTH  = 6371000.0;        // m
static const double PI       = 3.14159265358979323846;

static const std::string SOCKET_PATH = "/tmp/sim_distributed.sock";

/// Orbital config for each entity
struct OrbitConfig {
    double altitude_km;   // above Earth surface
    double inclination_deg;
    double initial_theta_deg;  // initial true anomaly
};

/// Pre-configured orbits for the 4 entities
static OrbitConfig orbit_configs[] = {
    { 400.0,   0.0,   0.0 },   // Entity 0: 400 km equatorial
    { 400.0,  45.0,  90.0 },   // Entity 1: 400 km, 45 deg incl
    { 800.0,  90.0, 180.0 },   // Entity 2: 800 km polar
    { 800.0,  30.0, 270.0 },   // Entity 3: 800 km, 30 deg incl
};

/// Circular orbit propagation update function
/// Computes ECI position/velocity from Keplerian elements after dt
static void circular_orbit_update(int entity_id, double dt, sim::StateVector& state) {
    if (entity_id < 0 || entity_id >= 4) return;

    const auto& cfg = orbit_configs[entity_id];
    double a = R_EARTH + cfg.altitude_km * 1000.0;      // semi-major axis [m]
    double incl = cfg.inclination_deg * PI / 180.0;      // inclination [rad]

    // Mean motion
    double n = std::sqrt(MU_EARTH / (a * a * a));        // rad/s

    // Orbital velocity for circular orbit
    double v_orb = std::sqrt(MU_EARTH / a);              // m/s

    // True anomaly: advance by n*dt from current accumulated time
    // We store accumulated theta in state.angular_velocity.x as a trick
    // (not a real angular velocity, just convenient storage for the demo)
    double theta = state.angular_velocity.x + n * dt;

    // Keep theta in [0, 2*PI)
    while (theta >= 2.0 * PI) theta -= 2.0 * PI;

    state.angular_velocity.x = theta;

    // Position in orbital plane
    double x_orb = a * std::cos(theta);
    double y_orb = a * std::sin(theta);

    // Velocity in orbital plane (circular orbit: perpendicular to radius)
    double vx_orb = -v_orb * std::sin(theta);
    double vy_orb =  v_orb * std::cos(theta);

    // Rotate by inclination around x-axis:
    //   x' = x
    //   y' = y * cos(i)
    //   z' = y * sin(i)
    double cos_i = std::cos(incl);
    double sin_i = std::sin(incl);

    state.position.x = x_orb;
    state.position.y = y_orb * cos_i;
    state.position.z = y_orb * sin_i;

    state.velocity.x = vx_orb;
    state.velocity.y = vy_orb * cos_i;
    state.velocity.z = vy_orb * sin_i;
}

/// Worker thread function
static void worker_thread_fn(int worker_id) {
    // Small delay to let coordinator start listening
    std::this_thread::sleep_for(std::chrono::milliseconds(100 + worker_id * 50));

    sim::distributed::SimWorker worker(SOCKET_PATH);
    worker.set_update_function(circular_orbit_update);

    if (!worker.connect()) {
        std::cerr << "[Worker " << worker_id << "] Failed to connect." << std::endl;
        return;
    }

    std::cout << "[Worker " << worker_id << "] Connected, entering event loop." << std::endl;
    worker.run();
    std::cout << "[Worker " << worker_id << "] Exited." << std::endl;
}

/// Coordinator thread function
static void coordinator_thread_fn() {
    const int NUM_WORKERS = 2;
    const int NUM_STEPS = 100;
    const double DT = 60.0;  // seconds per step

    try {
        sim::distributed::SimCoordinator coordinator(SOCKET_PATH);

        // Wait for both workers
        coordinator.start(NUM_WORKERS);

        // Assign entities: worker 0 gets entities 0,1; worker 1 gets entities 2,3
        std::vector<sim::distributed::WorkerAssignment> assignments = {
            { 0, {0, 1} },
            { 1, {2, 3} }
        };
        coordinator.assign_entities(assignments);

        // Run the simulation
        std::cout << "\n[Coordinator] Running " << NUM_STEPS << " steps of "
                  << DT << "s each (" << (NUM_STEPS * DT / 60.0)
                  << " minutes total)...\n" << std::endl;

        bool ok = coordinator.run_until(NUM_STEPS * DT, DT);

        if (!ok) {
            std::cerr << "[Coordinator] Simulation did not complete successfully." << std::endl;
        }

        // Gather final states
        auto states = coordinator.gather_states();

        std::cout << "\n=========================================" << std::endl;
        std::cout << "  Distributed Simulation Results" << std::endl;
        std::cout << "  " << NUM_STEPS << " steps x " << DT
                  << "s = " << (NUM_STEPS * DT) << "s total" << std::endl;
        std::cout << "=========================================" << std::endl;

        for (size_t i = 0; i < states.size(); ++i) {
            const auto& sv = states[i];
            double r = sv.position.norm();
            double alt_km = (r - R_EARTH) / 1000.0;
            double v = sv.velocity.norm();

            std::cout << std::fixed << std::setprecision(1);
            std::cout << "\nEntity " << i << ":" << std::endl;
            std::cout << "  Position (ECI): ["
                      << std::setw(12) << sv.position.x / 1000.0 << ", "
                      << std::setw(12) << sv.position.y / 1000.0 << ", "
                      << std::setw(12) << sv.position.z / 1000.0
                      << "] km" << std::endl;
            std::cout << "  Velocity (ECI): ["
                      << std::setw(10) << sv.velocity.x / 1000.0 << ", "
                      << std::setw(10) << sv.velocity.y / 1000.0 << ", "
                      << std::setw(10) << sv.velocity.z / 1000.0
                      << "] km/s" << std::endl;
            std::cout << "  Altitude:       " << alt_km << " km" << std::endl;
            std::cout << "  Speed:          " << v / 1000.0 << " km/s" << std::endl;
            std::cout << "  Sim time:       " << sv.time << " s" << std::endl;

            // Verify: expected altitude should match configured orbit
            if (i < 4) {
                double expected_alt = orbit_configs[i].altitude_km;
                double alt_error = std::abs(alt_km - expected_alt);
                std::cout << "  Expected alt:   " << expected_alt << " km"
                          << " (error: " << alt_error << " km)" << std::endl;
            }
        }

        std::cout << "\n=========================================" << std::endl;

        // Validate results
        bool valid = true;
        for (size_t i = 0; i < states.size() && i < 4; ++i) {
            double r = states[i].position.norm();
            double alt_km = (r - R_EARTH) / 1000.0;
            double expected_alt = orbit_configs[i].altitude_km;
            if (std::abs(alt_km - expected_alt) > 1.0) {
                std::cerr << "  VALIDATION FAIL: Entity " << i
                          << " altitude " << alt_km
                          << " km, expected " << expected_alt << " km" << std::endl;
                valid = false;
            }
        }

        if (valid && !states.empty()) {
            std::cout << "  All orbits validated: circular altitudes correct." << std::endl;
        }

        std::cout << "=========================================" << std::endl;

        // Shutdown
        coordinator.shutdown();

    } catch (const std::exception& e) {
        std::cerr << "[Coordinator] Fatal error: " << e.what() << std::endl;
    }
}

int main() {
    std::cout << "=========================================" << std::endl;
    std::cout << "  All-Domain Distributed Simulation Demo" << std::endl;
    std::cout << "=========================================" << std::endl;
    std::cout << "Socket: " << SOCKET_PATH << std::endl;
    std::cout << "Topology: 1 coordinator + 2 workers" << std::endl;
    std::cout << "Entities: 4 satellites in circular orbits" << std::endl;
    std::cout << "=========================================" << std::endl;

    // Clean up any stale socket
    ::unlink(SOCKET_PATH.c_str());

    // Launch coordinator thread
    std::thread coord_thread(coordinator_thread_fn);

    // Launch worker threads (with staggered delays built into worker_thread_fn)
    std::thread worker0(worker_thread_fn, 0);
    std::thread worker1(worker_thread_fn, 1);

    // Wait for all threads
    coord_thread.join();
    worker0.join();
    worker1.join();

    // Clean up socket file
    ::unlink(SOCKET_PATH.c_str());

    std::cout << "\nDistributed simulation demo complete." << std::endl;
    return 0;
}
