#ifndef SIM_MC_AIRCRAFT_CONFIGS_HPP
#define SIM_MC_AIRCRAFT_CONFIGS_HPP

#include <cmath>
#include <string>

namespace sim::mc {

/// Degrees-to-radians conversion for constexpr initialization.
constexpr double deg2rad(double deg) { return deg * M_PI / 180.0; }

/// Aircraft aerodynamic, propulsion, and performance configuration.
struct AircraftConfig {
    double mass_loaded;          // kg
    double wing_area;            // m²
    double aspect_ratio;

    double cd0;                  // zero-lift drag coefficient
    double oswald;               // Oswald efficiency factor
    double cl_alpha;             // lift curve slope (per degree)
    double cl_max;               // maximum lift coefficient

    double thrust_mil;           // military thrust (N)
    double thrust_ab;            // afterburner thrust (N)

    double max_g;                // structural g limit
    double max_aoa_rad;          // maximum angle of attack (rad)
    double max_roll_rate_rad;    // maximum roll rate (rad/s)
    double max_pitch_rate_rad;   // maximum pitch rate (rad/s)

    double idle_thrust_frac = 0.05;  // idle thrust as fraction of mil thrust
};

// ---------------------------------------------------------------------------
// Named aircraft configurations
// ---------------------------------------------------------------------------

inline const AircraftConfig F16 {
    /* mass_loaded       */ 12000.0,
    /* wing_area         */ 27.87,
    /* aspect_ratio      */ 3.55,
    /* cd0               */ 0.0175,
    /* oswald            */ 0.85,
    /* cl_alpha           */ 0.08,
    /* cl_max            */ 1.6,
    /* thrust_mil        */ 79000.0,
    /* thrust_ab         */ 127000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(25.0),
    /* max_roll_rate_rad */ deg2rad(280.0),
    /* max_pitch_rate_rad*/ deg2rad(30.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig MIG29 {
    /* mass_loaded       */ 15000.0,
    /* wing_area         */ 38.0,
    /* aspect_ratio      */ 3.5,
    /* cd0               */ 0.020,
    /* oswald            */ 0.82,
    /* cl_alpha           */ 0.075,
    /* cl_max            */ 1.4,
    /* thrust_mil        */ 81000.0,
    /* thrust_ab         */ 110000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(28.0),
    /* max_roll_rate_rad */ deg2rad(260.0),
    /* max_pitch_rate_rad*/ deg2rad(28.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig AWACS {
    /* mass_loaded       */ 147000.0,
    /* wing_area         */ 283.0,
    /* aspect_ratio      */ 7.7,
    /* cd0               */ 0.030,
    /* oswald            */ 0.80,
    /* cl_alpha           */ 0.06,
    /* cl_max            */ 1.4,
    /* thrust_mil        */ 372000.0,
    /* thrust_ab         */ 372000.0,
    /* max_g             */ 2.5,
    /* max_aoa_rad       */ deg2rad(14.0),
    /* max_roll_rate_rad */ deg2rad(45.0),
    /* max_pitch_rate_rad*/ deg2rad(10.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig F15 {
    /* mass_loaded       */ 24500.0,
    /* wing_area         */ 56.5,
    /* aspect_ratio      */ 3.0,
    /* cd0               */ 0.019,
    /* oswald            */ 0.82,
    /* cl_alpha           */ 0.075,
    /* cl_max            */ 1.5,
    /* thrust_mil        */ 130000.0,
    /* thrust_ab         */ 210000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(30.0),
    /* max_roll_rate_rad */ deg2rad(280.0),
    /* max_pitch_rate_rad*/ deg2rad(30.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig SU27 {
    /* mass_loaded       */ 23430.0,
    /* wing_area         */ 62.0,
    /* aspect_ratio      */ 3.5,
    /* cd0               */ 0.021,
    /* oswald            */ 0.82,
    /* cl_alpha           */ 0.075,
    /* cl_max            */ 1.5,
    /* thrust_mil        */ 152000.0,
    /* thrust_ab         */ 245000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(30.0),
    /* max_roll_rate_rad */ deg2rad(270.0),
    /* max_pitch_rate_rad*/ deg2rad(28.0),
    /* idle_thrust_frac  */ 0.05
};

// ---------------------------------------------------------------------------
// Lookup by lowercase name; returns F16 for unknown names.
// ---------------------------------------------------------------------------

inline const AircraftConfig& get_aircraft_config(const std::string& name) {
    if (name == "f16")   return F16;
    if (name == "mig29") return MIG29;
    if (name == "awacs") return AWACS;
    if (name == "f15")   return F15;
    if (name == "su27")  return SU27;
    return F16;  // default
}

} // namespace sim::mc

#endif // SIM_MC_AIRCRAFT_CONFIGS_HPP
