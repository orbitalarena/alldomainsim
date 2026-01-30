/**
 * Mission Sequence Designer
 *
 * Assembles multi-leg interplanetary tours from a sequence of planetary
 * encounters. Connects legs via gravity assists, computes total delta-V
 * budgets, and exports complete missions as JSON for visualization.
 *
 * Example: Earth → Venus → Mars tour:
 *   Leg 1: Earth departure → Venus arrival (Lambert transfer)
 *   Flyby:  Venus gravity assist (deflects to Mars-bound trajectory)
 *   Leg 2: Venus departure → Mars arrival (Lambert transfer)
 *
 * Uses InterplanetaryPlanner for each leg and GravityAssist for flybys.
 */

#ifndef SIM_MISSION_SEQUENCE_HPP
#define SIM_MISSION_SEQUENCE_HPP

#include "core/state_vector.hpp"
#include "planetary_ephemeris.hpp"
#include "interplanetary_planner.hpp"
#include "gravity_assist.hpp"
#include <vector>
#include <string>

namespace sim {

// -----------------------------------------------------------------
// Mission data structures
// -----------------------------------------------------------------

/**
 * Complete multi-leg interplanetary mission
 */
struct MissionSequence {
    std::string name;
    std::vector<Planet> body_sequence;  // e.g., {EARTH, VENUS, MARS}
    std::vector<double> epoch_jd;       // JD at each encounter
    std::vector<MissionLeg> legs;       // Transfer legs between encounters
    std::vector<FlybyResult> flybys;    // Gravity assists at intermediate bodies
    double total_delta_v;               // Total mission delta-V [m/s]
    double departure_c3;                // Departure C3 [km²/s²]
    bool valid;

    /** Number of legs (always body_sequence.size() - 1) */
    int num_legs() const { return static_cast<int>(legs.size()); }

    /** Total time of flight [s] */
    double total_tof() const {
        if (epoch_jd.size() < 2) return 0.0;
        return (epoch_jd.back() - epoch_jd.front()) * 86400.0;
    }

    /** Total time of flight [days] */
    double total_tof_days() const {
        if (epoch_jd.size() < 2) return 0.0;
        return epoch_jd.back() - epoch_jd.front();
    }
};

/**
 * Summary of a single encounter (for reporting)
 */
struct EncounterSummary {
    Planet body;
    double jd;
    double v_inf_in;    // m/s (arriving)
    double v_inf_out;   // m/s (departing)
    double delta_v;     // m/s (burn at this body, 0 for unpowered flyby)
    double turn_angle;  // rad (flyby turn, 0 for departure/arrival)
    double periapsis_alt; // m (flyby periapsis altitude, 0 for endpoints)
};

// -----------------------------------------------------------------
// Mission Designer
// -----------------------------------------------------------------

class MissionDesigner {
public:
    /**
     * Build a complete multi-leg mission from a body sequence and dates.
     *
     * For each consecutive pair of bodies, computes a Lambert transfer
     * using InterplanetaryPlanner. At intermediate bodies, computes
     * the gravity assist that connects the incoming and outgoing legs.
     *
     * Delta-V budget includes:
     *   - Departure burn from parking orbit at first body
     *   - Any powered flyby delta-V at intermediate bodies (if needed)
     *   - Capture burn at final body
     *
     * @param bodies                 Sequence of planets to visit
     * @param dates_jd               Julian Date at each encounter (same length as bodies)
     * @param departure_parking_alt  Altitude of departure parking orbit [m]
     * @param arrival_parking_alt    Altitude of arrival parking orbit [m]
     * @return MissionSequence with legs, flybys, and delta-V budget
     */
    static MissionSequence build_mission(
        const std::vector<Planet>& bodies,
        const std::vector<double>& dates_jd,
        double departure_parking_alt = 200e3,
        double arrival_parking_alt = 200e3);

    /**
     * Optimize encounter dates to minimize total delta-V.
     *
     * Uses coordinate-descent (one date at a time) with golden-section
     * search. Holds departure and arrival dates fixed; optimizes
     * intermediate flyby dates.
     *
     * @param bodies             Sequence of planets
     * @param initial_dates_jd   Initial guess for encounter dates
     * @param max_iterations     Maximum optimization iterations
     * @return Optimized MissionSequence
     */
    static MissionSequence optimize_dates(
        const std::vector<Planet>& bodies,
        const std::vector<double>& initial_dates_jd,
        int max_iterations = 100);

    /**
     * Generate encounter summaries for reporting
     */
    static std::vector<EncounterSummary> summarize_encounters(
        const MissionSequence& mission);

    /**
     * Export mission to JSON file for visualization.
     *
     * Output includes:
     *   - Mission metadata (name, bodies, dates, delta-V)
     *   - Each leg's sampled trajectory (HCI positions)
     *   - Planet positions at each encounter
     *   - Flyby parameters
     *   - Planet orbits for context
     *
     * @param mission   Mission to export
     * @param filename  Output JSON file path
     */
    static void export_mission_json(
        const MissionSequence& mission,
        const std::string& filename);

    /**
     * Compute the total delta-V for a given body sequence and dates
     * (utility for optimizer)
     */
    static double compute_total_dv(
        const std::vector<Planet>& bodies,
        const std::vector<double>& dates_jd,
        double departure_parking_alt = 200e3,
        double arrival_parking_alt = 200e3);
};

}  // namespace sim

#endif  // SIM_MISSION_SEQUENCE_HPP
