#ifndef TACTICAL_AI_HPP
#define TACTICAL_AI_HPP

#include <string>
#include <vector>

namespace sim {

/**
 * Tactical AI State Machine for Air Combat
 *
 * Implements a finite state machine for BVR (Beyond Visual Range) and WVR
 * (Within Visual Range) air combat tactics.
 *
 * States follow typical fighter pilot decision-making:
 * - PATROL: Searching for contacts
 * - DETECTED: Contact found, assessing threat
 * - COMMIT: Decision to engage, closing
 * - LAUNCH: Weapons employment
 * - CRANK: Post-launch maneuvering (keeping target illuminated)
 * - PUMP: Repositioning maneuver
 * - DEFEND: Reacting to incoming threat
 * - MERGE: Close-range engagement
 * - DISENGAGE: Breaking off engagement
 * - KILLED: Aircraft destroyed
 */

enum class TacticalState {
    PATROL,     // Searching for contacts
    DETECTED,   // Contact found, evaluating
    COMMIT,     // Decided to engage, closing
    LAUNCH,     // Firing weapons
    CRANK,      // Turning to beam after launch
    PUMP,       // Repositioning (turn away, then recommit)
    DEFEND,     // Defensive reaction
    MERGE,      // Close range fight
    DISENGAGE,  // Breaking off
    KILLED      // Destroyed
};

/**
 * Convert state to string for display
 */
const char* tactical_state_to_string(TacticalState state);

/**
 * Engagement parameters for tactical AI
 */
struct EngagementParams {
    // Detection and identification
    double radar_range_km = 150.0;       // Max detection range
    double iff_range_km = 80.0;          // Friend/Foe ID range

    // Weapons envelopes (simplified)
    double bvr_max_range_km = 80.0;      // Max BVR missile range
    double bvr_min_range_km = 15.0;      // Min BVR range (too close)
    double wvr_range_km = 10.0;          // WVR engagement range
    double guns_range_km = 2.0;          // Gun range

    // Decision thresholds
    double commit_range_km = 60.0;       // Range to commit to engagement
    double abort_range_km = 120.0;       // Range to abort pursuit
    double merge_range_km = 5.0;         // Range considered merge
    double escape_range_km = 30.0;       // Safe to disengage

    // Weapon inventory
    int bvr_missiles = 4;                // Number of BVR missiles
    int wvr_missiles = 2;                // Number of WVR missiles
    int guns_rounds = 500;               // Guns ammunition

    // Timing
    double reattack_delay_s = 30.0;      // Minimum time between attacks
    double crank_duration_s = 20.0;      // Time to maintain crank
    double pump_duration_s = 15.0;       // Time for pump maneuver

    // Maneuver parameters
    double crank_angle_deg = 70.0;       // Angle off for crank maneuver
    double pump_turn_deg = 120.0;        // Turn angle for pump
};

/**
 * Target information structure
 */
struct TargetInfo {
    int id;
    double range_km;
    double bearing_deg;       // Relative bearing from nose
    double aspect_deg;        // Target aspect angle
    double closure_rate_mps;  // Closing velocity
    double altitude_m;
    bool is_hostile;
    bool is_locked;           // Radar lock acquired
    TacticalState enemy_state; // If known
};

/**
 * Tactical AI decision result
 */
struct TacticalDecision {
    TacticalState new_state;
    double commanded_heading_deg;   // Desired heading
    double commanded_altitude_m;    // Desired altitude
    double commanded_speed_mps;     // Desired speed
    bool fire_bvr;                  // Launch BVR missile
    bool fire_wvr;                  // Launch WVR missile
    bool fire_guns;                 // Use guns
    int target_id;                  // Selected target ID (-1 = none)
    std::string reason;             // Decision explanation
};

/**
 * Tactical AI Controller
 *
 * Manages state transitions and tactical decision-making for a single aircraft.
 */
class TacticalAI {
public:
    TacticalAI(const EngagementParams& params = EngagementParams());

    /**
     * Update AI state and get decision
     * @param current_state Current tactical state
     * @param own_heading Current aircraft heading (deg)
     * @param own_altitude Current altitude (m)
     * @param own_speed Current speed (m/s)
     * @param targets Vector of detected targets
     * @param time_in_state Time spent in current state (s)
     * @return Tactical decision
     */
    TacticalDecision update(
        TacticalState current_state,
        double own_heading,
        double own_altitude,
        double own_speed,
        const std::vector<TargetInfo>& targets,
        double time_in_state);

    /**
     * Get engagement parameters
     */
    const EngagementParams& get_params() const { return params_; }

    /**
     * Set engagement parameters
     */
    void set_params(const EngagementParams& params) { params_ = params; }

    /**
     * Consume ammunition
     */
    void fire_bvr() { if (bvr_remaining_ > 0) bvr_remaining_--; }
    void fire_wvr() { if (wvr_remaining_ > 0) wvr_remaining_--; }
    void fire_guns(int rounds) { guns_remaining_ = std::max(0, guns_remaining_ - rounds); }

    int get_bvr_remaining() const { return bvr_remaining_; }
    int get_wvr_remaining() const { return wvr_remaining_; }
    int get_guns_remaining() const { return guns_remaining_; }

private:
    EngagementParams params_;
    int bvr_remaining_;
    int wvr_remaining_;
    int guns_remaining_;

    // Internal state
    int last_target_id_ = -1;
    double time_since_last_shot_ = 999.0;

    // Decision helpers
    TargetInfo* select_priority_target(std::vector<TargetInfo>& targets);
    double compute_intercept_heading(double own_heading, const TargetInfo& target);
    double compute_crank_heading(double own_heading, const TargetInfo& target);
};

/**
 * Compute bearing to target
 * @param own_lat Own latitude (deg)
 * @param own_lon Own longitude (deg)
 * @param tgt_lat Target latitude (deg)
 * @param tgt_lon Target longitude (deg)
 * @return Bearing in degrees (0-360)
 */
double compute_bearing(double own_lat, double own_lon, double tgt_lat, double tgt_lon);

/**
 * Compute range to target
 * @param own_lat Own latitude (deg)
 * @param own_lon Own longitude (deg)
 * @param tgt_lat Target latitude (deg)
 * @param tgt_lon Target longitude (deg)
 * @return Range in kilometers
 */
double compute_range_km(double own_lat, double own_lon, double tgt_lat, double tgt_lon);

/**
 * Normalize heading to 0-360
 */
double normalize_heading(double heading);

/**
 * Compute heading difference (shortest path)
 */
double heading_difference(double h1, double h2);

} // namespace sim

#endif // TACTICAL_AI_HPP
