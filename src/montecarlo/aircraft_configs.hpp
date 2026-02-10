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

inline const AircraftConfig F22 {
    /* mass_loaded       */ 29300.0,
    /* wing_area         */ 78.0,
    /* aspect_ratio      */ 2.36,
    /* cd0               */ 0.015,
    /* oswald            */ 0.80,
    /* cl_alpha           */ 0.075,
    /* cl_max            */ 1.4,
    /* thrust_mil        */ 156000.0,
    /* thrust_ab         */ 312000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(60.0),
    /* max_roll_rate_rad */ deg2rad(300.0),
    /* max_pitch_rate_rad*/ deg2rad(40.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig F35 {
    /* mass_loaded       */ 22470.0,
    /* wing_area         */ 42.7,
    /* aspect_ratio      */ 2.68,
    /* cd0               */ 0.015,
    /* oswald            */ 0.78,
    /* cl_alpha           */ 0.07,
    /* cl_max            */ 1.3,
    /* thrust_mil        */ 125000.0,
    /* thrust_ab         */ 191000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(50.0),
    /* max_roll_rate_rad */ deg2rad(280.0),
    /* max_pitch_rate_rad*/ deg2rad(30.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig F18 {
    /* mass_loaded       */ 21320.0,
    /* wing_area         */ 46.45,
    /* aspect_ratio      */ 4.0,
    /* cd0               */ 0.020,
    /* oswald            */ 0.82,
    /* cl_alpha           */ 0.08,
    /* cl_max            */ 1.5,
    /* thrust_mil        */ 124000.0,
    /* thrust_ab         */ 190000.0,
    /* max_g             */ 7.5,
    /* max_aoa_rad       */ deg2rad(35.0),
    /* max_roll_rate_rad */ deg2rad(260.0),
    /* max_pitch_rate_rad*/ deg2rad(28.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig A10 {
    /* mass_loaded       */ 14865.0,
    /* wing_area         */ 47.01,
    /* aspect_ratio      */ 6.54,
    /* cd0               */ 0.032,
    /* oswald            */ 0.85,
    /* cl_alpha           */ 0.09,
    /* cl_max            */ 1.8,
    /* thrust_mil        */ 40000.0,
    /* thrust_ab         */ 40000.0,   // no afterburner
    /* max_g             */ 7.33,
    /* max_aoa_rad       */ deg2rad(20.0),
    /* max_roll_rate_rad */ deg2rad(180.0),
    /* max_pitch_rate_rad*/ deg2rad(20.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig SU35 {
    /* mass_loaded       */ 25300.0,
    /* wing_area         */ 62.0,
    /* aspect_ratio      */ 3.78,
    /* cd0               */ 0.020,
    /* oswald            */ 0.83,
    /* cl_alpha           */ 0.08,
    /* cl_max            */ 1.5,
    /* thrust_mil        */ 172000.0,
    /* thrust_ab         */ 286000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(30.0),
    /* max_roll_rate_rad */ deg2rad(280.0),
    /* max_pitch_rate_rad*/ deg2rad(30.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig SU57 {
    /* mass_loaded       */ 25000.0,
    /* wing_area         */ 78.8,
    /* aspect_ratio      */ 2.52,
    /* cd0               */ 0.015,
    /* oswald            */ 0.80,
    /* cl_alpha           */ 0.075,
    /* cl_max            */ 1.4,
    /* thrust_mil        */ 176000.0,
    /* thrust_ab         */ 360000.0,
    /* max_g             */ 9.0,
    /* max_aoa_rad       */ deg2rad(60.0),
    /* max_roll_rate_rad */ deg2rad(270.0),
    /* max_pitch_rate_rad*/ deg2rad(35.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig B2 {
    /* mass_loaded       */ 152600.0,
    /* wing_area         */ 478.0,
    /* aspect_ratio      */ 5.74,
    /* cd0               */ 0.018,
    /* oswald            */ 0.90,
    /* cl_alpha           */ 0.06,
    /* cl_max            */ 1.2,
    /* thrust_mil        */ 340000.0,
    /* thrust_ab         */ 340000.0,   // no afterburner
    /* max_g             */ 2.5,
    /* max_aoa_rad       */ deg2rad(15.0),
    /* max_roll_rate_rad */ deg2rad(60.0),
    /* max_pitch_rate_rad*/ deg2rad(10.0),
    /* idle_thrust_frac  */ 0.04
};

inline const AircraftConfig BOMBER_FAST {
    /* mass_loaded       */ 148000.0,
    /* wing_area         */ 181.0,
    /* aspect_ratio      */ 9.6,
    /* cd0               */ 0.020,
    /* oswald            */ 0.82,
    /* cl_alpha           */ 0.07,
    /* cl_max            */ 1.3,
    /* thrust_mil        */ 360000.0,
    /* thrust_ab         */ 600000.0,
    /* max_g             */ 3.0,
    /* max_aoa_rad       */ deg2rad(18.0),
    /* max_roll_rate_rad */ deg2rad(90.0),
    /* max_pitch_rate_rad*/ deg2rad(12.0),
    /* idle_thrust_frac  */ 0.04
};

inline const AircraftConfig C17 {
    /* mass_loaded       */ 265350.0,
    /* wing_area         */ 353.0,
    /* aspect_ratio      */ 7.57,
    /* cd0               */ 0.022,
    /* oswald            */ 0.82,
    /* cl_alpha           */ 0.085,
    /* cl_max            */ 1.8,
    /* thrust_mil        */ 480000.0,
    /* thrust_ab         */ 480000.0,   // no afterburner
    /* max_g             */ 2.5,
    /* max_aoa_rad       */ deg2rad(15.0),
    /* max_roll_rate_rad */ deg2rad(45.0),
    /* max_pitch_rate_rad*/ deg2rad(8.0),
    /* idle_thrust_frac  */ 0.04
};

inline const AircraftConfig TRANSPORT {
    /* mass_loaded       */ 70300.0,
    /* wing_area         */ 162.1,
    /* aspect_ratio      */ 10.08,
    /* cd0               */ 0.025,
    /* oswald            */ 0.85,
    /* cl_alpha           */ 0.09,
    /* cl_max            */ 2.0,
    /* thrust_mil        */ 64000.0,
    /* thrust_ab         */ 64000.0,    // no afterburner
    /* max_g             */ 2.5,
    /* max_aoa_rad       */ deg2rad(15.0),
    /* max_roll_rate_rad */ deg2rad(60.0),
    /* max_pitch_rate_rad*/ deg2rad(10.0),
    /* idle_thrust_frac  */ 0.05
};

inline const AircraftConfig MQ9 {
    /* mass_loaded       */ 4760.0,
    /* wing_area         */ 38.0,
    /* aspect_ratio      */ 10.53,
    /* cd0               */ 0.020,
    /* oswald            */ 0.88,
    /* cl_alpha           */ 0.09,
    /* cl_max            */ 1.6,
    /* thrust_mil        */ 6700.0,
    /* thrust_ab         */ 6700.0,     // turboprop, no AB
    /* max_g             */ 3.0,
    /* max_aoa_rad       */ deg2rad(15.0),
    /* max_roll_rate_rad */ deg2rad(60.0),
    /* max_pitch_rate_rad*/ deg2rad(10.0),
    /* idle_thrust_frac  */ 0.06
};

inline const AircraftConfig RQ4 {
    /* mass_loaded       */ 14628.0,
    /* wing_area         */ 50.0,
    /* aspect_ratio      */ 31.84,
    /* cd0               */ 0.015,
    /* oswald            */ 0.92,
    /* cl_alpha           */ 0.10,
    /* cl_max            */ 1.5,
    /* thrust_mil        */ 35000.0,
    /* thrust_ab         */ 35000.0,    // turbofan, no AB
    /* max_g             */ 2.0,
    /* max_aoa_rad       */ deg2rad(12.0),
    /* max_roll_rate_rad */ deg2rad(30.0),
    /* max_pitch_rate_rad*/ deg2rad(8.0),
    /* idle_thrust_frac  */ 0.05
};

// ---------------------------------------------------------------------------
// Lookup by lowercase name; returns F16 for unknown names.
// ---------------------------------------------------------------------------

inline const AircraftConfig& get_aircraft_config(const std::string& name) {
    if (name == "f16")         return F16;
    if (name == "f15")         return F15;
    if (name == "f22")         return F22;
    if (name == "f35")         return F35;
    if (name == "f18")         return F18;
    if (name == "a10")         return A10;
    if (name == "mig29")       return MIG29;
    if (name == "su27")        return SU27;
    if (name == "su35")        return SU35;
    if (name == "su57")        return SU57;
    if (name == "awacs")       return AWACS;
    if (name == "bomber")      return B2;
    if (name == "b2")          return B2;
    if (name == "bomber_fast") return BOMBER_FAST;
    if (name == "transport")   return TRANSPORT;
    if (name == "c17")         return C17;
    if (name == "drone_male")  return MQ9;
    if (name == "mq9")         return MQ9;
    if (name == "drone_hale")  return RQ4;
    if (name == "rq4")         return RQ4;
    return F16;  // default
}

} // namespace sim::mc

#endif // SIM_MC_AIRCRAFT_CONFIGS_HPP
