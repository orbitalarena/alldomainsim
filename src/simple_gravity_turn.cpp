/**
 * Simple Gravity Turn + Apogee Circularization
 *
 * Three-stage ascent:
 *   S1+S2: Gravity turn to elliptical transfer orbit (137 x 10324 km)
 *   S3:    Prograde burn at apogee to circularize (raise perigee)
 *
 * S3 fits inside the original 4500 kg payload mass so the ascent
 * trajectory is unchanged from the two-stage version.
 *
 * Outputs gravity_turn_data.json for Cesium visualization.
 */

#include "physics/gravity_utils.hpp"
#include "physics/atmosphere_model.hpp"
#include "physics/orbital_elements.hpp"
#include "coordinate/time_utils.hpp"
#include "core/state_vector.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <vector>
#include <fstream>
#include <string>

static constexpr double PI = 3.14159265358979323846;
static constexpr double DEG = PI / 180.0;
static constexpr double G0 = 9.80665;
static constexpr double RE = 6378137.0;            // m
static constexpr double MU = 3.986004418e14;        // m^3/s^2
static constexpr double EARTH_OMEGA = 7.2921159e-5; // rad/s

// --------------- Vehicle definition ---------------
struct Stage {
    double dry_mass;         // kg
    double propellant_mass;  // kg
    double thrust;           // N
    double isp_sl;           // s
    double isp_vac;          // s

    double effective_isp(double alt) const {
        double f = alt / 40000.0;
        if (f < 0.0) f = 0.0;
        if (f > 1.0) f = 1.0;
        return isp_sl + (isp_vac - isp_sl) * f;
    }

    double mass_flow(double alt) const {
        return thrust / (effective_isp(alt) * G0);
    }
};

// --------------- Helper math ---------------
struct V3 {
    double x, y, z;
    double mag() const { return std::sqrt(x*x + y*y + z*z); }
    V3 operator+(const V3& o) const { return {x+o.x, y+o.y, z+o.z}; }
    V3 operator-(const V3& o) const { return {x-o.x, y-o.y, z-o.z}; }
    V3 operator*(double s) const { return {x*s, y*s, z*s}; }
    double dot(const V3& o) const { return x*o.x + y*o.y + z*o.z; }
    V3 normalized() const {
        double m = mag();
        if (m < 1e-12) return {0,0,0};
        return {x/m, y/m, z/m};
    }
};

// --------------- Propagation state ---------------
struct State {
    V3 pos;        // ECI [m]
    V3 vel;        // ECI [m/s]
    double mass;   // kg
    double t;      // time since launch [s]
    int stage;     // 0-based
    bool burning;
    double fuel[3]; // propellant remaining per stage
};

// --------------- Trajectory recording ---------------
struct TrajPoint {
    double time;
    V3 pos;
    int phase; // 0=S1, 1=S2, 2=coast, 3=S3burn, 4=orbit
};

struct TrajEvent {
    double time;
    std::string name;
    double alt_km;
    double vel_ms;
};

// --------------- Functions ---------------

static constexpr double R_POLAR = 6356752.314; // m

double local_earth_radius(const V3& pos) {
    double r = pos.mag();
    if (r < 1.0) return RE;
    double sin_lat = pos.z / r;
    double cos_lat = std::sqrt(1.0 - sin_lat * sin_lat);
    double a2 = RE * RE;
    double b2 = R_POLAR * R_POLAR;
    double num = (a2 * cos_lat) * (a2 * cos_lat) + (b2 * sin_lat) * (b2 * sin_lat);
    double den = (RE * cos_lat) * (RE * cos_lat) + (R_POLAR * sin_lat) * (R_POLAR * sin_lat);
    return std::sqrt(num / den);
}

double altitude(const V3& pos) {
    return pos.mag() - local_earth_radius(pos);
}

V3 gravity_j2(const V3& pos) {
    sim::Vec3 p;
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    sim::Vec3 a = sim::gravity::body_acceleration(p, sim::gravity::BodyConstants::EARTH, true);
    return {a.x, a.y, a.z};
}

V3 earth_relative_vel(const V3& pos, const V3& vel) {
    return {vel.x + EARTH_OMEGA * pos.y,
            vel.y - EARTH_OMEGA * pos.x,
            vel.z};
}

V3 horizontal_east(const V3& pos) {
    V3 raw_east = {-pos.y, pos.x, 0.0};
    V3 r_hat = pos.normalized();
    double dot = raw_east.dot(r_hat);
    V3 east_perp = raw_east - r_hat * dot;
    return east_perp.normalized();
}

// Ascent steering (S1 and S2 only)
V3 compute_thrust_direction_ascent(const State& s) {
    double alt = altitude(s.pos);
    V3 r_hat = s.pos.normalized();

    if (alt < 500.0) {
        return r_hat;
    }
    else if (alt < 50000.0) {
        double f = (alt - 500.0) / (50000.0 - 500.0);
        V3 east_hat = horizontal_east(s.pos);
        double theta = f * (PI / 2.0);
        V3 t_dir = r_hat * std::cos(theta) + east_hat * std::sin(theta);
        return t_dir.normalized();
    }
    else {
        return s.vel.normalized();
    }
}

struct Derivs {
    V3 acc;
    double mdot;
};

// thrust_dir_override: if non-zero, use this instead of ascent steering
Derivs compute_derivs(const State& s, const std::vector<Stage>& stages,
                       double Cd, double area, V3 thrust_dir_override = {0,0,0}) {
    Derivs d;
    d.mdot = 0.0;

    V3 a_grav = gravity_j2(s.pos);

    V3 a_thrust = {0, 0, 0};
    if (s.burning && s.stage < (int)stages.size()) {
        const Stage& stg = stages[s.stage];
        double alt = altitude(s.pos);
        if (alt < 0) alt = 0;
        double isp = stg.effective_isp(alt);
        double mdot = stg.thrust / (isp * G0);
        double a_mag = stg.thrust / s.mass;

        V3 t_dir;
        if (thrust_dir_override.mag() > 0.5) {
            t_dir = thrust_dir_override;
        } else {
            t_dir = compute_thrust_direction_ascent(s);
        }
        a_thrust = t_dir * a_mag;
        d.mdot = -mdot;
    }

    V3 a_drag = {0, 0, 0};
    double alt = altitude(s.pos);
    if (alt >= 0 && alt < 200000.0) {
        V3 v_rel = earth_relative_vel(s.pos, s.vel);
        double rho = sim::AtmosphereModel::get_density_extended(alt);
        if (rho > 1e-15) {
            double v_rel_mag = v_rel.mag();
            if (v_rel_mag > 1.0) {
                double drag_fac = 0.5 * rho * v_rel_mag * Cd * area / s.mass;
                a_drag = v_rel * (-drag_fac);
            }
        }
    }

    d.acc = a_grav + a_thrust + a_drag;
    return d;
}

State rk4_step(const State& s, const std::vector<Stage>& stages,
               double Cd, double area, double dt, V3 thrust_dir = {0,0,0}) {
    Derivs k1 = compute_derivs(s, stages, Cd, area, thrust_dir);

    State s2 = s;
    s2.pos = s.pos + s.vel * (dt * 0.5);
    s2.vel = s.vel + k1.acc * (dt * 0.5);
    s2.mass = s.mass + k1.mdot * dt * 0.5;
    s2.t = s.t + dt * 0.5;

    Derivs k2 = compute_derivs(s2, stages, Cd, area, thrust_dir);

    State s3 = s;
    s3.pos = s.pos + s2.vel * (dt * 0.5);
    s3.vel = s.vel + k2.acc * (dt * 0.5);
    s3.mass = s.mass + k2.mdot * dt * 0.5;
    s3.t = s.t + dt * 0.5;

    Derivs k3 = compute_derivs(s3, stages, Cd, area, thrust_dir);

    State s4 = s;
    s4.pos = s.pos + s3.vel * dt;
    s4.vel = s.vel + k3.acc * dt;
    s4.mass = s.mass + k3.mdot * dt;
    s4.t = s.t + dt;

    Derivs k4 = compute_derivs(s4, stages, Cd, area, thrust_dir);

    State out = s;
    out.pos.x = s.pos.x + (dt / 6.0) * (s.vel.x + 2.0*s2.vel.x + 2.0*s3.vel.x + s4.vel.x);
    out.pos.y = s.pos.y + (dt / 6.0) * (s.vel.y + 2.0*s2.vel.y + 2.0*s3.vel.y + s4.vel.y);
    out.pos.z = s.pos.z + (dt / 6.0) * (s.vel.z + 2.0*s2.vel.z + 2.0*s3.vel.z + s4.vel.z);
    out.vel.x = s.vel.x + (dt / 6.0) * (k1.acc.x + 2.0*k2.acc.x + 2.0*k3.acc.x + k4.acc.x);
    out.vel.y = s.vel.y + (dt / 6.0) * (k1.acc.y + 2.0*k2.acc.y + 2.0*k3.acc.y + k4.acc.y);
    out.vel.z = s.vel.z + (dt / 6.0) * (k1.acc.z + 2.0*k2.acc.z + 2.0*k3.acc.z + k4.acc.z);
    out.mass = s.mass + (dt / 6.0) * (k1.mdot + 2.0*k2.mdot + 2.0*k3.mdot + k4.mdot);
    out.t = s.t + dt;

    return out;
}

void get_orbit(const V3& pos, const V3& vel, double& sma_km, double& ecc,
               double& inc_deg, double& peri_km, double& apo_km) {
    sim::StateVector sv;
    sv.position.x = pos.x; sv.position.y = pos.y; sv.position.z = pos.z;
    sv.velocity.x = vel.x; sv.velocity.y = vel.y; sv.velocity.z = vel.z;

    sim::OrbitalElements oe = sim::OrbitalMechanics::state_to_elements(sv);
    sma_km = oe.semi_major_axis / 1000.0;
    ecc = oe.eccentricity;
    inc_deg = oe.inclination / DEG;
    peri_km = sma_km * (1.0 - ecc) - RE / 1000.0;
    apo_km  = sma_km * (1.0 + ecc) - RE / 1000.0;
}

void print_elements(const V3& pos, const V3& vel) {
    sim::StateVector sv;
    sv.position.x = pos.x; sv.position.y = pos.y; sv.position.z = pos.z;
    sv.velocity.x = vel.x; sv.velocity.y = vel.y; sv.velocity.z = vel.z;

    sim::OrbitalElements oe = sim::OrbitalMechanics::state_to_elements(sv);
    double sma_km = oe.semi_major_axis / 1000.0;
    double peri_km = sma_km * (1.0 - oe.eccentricity) - RE / 1000.0;
    double apo_km  = sma_km * (1.0 + oe.eccentricity) - RE / 1000.0;

    std::cout << "  SMA:          " << std::fixed << std::setprecision(1) << sma_km << " km" << std::endl;
    std::cout << "  Eccentricity: " << std::setprecision(6) << oe.eccentricity << std::endl;
    std::cout << "  Inclination:  " << std::setprecision(2) << oe.inclination / DEG << " deg" << std::endl;
    std::cout << "  Periapsis:    " << std::setprecision(1) << peri_km << " km alt" << std::endl;
    std::cout << "  Apoapsis:     " << std::setprecision(1) << apo_km << " km alt" << std::endl;
    std::cout << "  RAAN:         " << std::setprecision(2) << oe.raan / DEG << " deg" << std::endl;
    std::cout << "  Arg Peri:     " << std::setprecision(2) << oe.arg_periapsis / DEG << " deg" << std::endl;

    double v_mag = vel.mag();
    double r_mag = pos.mag();
    double energy = 0.5 * v_mag * v_mag - MU / r_mag;
    std::cout << "  Spec Energy:  " << std::setprecision(0) << energy / 1e6 << " MJ/kg" << std::endl;

    double v_circ = std::sqrt(MU / r_mag);
    std::cout << "  V_circular:   " << std::setprecision(0) << v_circ << " m/s (at current r)" << std::endl;
    std::cout << "  V_actual:     " << v_mag << " m/s" << std::endl;
    std::cout << "  V_excess:     " << std::showpos << (v_mag - v_circ) << std::noshowpos << " m/s" << std::endl;
}

// Convert ECI position to geodetic (geocentric approximation)
void eci_to_geo(const V3& pos, double gmst0, double t,
                double& lat_deg, double& lon_deg, double& alt_m) {
    double gmst = gmst0 + EARTH_OMEGA * t;
    double cg = std::cos(gmst), sg = std::sin(gmst);
    double xe = pos.x * cg + pos.y * sg;
    double ye = -pos.x * sg + pos.y * cg;
    lon_deg = std::atan2(ye, xe) / DEG;
    lat_deg = std::atan2(pos.z, std::sqrt(xe*xe + ye*ye)) / DEG;
    alt_m = altitude(pos);
}

// Write JSON trajectory file for Cesium visualization
void write_trajectory_json(const std::string& filename,
                           const std::vector<TrajPoint>& trajectory,
                           const std::vector<TrajEvent>& events,
                           double gmst0, double epoch_jd,
                           double total_mass_kg, double payload_kg,
                           double dv_thrust, double dv_gravity, double dv_drag, double dv_s3,
                           double final_sma_km, double final_ecc, double final_inc_deg,
                           double final_peri_km, double final_apo_km) {
    std::ofstream ofs(filename);
    if (!ofs) {
        std::cerr << "ERROR: Cannot open " << filename << " for writing" << std::endl;
        return;
    }

    ofs << std::setprecision(10);

    ofs << "{\n";
    ofs << "  \"metadata\": {\n";
    ofs << "    \"scenario\": \"Three-Stage Gravity Turn + Apogee Circularization\",\n";
    ofs << "    \"epoch_jd\": " << std::fixed << std::setprecision(1) << epoch_jd << ",\n";
    ofs << "    \"epoch_iso\": \"2024-01-25T12:00:00Z\",\n";
    ofs << "    \"duration\": " << std::setprecision(1) << trajectory.back().time << ",\n";

    // Launch site
    ofs << "    \"launch_site\": {\"lat\": 28.5623, \"lon\": -80.5774, \"name\": \"Cape Canaveral\"},\n";

    // Vehicle info
    ofs << "    \"vehicle\": {\n";
    ofs << "      \"total_mass_kg\": " << std::setprecision(0) << total_mass_kg << ",\n";
    ofs << "      \"payload_kg\": " << payload_kg << ",\n";
    ofs << "      \"s1\": \"4.5 MN, 280t prop, Isp 295/320s\",\n";
    ofs << "      \"s2\": \"450 kN, 28t prop, Isp 320/355s\",\n";
    ofs << "      \"s3\": \"100 kN, 1.55t prop, Isp 320s (apogee kick)\"\n";
    ofs << "    },\n";

    // Events
    ofs << "    \"events\": [\n";
    for (size_t i = 0; i < events.size(); i++) {
        ofs << "      {\"time\": " << std::setprecision(1) << events[i].time
            << ", \"name\": \"" << events[i].name << "\""
            << ", \"alt_km\": " << std::setprecision(1) << events[i].alt_km
            << ", \"vel_ms\": " << std::setprecision(0) << events[i].vel_ms
            << "}";
        if (i + 1 < events.size()) ofs << ",";
        ofs << "\n";
    }
    ofs << "    ],\n";

    // Delta-V budget
    ofs << "    \"delta_v\": {\n";
    ofs << "      \"ascent_thrust\": " << std::setprecision(0) << dv_thrust << ",\n";
    ofs << "      \"gravity_loss\": " << dv_gravity << ",\n";
    ofs << "      \"drag_loss\": " << dv_drag << ",\n";
    ofs << "      \"s3_burn\": " << dv_s3 << ",\n";
    ofs << "      \"total\": " << (dv_thrust + dv_s3) << "\n";
    ofs << "    },\n";

    // Final orbit
    ofs << "    \"final_orbit\": {\n";
    ofs << "      \"sma_km\": " << std::setprecision(1) << final_sma_km << ",\n";
    ofs << "      \"eccentricity\": " << std::setprecision(6) << final_ecc << ",\n";
    ofs << "      \"inclination_deg\": " << std::setprecision(2) << final_inc_deg << ",\n";
    ofs << "      \"periapsis_km\": " << std::setprecision(1) << final_peri_km << ",\n";
    ofs << "      \"apoapsis_km\": " << std::setprecision(1) << final_apo_km << "\n";
    ofs << "    }\n";
    ofs << "  },\n";

    // Satellites array (one entry for the launch vehicle)
    ofs << "  \"satellites\": [\n";
    ofs << "    {\n";
    ofs << "      \"name\": \"Launch Vehicle\",\n";
    ofs << "      \"id\": 0,\n";
    ofs << "      \"color\": \"#FF6600\",\n";
    ofs << "      \"positions\": [\n";

    for (size_t i = 0; i < trajectory.size(); i++) {
        const TrajPoint& p = trajectory[i];
        double lat, lon, alt;
        eci_to_geo(p.pos, gmst0, p.time, lat, lon, alt);

        ofs << "        {\"time\": " << std::setprecision(1) << p.time
            << ", \"phase\": " << p.phase
            << ", \"eci\": {\"x\": " << std::setprecision(2) << p.pos.x
            << ", \"y\": " << p.pos.y
            << ", \"z\": " << p.pos.z << "}"
            << ", \"geo\": {\"lat\": " << std::setprecision(4) << lat
            << ", \"lon\": " << lon
            << ", \"alt\": " << std::setprecision(0) << alt << "}"
            << "}";
        if (i + 1 < trajectory.size()) ofs << ",";
        ofs << "\n";
    }

    ofs << "      ]\n";
    ofs << "    }\n";
    ofs << "  ]\n";
    ofs << "}\n";

    ofs.close();
    std::cout << "Wrote " << trajectory.size() << " trajectory points to " << filename << std::endl;
}

int main() {
    std::cout << "=== Three-Stage Gravity Turn + Apogee Circularization ===" << std::endl;
    std::cout << "S1+S2: Ascent to elliptical orbit" << std::endl;
    std::cout << "S3:    Prograde burn at apogee to raise perigee" << std::endl;
    std::cout << std::endl;

    // ---- Vehicle ----
    Stage s1;
    s1.dry_mass = 20000.0;
    s1.propellant_mass = 280000.0;
    s1.thrust = 4500000.0;
    s1.isp_sl = 295.0;
    s1.isp_vac = 320.0;

    Stage s2;
    s2.dry_mass = 3500.0;
    s2.propellant_mass = 28000.0;
    s2.thrust = 450000.0;
    s2.isp_sl = 320.0;
    s2.isp_vac = 355.0;

    // S3: Apogee kick stage — fits inside original 4500 kg payload
    // Sized for ~1300 m/s (enough to circularize ~1223 m/s + margin)
    // High thrust (100 kN) for a shorter, more impulsive burn
    // Tsiolkovsky: 1300 = 320*9.807*ln(m0/mf) -> m0/mf = 1.514
    // m0 = 4500, mf = 4500/1.514 = 2972 -> prop = 1528
    Stage s3;
    s3.dry_mass = 150.0;
    s3.propellant_mass = 1550.0;
    s3.thrust = 100000.0;      // 100 kN (short impulsive burn)
    s3.isp_sl = 320.0;         // irrelevant — vacuum only
    s3.isp_vac = 320.0;

    double payload = 2800.0;    // actual payload after S3
    // Total: 150 + 1550 + 2800 = 4500 kg = same as before
    double Cd = 0.4;
    double area = 100.0; // m^2

    std::vector<Stage> stages = {s1, s2, s3};

    // Total mass is the same as before: S1+S2+4500 = 336t
    // The 4500 kg "payload" is now S3(200+2300) + actual payload(2000) = 4500 kg
    double total_mass = s1.dry_mass + s1.propellant_mass
                      + s2.dry_mass + s2.propellant_mass
                      + s3.dry_mass + s3.propellant_mass + payload;

    std::cout << "Vehicle:" << std::endl;
    std::cout << "  S1: " << s1.thrust/1e6 << " MN, " << s1.propellant_mass/1e3 << "t prop, Isp "
              << s1.isp_sl << "/" << s1.isp_vac << "s" << std::endl;
    std::cout << "  S2: " << s2.thrust/1e3 << " kN, " << s2.propellant_mass/1e3 << "t prop, Isp "
              << s2.isp_sl << "/" << s2.isp_vac << "s" << std::endl;
    std::cout << "  S3: " << s3.thrust/1e3 << " kN, " << s3.propellant_mass/1e3 << "t prop, Isp "
              << s3.isp_vac << "s (apogee kick)" << std::endl;
    std::cout << "  Payload: " << payload/1e3 << "t" << std::endl;
    std::cout << "  Total mass: " << total_mass/1e3 << "t (same as before)" << std::endl;

    // Ideal delta-V
    double m0 = total_mass;
    double m_after_s1 = m0 - s1.propellant_mass;
    double dv1 = s1.isp_vac * G0 * std::log(m0 / m_after_s1);
    double m_s2_start = m_after_s1 - s1.dry_mass;
    double m_after_s2 = m_s2_start - s2.propellant_mass;
    double dv2 = s2.isp_vac * G0 * std::log(m_s2_start / m_after_s2);
    double m_s3_start = s3.dry_mass + s3.propellant_mass + payload; // after S2 dry jettison
    double m_after_s3 = m_s3_start - s3.propellant_mass;
    double dv3 = s3.isp_vac * G0 * std::log(m_s3_start / m_after_s3);
    std::cout << std::fixed;
    std::cout << "  Ideal dV: S1=" << std::setprecision(0) << dv1
              << " + S2=" << dv2
              << " + S3=" << dv3
              << " = " << (dv1+dv2+dv3) << " m/s" << std::endl;

    // ---- Initial state from Cape Canaveral ----
    double epoch_jd = 2460335.0;
    double lat_rad = 28.5623 * DEG;
    double lon_rad = -80.5774 * DEG;

    double a_wgs = RE;
    double f_wgs = 1.0 / 298.257223563;
    double e2 = 2.0 * f_wgs - f_wgs * f_wgs;
    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double N_wgs = a_wgs / std::sqrt(1.0 - e2 * sin_lat * sin_lat);

    double x_ecef = N_wgs * cos_lat * std::cos(lon_rad);
    double y_ecef = N_wgs * cos_lat * std::sin(lon_rad);
    double z_ecef = N_wgs * (1.0 - e2) * sin_lat;

    double gmst = sim::TimeUtils::compute_gmst(epoch_jd);
    double cos_g = std::cos(gmst);
    double sin_g = std::sin(gmst);

    V3 pos0 = {x_ecef * cos_g - y_ecef * sin_g,
               x_ecef * sin_g + y_ecef * cos_g,
               z_ecef};
    V3 vel0 = {-EARTH_OMEGA * pos0.y,
                EARTH_OMEGA * pos0.x,
                0.0};

    State state;
    state.pos = pos0;
    state.vel = vel0;
    state.mass = total_mass;
    state.t = 0.0;
    state.stage = 0;
    state.burning = true;
    state.fuel[0] = s1.propellant_mass;
    state.fuel[1] = s2.propellant_mass;
    state.fuel[2] = s3.propellant_mass;

    // ---- Trajectory recording ----
    double gmst0 = gmst; // save for geodetic conversion
    std::vector<TrajPoint> trajectory;
    std::vector<TrajEvent> events;
    double last_record = -10.0;

    // Record initial position
    trajectory.push_back({0.0, pos0, 0});
    events.push_back({0.0, "Launch", 0.0, vel0.mag()});

    std::cout << std::endl;

    // ==================================================================
    //  PHASE 1 & 2: S1 + S2 ASCENT (identical trajectory to before)
    // ==================================================================
    double dt_atmo = 0.5;
    double dt_vac = 2.0;
    double max_time = 1200.0;

    std::cout << "--- ASCENT (S1 + S2) ---" << std::endl;
    std::cout << std::setw(6) << "t[s]"
              << std::setw(10) << "alt[km]"
              << std::setw(9) << "vel[m/s]"
              << std::setw(10) << "vr[m/s]"
              << std::setw(10) << "vh[m/s]"
              << std::setw(9) << "mass[t]"
              << std::setw(8) << "pitch"
              << std::setw(8) << "q[kPa]"
              << std::setw(7) << "stage"
              << std::endl;
    std::cout << std::string(77, '-') << std::endl;

    double last_print = -10.0;
    double dv_gravity_loss = 0.0;
    double dv_drag_loss = 0.0;
    double dv_thrust_total = 0.0;

    while (state.t < max_time && (state.burning || state.stage < 2)) {
        double alt = altitude(state.pos);
        double dt = (alt < 100000.0) ? dt_atmo : dt_vac;

        // Record trajectory (every 2s during ascent)
        if (state.t - last_record >= 1.99) {
            last_record = state.t;
            trajectory.push_back({state.t, state.pos, state.stage});
        }

        // Print every 10 seconds
        if (state.t - last_print >= 9.99) {
            last_print = state.t;

            V3 r_hat = state.pos.normalized();
            double v_radial = state.vel.dot(r_hat);
            double v_horiz = std::sqrt(std::max(0.0, state.vel.dot(state.vel) - v_radial * v_radial));

            V3 t_dir = compute_thrust_direction_ascent(state);
            double pitch_from_vert = std::acos(std::max(-1.0, std::min(1.0, t_dir.dot(r_hat))));

            V3 v_rel = earth_relative_vel(state.pos, state.vel);
            double rho = (alt >= 0 && alt < 200000) ? sim::AtmosphereModel::get_density_extended(alt) : 0.0;
            double q = 0.5 * rho * v_rel.mag() * v_rel.mag();

            std::cout << std::fixed
                      << std::setw(6) << std::setprecision(0) << state.t
                      << std::setw(10) << std::setprecision(1) << alt / 1000.0
                      << std::setw(9) << std::setprecision(0) << state.vel.mag()
                      << std::setw(10) << std::setprecision(0) << v_radial
                      << std::setw(10) << std::setprecision(0) << v_horiz
                      << std::setw(9) << std::setprecision(2) << state.mass / 1000.0
                      << std::setw(8) << std::setprecision(1) << pitch_from_vert / DEG << "\xC2\xB0"
                      << std::setw(8) << std::setprecision(2) << q / 1000.0
                      << std::setw(7) << (state.burning ? (state.stage == 0 ? "S1" : "S2") : "coast")
                      << std::endl;
        }

        // Check fuel depletion (S1 and S2 only during ascent)
        if (state.burning && state.stage < 2) {
            const Stage& stg = stages[state.stage];
            double mdot = stg.mass_flow(alt);
            double fuel_time = state.fuel[state.stage] / mdot;

            if (fuel_time <= dt) {
                double dt_burn = fuel_time;
                state = rk4_step(state, stages, Cd, area, dt_burn);
                state.fuel[state.stage] = 0.0;

                if (state.stage == 0) {
                    std::cout << "\n>>> STAGE 1 SEPARATION at t=" << std::setprecision(1)
                              << state.t << "s, alt=" << altitude(state.pos)/1000.0
                              << "km, vel=" << std::setprecision(0) << state.vel.mag() << " m/s <<<\n" << std::endl;
                    events.push_back({state.t, "S1 Separation", altitude(state.pos)/1000.0, state.vel.mag()});
                    trajectory.push_back({state.t, state.pos, 0});
                    state.mass -= s1.dry_mass;
                    state.stage = 1;
                } else if (state.stage == 1) {
                    std::cout << "\n>>> S2 BURNOUT at t=" << std::setprecision(1)
                              << state.t << "s, alt=" << altitude(state.pos)/1000.0
                              << "km, vel=" << std::setprecision(0) << state.vel.mag() << " m/s <<<\n" << std::endl;
                    events.push_back({state.t, "S2 Burnout", altitude(state.pos)/1000.0, state.vel.mag()});
                    trajectory.push_back({state.t, state.pos, 1});
                    state.burning = false;
                    // Jettison S2 dry mass for coast
                    state.mass -= s2.dry_mass;
                    state.stage = 2; // S3 is next, but not burning yet
                }
                continue;
            }
        }

        // Track losses during ascent burn
        if (state.burning && state.stage < 2) {
            const Stage& stg = stages[state.stage];
            double a_thrust_mag = stg.thrust / state.mass;

            V3 a_grav = gravity_j2(state.pos);
            V3 v_hat = state.vel.normalized();
            double grav_along_v = a_grav.dot(v_hat);
            if (grav_along_v < 0) {
                dv_gravity_loss += (-grav_along_v) * dt;
            }

            double alt_now = altitude(state.pos);
            if (alt_now >= 0 && alt_now < 200000) {
                V3 v_rel = earth_relative_vel(state.pos, state.vel);
                double rho = sim::AtmosphereModel::get_density_extended(alt_now);
                double v_rel_mag = v_rel.mag();
                if (rho > 1e-15 && v_rel_mag > 1.0) {
                    double drag_acc = 0.5 * rho * v_rel_mag * v_rel_mag * Cd * area / state.mass;
                    dv_drag_loss += drag_acc * dt;
                }
            }

            dv_thrust_total += a_thrust_mag * dt;
        }

        // Normal step
        State new_state = rk4_step(state, stages, Cd, area, dt);

        if (state.burning && state.stage < 2) {
            double fuel_used = state.mass - new_state.mass;
            new_state.fuel[state.stage] = state.fuel[state.stage] - fuel_used;
            if (new_state.fuel[state.stage] < 0) new_state.fuel[state.stage] = 0;
        }

        new_state.stage = state.stage;
        new_state.burning = state.burning;
        new_state.fuel[0] = state.fuel[0];
        new_state.fuel[1] = state.fuel[1];
        new_state.fuel[2] = state.fuel[2];
        if (state.burning && state.stage < 2) {
            double fuel_used = state.mass - new_state.mass;
            new_state.fuel[state.stage] = state.fuel[state.stage] - fuel_used;
        }
        state = new_state;

        if (altitude(state.pos) < -100.0) {
            std::cout << "*** CRASHED ***" << std::endl;
            return 1;
        }

        // Stop ascent loop once S2 is done
        if (!state.burning && state.stage >= 2) break;
    }

    // Print post-ascent orbit
    std::cout << "=== POST-ASCENT ORBIT (after S2 burnout, S2 dry jettisoned) ===" << std::endl;
    print_elements(state.pos, state.vel);
    std::cout << "  Coast mass: " << std::setprecision(1) << state.mass << " kg (S3 + payload)" << std::endl;

    std::cout << "\n=== Ascent Delta-V Budget ===" << std::endl;
    std::cout << "  Thrust delivered: " << std::setprecision(0) << dv_thrust_total << " m/s" << std::endl;
    std::cout << "  Gravity loss:     " << dv_gravity_loss << " m/s" << std::endl;
    std::cout << "  Drag loss:        " << dv_drag_loss << " m/s" << std::endl;
    std::cout << "  Net dV:           " << (dv_thrust_total - dv_gravity_loss - dv_drag_loss) << " m/s" << std::endl;

    // ==================================================================
    //  COAST TO APOGEE
    // ==================================================================
    std::cout << "\n--- COAST TO APOGEE ---" << std::endl;

    state.burning = false;
    double prev_rdot = state.vel.dot(state.pos.normalized());
    double coast_start = state.t;
    last_record = state.t - 100.0; // force first coast record

    while (state.t - coast_start < 20000.0) {
        double dt = 10.0; // 10s steps during coast
        State new_state = rk4_step(state, stages, Cd, area, dt);
        new_state.stage = state.stage;
        new_state.burning = false;
        new_state.fuel[0] = state.fuel[0];
        new_state.fuel[1] = state.fuel[1];
        new_state.fuel[2] = state.fuel[2];

        double rdot = new_state.vel.dot(new_state.pos.normalized());

        // Record trajectory (every 30s during coast)
        if (new_state.t - last_record >= 29.9) {
            last_record = new_state.t;
            trajectory.push_back({new_state.t, new_state.pos, 2});
        }

        // Print every 500s during coast
        if ((int)(new_state.t / 500.0) > (int)(state.t / 500.0)) {
            double alt_km = altitude(new_state.pos) / 1000.0;
            std::cout << "  t=" << std::setprecision(0) << new_state.t
                      << "s  alt=" << std::setprecision(1) << alt_km
                      << " km  vel=" << std::setprecision(0) << new_state.vel.mag()
                      << " m/s  rdot=" << std::setprecision(1) << rdot << " m/s"
                      << std::endl;
        }

        // Detect apogee: radial velocity crosses from positive to negative
        if (prev_rdot > 0.0 && rdot <= 0.0 && state.t - coast_start > 100.0) {
            // Interpolate to find exact apogee
            double frac = prev_rdot / (prev_rdot - rdot);
            double dt_apo = frac * dt;
            State apo_state = rk4_step(state, stages, Cd, area, dt_apo);
            apo_state.stage = state.stage;
            apo_state.burning = false;
            apo_state.fuel[0] = state.fuel[0];
            apo_state.fuel[1] = state.fuel[1];
            apo_state.fuel[2] = state.fuel[2];

            state = apo_state;
            double apo_alt = altitude(state.pos) / 1000.0;
            std::cout << "\n>>> APOGEE at t=" << std::setprecision(1) << state.t
                      << "s, alt=" << std::setprecision(1) << apo_alt
                      << " km, vel=" << std::setprecision(1) << state.vel.mag() << " m/s <<<" << std::endl;
            events.push_back({state.t, "Apogee", apo_alt, state.vel.mag()});
            trajectory.push_back({state.t, state.pos, 2});
            break;
        }

        prev_rdot = rdot;
        state = new_state;
    }

    std::cout << "\n=== ORBIT AT APOGEE (before S3 burn) ===" << std::endl;
    print_elements(state.pos, state.vel);

    // ==================================================================
    //  PHASE 3: S3 CIRCULARIZATION BURN AT APOGEE
    // ==================================================================
    std::cout << "\n--- S3 CIRCULARIZATION BURN (prograde at apogee) ---" << std::endl;

    // Record apogee altitude for target
    double sma_km, ecc, inc_deg, peri_km, apo_km;
    get_orbit(state.pos, state.vel, sma_km, ecc, inc_deg, peri_km, apo_km);
    std::cout << "  Target: raise perigee to within 10 km of apogee (circularize)" << std::endl;
    std::cout << "  Current orbit: " << std::setprecision(1) << peri_km
              << " x " << apo_km << " km" << std::endl;

    // Analytical dV estimate for circularization
    double r_apo = state.pos.mag();
    double v_apo = state.vel.mag();
    double v_circ = std::sqrt(MU / r_apo);
    std::cout << "  V at apogee: " << std::setprecision(1) << v_apo << " m/s" << std::endl;
    std::cout << "  V circular:  " << v_circ << " m/s" << std::endl;
    std::cout << "  dV needed:   ~" << std::setprecision(0) << (v_circ - v_apo) << " m/s" << std::endl;
    std::cout << "  S3 dV avail: " << std::setprecision(0) << dv3 << " m/s" << std::endl;
    std::cout << std::endl;

    // Start S3 burn
    events.push_back({state.t, "S3 Ignition", altitude(state.pos)/1000.0, state.vel.mag()});
    state.burning = true;
    state.stage = 2; // S3
    double s3_burn_start = state.t;
    double s3_dv_delivered = 0.0;
    last_print = state.t - 30.0; // print first line immediately
    last_record = state.t - 10.0;

    std::cout << std::setw(8) << "t[s]"
              << std::setw(10) << "alt[km]"
              << std::setw(10) << "vel[m/s]"
              << std::setw(10) << "mass[kg]"
              << std::setw(10) << "peri[km]"
              << std::setw(10) << "apo[km]"
              << std::setw(10) << "ecc"
              << std::endl;
    std::cout << std::string(68, '-') << std::endl;

    bool circularized = false;

    while (state.fuel[2] > 0.1) {
        double dt = 1.0; // fine steps during burn

        // Record trajectory (every 1s during S3)
        if (state.t - last_record >= 0.99) {
            last_record = state.t;
            trajectory.push_back({state.t, state.pos, 3});
        }

        // Thrust direction: prograde
        V3 thrust_dir = state.vel.normalized();

        // Check fuel
        double mdot = s3.mass_flow(altitude(state.pos));
        double fuel_time = state.fuel[2] / mdot;

        if (fuel_time <= dt) {
            dt = fuel_time;
        }

        State new_state = rk4_step(state, stages, Cd, area, dt, thrust_dir);
        new_state.stage = 2;
        new_state.burning = true;
        new_state.fuel[0] = 0;
        new_state.fuel[1] = 0;
        double fuel_used = state.mass - new_state.mass;
        new_state.fuel[2] = state.fuel[2] - fuel_used;
        if (new_state.fuel[2] < 0) new_state.fuel[2] = 0;

        s3_dv_delivered += (s3.thrust / state.mass) * dt;

        state = new_state;

        // Check orbit every step — print every 10 seconds
        get_orbit(state.pos, state.vel, sma_km, ecc, inc_deg, peri_km, apo_km);

        if (state.t - last_print >= 9.99 || state.fuel[2] < 0.1) {
            last_print = state.t;
            std::cout << std::fixed
                      << std::setw(8) << std::setprecision(1) << state.t
                      << std::setw(10) << std::setprecision(1) << altitude(state.pos) / 1000.0
                      << std::setw(10) << std::setprecision(1) << state.vel.mag()
                      << std::setw(10) << std::setprecision(1) << state.mass
                      << std::setw(10) << std::setprecision(1) << peri_km
                      << std::setw(10) << std::setprecision(1) << apo_km
                      << std::setw(10) << std::setprecision(6) << ecc
                      << std::endl;
        }

        if ((apo_km - peri_km) <= 10.0) {
            circularized = true;
            // Print final line
            std::cout << std::fixed
                      << std::setw(8) << std::setprecision(1) << state.t
                      << std::setw(10) << std::setprecision(1) << altitude(state.pos) / 1000.0
                      << std::setw(10) << std::setprecision(1) << state.vel.mag()
                      << std::setw(10) << std::setprecision(1) << state.mass
                      << std::setw(10) << std::setprecision(1) << peri_km
                      << std::setw(10) << std::setprecision(1) << apo_km
                      << std::setw(10) << std::setprecision(6) << ecc
                      << std::endl;
            break;
        }
    }

    state.burning = false;
    double s3_burn_time = state.t - s3_burn_start;

    // Record S3 cutoff
    trajectory.push_back({state.t, state.pos, 3});
    if (circularized) {
        std::cout << "\n>>> S3 CUTOFF — perigee raised to target <<<" << std::endl;
        events.push_back({state.t, "S3 Cutoff (circularized)", altitude(state.pos)/1000.0, state.vel.mag()});
    } else {
        std::cout << "\n>>> S3 FUEL EXHAUSTED <<<" << std::endl;
        events.push_back({state.t, "S3 Fuel Exhausted", altitude(state.pos)/1000.0, state.vel.mag()});
    }

    std::cout << "  S3 burn time:  " << std::setprecision(1) << s3_burn_time << " s" << std::endl;
    std::cout << "  S3 dV applied: " << std::setprecision(0) << s3_dv_delivered << " m/s" << std::endl;
    std::cout << "  S3 fuel left:  " << std::setprecision(1) << state.fuel[2] << " kg" << std::endl;

    // ==================================================================
    //  FINAL ORBIT
    // ==================================================================
    std::cout << "\n=== FINAL ORBIT ===" << std::endl;
    print_elements(state.pos, state.vel);

    // Get final orbital elements for JSON
    double final_sma_km, final_ecc, final_inc_deg, final_peri_km, final_apo_km;
    get_orbit(state.pos, state.vel, final_sma_km, final_ecc, final_inc_deg, final_peri_km, final_apo_km);

    std::cout << "\n=== TOTAL MISSION SUMMARY ===" << std::endl;
    std::cout << "  Ascent dV (S1+S2):  " << std::setprecision(0) << dv_thrust_total << " m/s delivered" << std::endl;
    std::cout << "  Circ dV (S3):       " << s3_dv_delivered << " m/s" << std::endl;
    std::cout << "  Total dV:           " << (dv_thrust_total + s3_dv_delivered) << " m/s" << std::endl;
    std::cout << "  Gravity loss:       " << dv_gravity_loss << " m/s" << std::endl;
    std::cout << "  Drag loss:          " << dv_drag_loss << " m/s" << std::endl;
    std::cout << "  Payload to orbit:   " << std::setprecision(0) << state.mass << " kg" << std::endl;
    std::cout << "  Total flight time:  " << std::setprecision(0) << state.t << " s ("
              << std::setprecision(1) << state.t / 60.0 << " min)" << std::endl;

    // ==================================================================
    //  POST-BURN: PROPAGATE ONE ORBIT FOR VISUALIZATION
    // ==================================================================
    std::cout << "\n--- Propagating one orbit for visualization ---" << std::endl;

    double orbit_period = 2.0 * PI * std::sqrt(std::pow(final_sma_km * 1000.0, 3) / MU);
    std::cout << "  Orbital period: " << std::setprecision(0) << orbit_period << " s ("
              << std::setprecision(1) << orbit_period / 3600.0 << " hr)" << std::endl;

    double orbit_start = state.t;
    last_record = state.t - 100.0;
    state.burning = false;

    while (state.t - orbit_start < orbit_period) {
        double dt = 10.0;

        State new_state = rk4_step(state, stages, Cd, area, dt);
        new_state.stage = state.stage;
        new_state.burning = false;
        new_state.fuel[0] = 0;
        new_state.fuel[1] = 0;
        new_state.fuel[2] = state.fuel[2];

        // Record every 30s
        if (new_state.t - last_record >= 29.9) {
            last_record = new_state.t;
            trajectory.push_back({new_state.t, new_state.pos, 4});
        }

        state = new_state;
    }

    // Record final point
    trajectory.push_back({state.t, state.pos, 4});

    double total_duration = state.t;
    std::cout << "  Total visualization duration: " << std::setprecision(0) << total_duration
              << " s (" << std::setprecision(1) << total_duration / 3600.0 << " hr)" << std::endl;

    // ==================================================================
    //  WRITE JSON FOR CESIUM
    // ==================================================================
    std::string json_file = "gravity_turn_data.json";
    std::cout << "\nWriting trajectory to " << json_file << "..." << std::endl;

    write_trajectory_json(json_file, trajectory, events,
                          gmst0, epoch_jd,
                          total_mass, payload,
                          dv_thrust_total, dv_gravity_loss, dv_drag_loss, s3_dv_delivered,
                          final_sma_km, final_ecc, final_inc_deg, final_peri_km, final_apo_km);

    std::cout << "\nVisualize: open visualization/cesium/launch_viewer.html" << std::endl;

    return 0;
}
