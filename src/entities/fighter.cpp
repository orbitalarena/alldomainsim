#include "fighter.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>

namespace sim {

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;
constexpr double EARTH_RADIUS = 6371000.0;

// ============== Missile Implementation ==============

Missile::Missile(int id, Type type, int shooter, int target, Team team)
    : id(id), type(type), shooter_id(shooter), target_id(target), team(team) {
    if (type == Type::AIM120) {
        max_range = 100000.0;
        max_speed = 1400.0;
        motor_burn_time = 8.0;
        coast_time = 40.0;
    } else {
        max_range = 18000.0;
        max_speed = 900.0;
        motor_burn_time = 3.0;
        coast_time = 15.0;
    }
}

void Missile::launch(double lat_, double lon_, double alt_, double hdg, double spd) {
    lat = lat_;
    lon = lon_;
    alt = alt_;
    heading = hdg;
    speed = spd + 50.0;  // Initial boost
    state = State::FLYING;
    time_of_flight = 0.0;
    has_lock = true;
}

double Missile::distance_to_target() const {
    double dlat = (target_lat - lat) * DEG_TO_RAD;
    double dlon = (target_lon - lon) * DEG_TO_RAD;
    double a = std::sin(dlat/2) * std::sin(dlat/2) +
               std::cos(lat * DEG_TO_RAD) * std::cos(target_lat * DEG_TO_RAD) *
               std::sin(dlon/2) * std::sin(dlon/2);
    double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1-a));
    double horiz_dist = EARTH_RADIUS * c;
    double vert_dist = target_alt - alt;
    return std::sqrt(horiz_dist * horiz_dist + vert_dist * vert_dist);
}

void Missile::update(double dt, double tgt_lat, double tgt_lon, double tgt_alt) {
    if (state == State::HIT || state == State::MISS || state == State::ON_RAIL) return;

    time_of_flight += dt;
    target_lat = tgt_lat;
    target_lon = tgt_lon;
    target_alt = tgt_alt;

    // Motor phase - accelerate
    if (time_of_flight < motor_burn_time) {
        speed = std::min(speed + 200.0 * dt, max_speed);
    } else {
        // Coast phase - decelerate due to drag
        speed = std::max(speed - 30.0 * dt, 200.0);
    }

    // Check if missile is out of energy
    if (time_of_flight > motor_burn_time + coast_time) {
        state = State::MISS;
        return;
    }

    // Guidance
    double dist = distance_to_target();

    // Switch to active homing when close
    if (type == Type::AIM120 && dist < 20000.0) {
        state = State::ACTIVE;
    }
    if (dist < 5000.0) {
        state = State::TERMINAL;
    }

    // Proportional navigation guidance
    double bearing_to_target = std::atan2(
        std::sin((target_lon - lon) * DEG_TO_RAD) * std::cos(target_lat * DEG_TO_RAD),
        std::cos(lat * DEG_TO_RAD) * std::sin(target_lat * DEG_TO_RAD) -
        std::sin(lat * DEG_TO_RAD) * std::cos(target_lat * DEG_TO_RAD) *
        std::cos((target_lon - lon) * DEG_TO_RAD)
    ) * RAD_TO_DEG;
    bearing_to_target = std::fmod(bearing_to_target + 360.0, 360.0);

    // Turn toward target
    double heading_error = bearing_to_target - heading;
    while (heading_error > 180.0) heading_error -= 360.0;
    while (heading_error < -180.0) heading_error += 360.0;

    // High-G turn capability
    double max_turn_rate = (max_g * 9.81 / speed) * RAD_TO_DEG;
    double turn = std::clamp(heading_error, -max_turn_rate * dt, max_turn_rate * dt);
    heading = std::fmod(heading + turn + 360.0, 360.0);

    // Altitude guidance
    double climb_angle = std::atan2(target_alt - alt, dist) * RAD_TO_DEG;
    climb_angle = std::clamp(climb_angle, -45.0, 45.0);

    // Move missile
    double dist_traveled = speed * dt;
    double horiz_dist = dist_traveled * std::cos(climb_angle * DEG_TO_RAD);
    double vert_dist = dist_traveled * std::sin(climb_angle * DEG_TO_RAD);

    // Great circle position update
    double angular_dist = horiz_dist / EARTH_RADIUS;
    double bearing_rad = heading * DEG_TO_RAD;
    double lat_rad = lat * DEG_TO_RAD;
    double lon_rad = lon * DEG_TO_RAD;

    double new_lat_rad = std::asin(std::sin(lat_rad) * std::cos(angular_dist) +
                                   std::cos(lat_rad) * std::sin(angular_dist) * std::cos(bearing_rad));
    double new_lon_rad = lon_rad + std::atan2(
        std::sin(bearing_rad) * std::sin(angular_dist) * std::cos(lat_rad),
        std::cos(angular_dist) - std::sin(lat_rad) * std::sin(new_lat_rad));

    lat = new_lat_rad * RAD_TO_DEG;
    lon = new_lon_rad * RAD_TO_DEG;
    alt += vert_dist;
    alt = std::max(alt, 100.0);  // Don't go below 100m

    // Check for hit
    if (dist < 50.0) {  // 50m lethal radius
        state = State::HIT;
    }
}

// ============== Debris Implementation ==============

constexpr double GRAVITY = 9.81;

Debris::Debris(int id, int source_id, Team team,
               double lat, double lon, double alt,
               double vel_e, double vel_n, double vel_u,
               double mass, double drag_area)
    : id(id), source_fighter_id(source_id), team(team),
      lat(lat), lon(lon), alt(alt),
      vel_east(vel_e), vel_north(vel_n), vel_up(vel_u),
      mass(mass), drag_area(drag_area), drag_coeff(1.5) {
}

void Debris::update(double dt) {
    if (!is_falling) return;

    time_since_creation += dt;

    // Simple atmospheric density model
    double rho = 1.225 * std::exp(-alt / 8500.0);

    // Total velocity magnitude
    double vel_mag = std::sqrt(vel_east * vel_east + vel_north * vel_north + vel_up * vel_up);

    if (vel_mag > 0.1) {
        // Drag force: F_drag = 0.5 * rho * v^2 * Cd * A
        double drag_force = 0.5 * rho * vel_mag * vel_mag * drag_coeff * drag_area;
        double drag_accel = drag_force / mass;

        // Apply drag (opposite to velocity direction)
        vel_east -= (vel_east / vel_mag) * drag_accel * dt;
        vel_north -= (vel_north / vel_mag) * drag_accel * dt;
        vel_up -= (vel_up / vel_mag) * drag_accel * dt;
    }

    // Apply gravity
    vel_up -= GRAVITY * dt;

    // Update position
    // Convert velocity to lat/lon changes
    double meters_per_deg_lat = 111320.0;
    double meters_per_deg_lon = 111320.0 * std::cos(lat * DEG_TO_RAD);

    lat += (vel_north * dt) / meters_per_deg_lat;
    lon += (vel_east * dt) / meters_per_deg_lon;
    alt += vel_up * dt;

    // Check for ground impact
    if (alt <= 0.0) {
        alt = 0.0;
        vel_east = 0.0;
        vel_north = 0.0;
        vel_up = 0.0;
        is_falling = false;
    }
}

std::vector<Debris> create_debris_field(int fighter_id, Team team,
                                        double lat, double lon, double alt,
                                        double heading, double speed,
                                        int num_pieces) {
    std::vector<Debris> debris;

    // Convert fighter velocity to ENU components
    double heading_rad = heading * DEG_TO_RAD;
    double base_vel_east = speed * std::sin(heading_rad);
    double base_vel_north = speed * std::cos(heading_rad);
    double base_vel_up = 0.0;  // Assume level flight at kill

    // Create debris pieces with random scatter
    for (int i = 0; i < num_pieces; i++) {
        // Random scatter velocities (explosion imparts 50-150 m/s random velocity)
        double scatter_angle = (2.0 * PI * i) / num_pieces + (std::rand() % 100 - 50) * 0.01;
        double scatter_speed = 50.0 + (std::rand() % 100);
        double scatter_up = (std::rand() % 200 - 100);  // -100 to +100 m/s vertical

        double vel_e = base_vel_east + scatter_speed * std::cos(scatter_angle);
        double vel_n = base_vel_north + scatter_speed * std::sin(scatter_angle);
        double vel_u = base_vel_up + scatter_up;

        // Random mass (10-500 kg pieces)
        double piece_mass = 10.0 + (std::rand() % 490);

        // Drag area scales roughly with mass^(2/3)
        double piece_drag_area = 0.1 * std::pow(piece_mass / 100.0, 0.67);

        // Small random position offset (within 50m of kill point)
        double offset_lat = (std::rand() % 100 - 50) * 0.0001;
        double offset_lon = (std::rand() % 100 - 50) * 0.0001;

        debris.emplace_back(i, fighter_id, team,
                           lat + offset_lat, lon + offset_lon, alt,
                           vel_e, vel_n, vel_u,
                           piece_mass, piece_drag_area);
    }

    return debris;
}

// ============== Fighter Implementation ==============

Fighter::Fighter(int id, const std::string& callsign, Team team, const FighterConfig& config)
    : Aircraft(id, callsign, config), team_(team), fighter_config_(config) {
    // Initialize with full loadout
    loadout_.aim120_count = 4;
    loadout_.aim9_count = 2;
}

void Fighter::update(double dt) {
    if (killed_) return;

    // Update base aircraft physics
    Aircraft::update(dt);

    // Update missiles
    for (auto& missile : missiles_) {
        if (missile->is_active() && locked_target_) {
            FlightState tgt_state = locked_target_->get_flight_state();
            missile->update(dt, tgt_state.latitude, tgt_state.longitude, tgt_state.altitude_msl);
        } else if (missile->is_active()) {
            // Lost lock - missile goes ballistic
            missile->update(dt, missile->target_lat, missile->target_lon, missile->target_alt);
        }
    }

    // Update timers
    time_since_last_shot_ += dt;
    state_timer_ += dt;
    radar_sweep_time_ += dt;
}

void Fighter::update_radar(const std::vector<Fighter*>& all_fighters) {
    radar_contacts_.clear();
    is_spiked_ = false;

    FlightState my_state = get_flight_state();

    for (const auto* other : all_fighters) {
        if (other == this || !other->is_alive()) continue;

        FlightState other_state = other->get_flight_state();

        // Calculate range
        double range = range_to(other_state.latitude, other_state.longitude, other_state.altitude_msl);

        // Check if in radar range and cone
        if (range < fighter_config_.radar_range && is_in_radar_cone(other)) {
            RadarContact contact;
            contact.target_id = other->get_id();
            contact.range = range;
            contact.bearing = bearing_to(other_state.latitude, other_state.longitude) - my_state.heading;
            contact.aspect_angle = compute_aspect_angle(other);
            contact.altitude = other_state.altitude_msl;
            contact.is_locked = (locked_target_ == other);

            // Compute closure rate
            double my_vel = my_state.groundspeed;
            double other_vel = other_state.groundspeed;
            double my_hdg = my_state.heading * DEG_TO_RAD;
            double other_hdg = other_state.heading * DEG_TO_RAD;
            double bearing = bearing_to(other_state.latitude, other_state.longitude) * DEG_TO_RAD;

            // Closure = my velocity toward them + their velocity toward me
            contact.closure_rate = my_vel * std::cos(bearing - my_hdg) +
                                  other_vel * std::cos(bearing + PI - other_hdg);

            radar_contacts_.push_back(contact);
        }

        // RWR - check if we're being locked
        if (other->get_team() != team_ && other->locked_target_ == this) {
            is_spiked_ = true;
        }
    }

    // Sort contacts by range
    std::sort(radar_contacts_.begin(), radar_contacts_.end(),
              [](const RadarContact& a, const RadarContact& b) {
                  return a.range < b.range;
              });
}

bool Fighter::is_in_radar_cone(const Fighter* target) const {
    double ata = std::abs(compute_antenna_train_angle(target));
    return ata < fighter_config_.radar_fov / 2.0;
}

double Fighter::compute_antenna_train_angle(const Fighter* target) const {
    FlightState my_state = get_flight_state();
    FlightState tgt_state = target->get_flight_state();
    double bearing = bearing_to(tgt_state.latitude, tgt_state.longitude);
    double ata = bearing - my_state.heading;
    while (ata > 180.0) ata -= 360.0;
    while (ata < -180.0) ata += 360.0;
    return ata;
}

double Fighter::compute_aspect_angle(const Fighter* target) const {
    FlightState my_state = get_flight_state();
    FlightState tgt_state = target->get_flight_state();

    // Bearing FROM target TO us
    double lat1 = tgt_state.latitude * DEG_TO_RAD;
    double lon1 = tgt_state.longitude * DEG_TO_RAD;
    double lat2 = my_state.latitude * DEG_TO_RAD;
    double lon2 = my_state.longitude * DEG_TO_RAD;

    double y = std::sin(lon2 - lon1) * std::cos(lat2);
    double x = std::cos(lat1) * std::sin(lat2) -
               std::sin(lat1) * std::cos(lat2) * std::cos(lon2 - lon1);
    double bearing_to_us = std::atan2(y, x) * RAD_TO_DEG;
    bearing_to_us = std::fmod(bearing_to_us + 360.0, 360.0);

    // Aspect = difference between target's heading and bearing to us
    double aspect = bearing_to_us - tgt_state.heading;
    while (aspect > 180.0) aspect -= 360.0;
    while (aspect < -180.0) aspect += 360.0;

    return std::abs(aspect);
}

double Fighter::bearing_to(double lat, double lon) const {
    FlightState my_state = get_flight_state();
    double lat1 = my_state.latitude * DEG_TO_RAD;
    double lon1 = my_state.longitude * DEG_TO_RAD;
    double lat2 = lat * DEG_TO_RAD;
    double lon2 = lon * DEG_TO_RAD;

    double y = std::sin(lon2 - lon1) * std::cos(lat2);
    double x = std::cos(lat1) * std::sin(lat2) -
               std::sin(lat1) * std::cos(lat2) * std::cos(lon2 - lon1);
    double bearing = std::atan2(y, x) * RAD_TO_DEG;
    return std::fmod(bearing + 360.0, 360.0);
}

double Fighter::range_to(double lat, double lon, double alt) const {
    FlightState my_state = get_flight_state();
    double dlat = (lat - my_state.latitude) * DEG_TO_RAD;
    double dlon = (lon - my_state.longitude) * DEG_TO_RAD;
    double a = std::sin(dlat/2) * std::sin(dlat/2) +
               std::cos(my_state.latitude * DEG_TO_RAD) * std::cos(lat * DEG_TO_RAD) *
               std::sin(dlon/2) * std::sin(dlon/2);
    double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1-a));
    double horiz_dist = EARTH_RADIUS * c;
    double vert_dist = alt - my_state.altitude_msl;
    return std::sqrt(horiz_dist * horiz_dist + vert_dist * vert_dist);
}

void Fighter::lock_target(Fighter* target) {
    locked_target_ = target;
    for (auto& contact : radar_contacts_) {
        contact.is_locked = (contact.target_id == target->get_id());
    }
}

void Fighter::break_lock() {
    locked_target_ = nullptr;
    for (auto& contact : radar_contacts_) {
        contact.is_locked = false;
    }
}

bool Fighter::can_fire_aim120() const {
    if (loadout_.aim120_count <= 0) return false;
    if (!locked_target_ || !locked_target_->is_alive()) return false;
    if (time_since_last_shot_ < 3.0) return false;  // 3 second minimum between shots

    FlightState tgt = locked_target_->get_flight_state();
    double range = range_to(tgt.latitude, tgt.longitude, tgt.altitude_msl);

    return range >= fighter_config_.aim120_min_range &&
           range <= fighter_config_.aim120_max_range;
}

bool Fighter::can_fire_aim9() const {
    if (loadout_.aim9_count <= 0) return false;
    if (!locked_target_ || !locked_target_->is_alive()) return false;
    if (time_since_last_shot_ < 2.0) return false;

    FlightState tgt = locked_target_->get_flight_state();
    double range = range_to(tgt.latitude, tgt.longitude, tgt.altitude_msl);
    double ata = std::abs(compute_antenna_train_angle(locked_target_));

    return range >= fighter_config_.aim9_min_range &&
           range <= fighter_config_.aim9_max_range &&
           ata < 30.0;  // Sidewinder needs near-boresight shot
}

std::shared_ptr<Missile> Fighter::fire_aim120() {
    if (!can_fire_aim120()) return nullptr;

    FlightState my_state = get_flight_state();
    auto missile = std::make_shared<Missile>(
        next_missile_id_++, Missile::Type::AIM120,
        get_id(), locked_target_->get_id(), team_
    );

    missile->launch(my_state.latitude, my_state.longitude, my_state.altitude_msl,
                   my_state.heading, my_state.true_airspeed);

    FlightState tgt = locked_target_->get_flight_state();
    missile->target_lat = tgt.latitude;
    missile->target_lon = tgt.longitude;
    missile->target_alt = tgt.altitude_msl;

    missiles_.push_back(missile);
    loadout_.aim120_count--;
    time_since_last_shot_ = 0.0;
    shots_fired_this_engagement_++;

    return missile;
}

std::shared_ptr<Missile> Fighter::fire_aim9() {
    if (!can_fire_aim9()) return nullptr;

    FlightState my_state = get_flight_state();
    auto missile = std::make_shared<Missile>(
        next_missile_id_++, Missile::Type::AIM9,
        get_id(), locked_target_->get_id(), team_
    );

    missile->launch(my_state.latitude, my_state.longitude, my_state.altitude_msl,
                   my_state.heading, my_state.true_airspeed);

    FlightState tgt = locked_target_->get_flight_state();
    missile->target_lat = tgt.latitude;
    missile->target_lon = tgt.longitude;
    missile->target_alt = tgt.altitude_msl;

    missiles_.push_back(missile);
    loadout_.aim9_count--;
    time_since_last_shot_ = 0.0;

    return missile;
}

void Fighter::run_tactical_ai(const std::vector<Fighter*>& friendlies,
                               const std::vector<Fighter*>& enemies,
                               const std::vector<std::shared_ptr<Missile>>& incoming) {
    if (killed_) return;

    FlightState my_state = get_flight_state();

    // Check for incoming missiles
    missile_inbound_ = false;
    for (const auto& m : incoming) {
        if (m->target_id == get_id() && m->is_active()) {
            missile_inbound_ = true;
            break;
        }
    }

    // Find closest enemy
    Fighter* closest_enemy = nullptr;
    double closest_range = 999999.0;
    for (auto* enemy : enemies) {
        if (!enemy->is_alive()) continue;
        FlightState e_state = enemy->get_flight_state();
        double range = range_to(e_state.latitude, e_state.longitude, e_state.altitude_msl);
        if (range < closest_range) {
            closest_range = range;
            closest_enemy = enemy;
        }
    }

    // State machine logic
    switch (tactical_state_) {
        case TacticalState::PATROL:
            // Fly patrol heading, search for targets
            set_target_heading(patrol_heading_);
            set_target_altitude(8000.0);  // Patrol at 26,000 ft
            set_target_speed(250.0);  // ~485 kts

            if (closest_enemy && closest_range < fighter_config_.commit_range) {
                tactical_state_ = TacticalState::DETECTED;
                state_timer_ = 0.0;
            }
            break;

        case TacticalState::DETECTED:
            // Evaluate and prepare to commit
            if (closest_enemy) {
                lock_target(closest_enemy);
                tactical_state_ = TacticalState::COMMIT;
                state_timer_ = 0.0;
                // Decide crank direction (random for now)
                crank_direction_ = (get_id() % 2 == 0) ? 1.0 : -1.0;
            } else {
                tactical_state_ = TacticalState::PATROL;
            }
            break;

        case TacticalState::COMMIT:
            // Turn toward target (hot)
            if (locked_target_ && locked_target_->is_alive()) {
                FlightState tgt = locked_target_->get_flight_state();
                double bearing = bearing_to(tgt.latitude, tgt.longitude);
                set_target_heading(bearing);
                set_target_speed(280.0);  // Speed up for engagement
                set_throttle(0.95);

                double range = range_to(tgt.latitude, tgt.longitude, tgt.altitude_msl);

                // Check for missile launch
                if (can_fire_aim120() && range < fighter_config_.aim120_max_range * 0.8) {
                    tactical_state_ = TacticalState::LAUNCH;
                    state_timer_ = 0.0;
                }

                // Defensive - if spiked and missile inbound, defend
                if (missile_inbound_) {
                    tactical_state_ = TacticalState::DEFEND;
                    state_timer_ = 0.0;
                }

                // Merge if too close for BVR
                if (range < fighter_config_.merge_range) {
                    tactical_state_ = TacticalState::MERGE;
                    state_timer_ = 0.0;
                }
            } else {
                break_lock();
                tactical_state_ = TacticalState::PATROL;
            }
            break;

        case TacticalState::LAUNCH:
            // Fire missile and transition to crank
            if (locked_target_ && can_fire_aim120()) {
                fire_aim120();
                tactical_state_ = TacticalState::CRANK;
                state_timer_ = 0.0;
            } else {
                tactical_state_ = TacticalState::COMMIT;
            }
            break;

        case TacticalState::CRANK:
            // Beam maneuver - turn perpendicular to maintain radar lock while increasing range
            if (locked_target_ && locked_target_->is_alive()) {
                execute_crank(0.0);  // dt not used, just sets heading

                FlightState tgt = locked_target_->get_flight_state();
                double range = range_to(tgt.latitude, tgt.longitude, tgt.altitude_msl);

                // If range opens up and we have missiles, can go for another shot
                if (state_timer_ > 10.0 && shots_fired_this_engagement_ < 2 && loadout_.aim120_count > 0) {
                    tactical_state_ = TacticalState::PUMP;
                    state_timer_ = 0.0;
                }

                // If getting close, prepare to merge
                if (range < fighter_config_.merge_range * 2) {
                    tactical_state_ = TacticalState::MERGE;
                    state_timer_ = 0.0;
                }

                // Defensive
                if (missile_inbound_) {
                    tactical_state_ = TacticalState::DEFEND;
                    state_timer_ = 0.0;
                }
            } else {
                tactical_state_ = TacticalState::PATROL;
            }
            break;

        case TacticalState::PUMP:
            // Turn cold briefly to increase range, then recommit
            execute_pump(0.0);

            if (state_timer_ > 8.0) {
                tactical_state_ = TacticalState::COMMIT;
                state_timer_ = 0.0;
            }

            if (missile_inbound_) {
                tactical_state_ = TacticalState::DEFEND;
                state_timer_ = 0.0;
            }
            break;

        case TacticalState::DEFEND:
            // Break turn and dispense countermeasures
            execute_break(0.0);
            set_throttle(1.0);  // Afterburner

            // After 5 seconds of defending, assess situation
            if (state_timer_ > 5.0) {
                if (!missile_inbound_) {
                    tactical_state_ = TacticalState::COMMIT;
                    state_timer_ = 0.0;
                }
            }
            break;

        case TacticalState::MERGE:
            // Close-in dogfight
            if (locked_target_ && locked_target_->is_alive()) {
                execute_pursuit(0.0);
                set_throttle(1.0);

                FlightState tgt = locked_target_->get_flight_state();
                double range = range_to(tgt.latitude, tgt.longitude, tgt.altitude_msl);

                // Try to get a Sidewinder shot
                if (can_fire_aim9()) {
                    fire_aim9();
                }

                // If range opens back up, recommit to BVR
                if (range > fighter_config_.merge_range * 3 && loadout_.aim120_count > 0) {
                    tactical_state_ = TacticalState::COMMIT;
                    state_timer_ = 0.0;
                }
            } else {
                tactical_state_ = TacticalState::PATROL;
            }
            break;

        case TacticalState::DISENGAGE:
            // Turn cold and extend
            {
                double escape_heading = my_state.heading + 180.0;
                escape_heading = std::fmod(escape_heading, 360.0);
                set_target_heading(escape_heading);
                set_throttle(1.0);

                if (state_timer_ > 30.0) {
                    tactical_state_ = TacticalState::PATROL;
                    state_timer_ = 0.0;
                }
            }
            break;

        case TacticalState::KILLED:
            // Do nothing
            break;
    }
}

void Fighter::execute_crank(double dt) {
    if (!locked_target_) return;

    FlightState tgt = locked_target_->get_flight_state();
    double bearing = bearing_to(tgt.latitude, tgt.longitude);

    // Crank angle off the target (beam maneuver)
    double crank_heading = bearing + crank_direction_ * fighter_config_.crank_angle;
    crank_heading = std::fmod(crank_heading + 360.0, 360.0);

    set_target_heading(crank_heading);
    set_target_speed(260.0);
}

void Fighter::execute_pump(double dt) {
    if (!locked_target_) return;

    FlightState my_state = get_flight_state();
    FlightState tgt = locked_target_->get_flight_state();
    double bearing = bearing_to(tgt.latitude, tgt.longitude);

    // Turn cold (away from target)
    double cold_heading = bearing + 180.0;
    cold_heading = std::fmod(cold_heading, 360.0);

    set_target_heading(cold_heading);
    set_target_speed(280.0);
    set_throttle(0.9);
}

void Fighter::execute_break(double dt) {
    FlightState my_state = get_flight_state();

    // Hard break turn into the threat
    double break_heading = my_state.heading + 90.0 * crank_direction_;
    break_heading = std::fmod(break_heading + 360.0, 360.0);

    set_target_heading(break_heading);
    set_target_speed(fighter_config_.corner_speed);  // Corner speed for max turn rate
    bank_angle_ = 80.0 * crank_direction_;
}

void Fighter::execute_pursuit(double dt) {
    if (!locked_target_) return;

    FlightState tgt = locked_target_->get_flight_state();
    double bearing = bearing_to(tgt.latitude, tgt.longitude);

    // Lead pursuit
    double lead = 5.0;  // degrees of lead
    double pursuit_heading = bearing + lead * crank_direction_;
    pursuit_heading = std::fmod(pursuit_heading + 360.0, 360.0);

    set_target_heading(pursuit_heading);
    set_target_altitude(tgt.altitude_msl);
    set_target_speed(fighter_config_.corner_speed);
}

void Fighter::execute_maneuver_to_heading(double target_heading, double dt) {
    set_target_heading(target_heading);
}

const char* tactical_state_name(TacticalState state) {
    switch (state) {
        case TacticalState::PATROL: return "PATROL";
        case TacticalState::DETECTED: return "DETECTED";
        case TacticalState::COMMIT: return "COMMIT";
        case TacticalState::LAUNCH: return "LAUNCH";
        case TacticalState::CRANK: return "CRANK";
        case TacticalState::PUMP: return "PUMP";
        case TacticalState::DEFEND: return "DEFEND";
        case TacticalState::MERGE: return "MERGE";
        case TacticalState::DISENGAGE: return "DISENGAGE";
        case TacticalState::KILLED: return "KILLED";
        default: return "UNKNOWN";
    }
}

} // namespace sim
