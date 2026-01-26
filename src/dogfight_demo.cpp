#include <iostream>
#include <fstream>
#include <iomanip>
#include <vector>
#include <memory>
#include <cmath>
#include <cstdlib>
#include <ctime>

#include "entities/fighter.hpp"

using namespace sim;

// Indiana center point
constexpr double INDIANA_LAT = 39.7684;
constexpr double INDIANA_LON = -86.1581;

// Starting positions offset from center
constexpr double OFFSET_KM = 80.0;  // 80 km from center

int main() {
    // Seed random number generator for debris scatter
    std::srand(static_cast<unsigned>(std::time(nullptr)));

    std::cout << std::fixed << std::setprecision(2);
    std::cout << "================================================" << std::endl;
    std::cout << "   DOGFIGHT SIMULATION: 4 vs 4 over Indiana" << std::endl;
    std::cout << "================================================" << std::endl;

    // Create fighter configurations
    FighterConfig blue_config;
    blue_config.name = "F-16C Block 50";

    FighterConfig red_config;
    red_config.name = "MiG-29S Fulcrum";
    red_config.radar_range = 120000.0;  // Slightly shorter radar range
    red_config.aim120_max_range = 80000.0;  // R-77 equivalent

    // Calculate starting positions
    // Blue team starts in the WEST (flying East toward center)
    // Red team starts in the EAST (flying West toward center)

    double km_to_deg_lat = 1.0 / 111.0;
    double km_to_deg_lon = 1.0 / (111.0 * std::cos(INDIANA_LAT * 3.14159 / 180.0));

    double blue_start_lon = INDIANA_LON - OFFSET_KM * km_to_deg_lon;
    double red_start_lon = INDIANA_LON + OFFSET_KM * km_to_deg_lon;

    // Create Blue team (4 aircraft)
    std::vector<std::unique_ptr<Fighter>> blue_team;
    std::vector<double> blue_offsets = {-0.02, -0.007, 0.007, 0.02};  // Lateral spread in degrees

    for (int i = 0; i < 4; i++) {
        auto fighter = std::make_unique<Fighter>(i, "VIPER" + std::to_string(i+1), Team::BLUE, blue_config);
        double lat = INDIANA_LAT + blue_offsets[i];
        double alt = 8000.0 + i * 300.0;  // Slight altitude separation
        fighter->set_initial_position(lat, blue_start_lon, alt);
        fighter->set_phase(FlightPhase::CRUISE);  // Start airborne
        fighter->set_patrol_heading(90.0);  // Flying East
        fighter->set_target_heading(90.0);
        fighter->set_heading(90.0);
        fighter->set_target_altitude(alt);
        fighter->set_target_speed(250.0);
        fighter->set_true_airspeed(250.0);  // Initial speed
        fighter->set_throttle(0.8);
        blue_team.push_back(std::move(fighter));
    }

    // Create Red team (4 aircraft)
    std::vector<std::unique_ptr<Fighter>> red_team;
    std::vector<double> red_offsets = {-0.02, -0.007, 0.007, 0.02};

    for (int i = 0; i < 4; i++) {
        auto fighter = std::make_unique<Fighter>(i + 10, "FLANKER" + std::to_string(i+1), Team::RED, red_config);
        double lat = INDIANA_LAT + red_offsets[i];
        double alt = 8500.0 + i * 300.0;
        fighter->set_initial_position(lat, red_start_lon, alt);
        fighter->set_phase(FlightPhase::CRUISE);  // Start airborne
        fighter->set_patrol_heading(270.0);  // Flying West
        fighter->set_target_heading(270.0);
        fighter->set_heading(270.0);
        fighter->set_target_altitude(alt);
        fighter->set_target_speed(250.0);
        fighter->set_true_airspeed(250.0);  // Initial speed
        fighter->set_throttle(0.8);
        red_team.push_back(std::move(fighter));
    }

    std::cout << "\nBlue Team (West, flying East):" << std::endl;
    for (const auto& f : blue_team) {
        FlightState fs = f->get_flight_state();
        std::cout << "  " << f->get_name() << " at " << fs.latitude << "°, " << fs.longitude << "°"
                  << " ALT: " << (fs.altitude_msl / 0.3048) << " ft" << std::endl;
    }

    std::cout << "\nRed Team (East, flying West):" << std::endl;
    for (const auto& f : red_team) {
        FlightState fs = f->get_flight_state();
        std::cout << "  " << f->get_name() << " at " << fs.latitude << "°, " << fs.longitude << "°"
                  << " ALT: " << (fs.altitude_msl / 0.3048) << " ft" << std::endl;
    }

    std::cout << "\nInitial separation: ~" << (OFFSET_KM * 2) << " km" << std::endl;

    // Simulation parameters
    double dt = 0.5;  // 0.5 second time step for combat
    double max_time = 900.0;  // 15 minutes - runs beyond engagement for debris
    double record_interval = 1.0;  // Record every second

    // Data logging
    struct FighterLog {
        std::string callsign;
        Team team;
        std::vector<FlightState> trajectory;
        std::vector<TacticalState> states;
        std::vector<double> times;
        double kill_time = -1.0;  // Time of death, -1 if survived
    };

    struct MissileLog {
        int id;
        int shooter_id;
        int target_id;
        Team team;
        Missile::Type type;
        std::vector<double> times;
        std::vector<double> lats;
        std::vector<double> lons;
        std::vector<double> alts;
        Missile::State final_state;
    };

    struct DebrisLog {
        int id;
        int source_fighter_id;
        std::string source_callsign;
        Team team;
        std::vector<double> times;
        std::vector<double> lats;
        std::vector<double> lons;
        std::vector<double> alts;
        double impact_time = -1.0;
    };

    std::vector<FighterLog> fighter_logs;
    std::vector<MissileLog> missile_logs;
    std::vector<DebrisLog> debris_logs;

    // Active debris in the simulation
    std::vector<Debris> all_debris;

    // Initialize logs
    for (const auto& f : blue_team) {
        FighterLog log;
        log.callsign = f->get_name();
        log.team = Team::BLUE;
        fighter_logs.push_back(log);
    }
    for (const auto& f : red_team) {
        FighterLog log;
        log.callsign = f->get_name();
        log.team = Team::RED;
        fighter_logs.push_back(log);
    }

    // All missiles in the fight
    std::vector<std::shared_ptr<Missile>> all_missiles;

    std::cout << "\n=== ENGAGEMENT BEGINS ===" << std::endl;

    double elapsed = 0.0;
    double last_record = 0.0;
    int blue_alive = 4, red_alive = 4;
    bool engagement_over = false;
    double engagement_end_time = 0.0;

    // Continue while: under max time AND (engagement ongoing OR debris still falling)
    while (elapsed < max_time) {
        // Check if engagement has ended
        if (!engagement_over && (blue_alive == 0 || red_alive == 0)) {
            engagement_over = true;
            engagement_end_time = elapsed;
            std::cout << "\n=== ENGAGEMENT ENDED at " << elapsed << "s ===" << std::endl;
            std::cout << "=== Tracking debris... ===" << std::endl;
        }

        // Count falling debris
        int debris_falling = 0;
        for (const auto& d : all_debris) {
            if (d.is_falling) debris_falling++;
        }

        // Stop if engagement over and all debris has landed (or no debris)
        if (engagement_over && debris_falling == 0 && !all_debris.empty()) {
            std::cout << "[" << elapsed << "s] All debris has landed." << std::endl;
            break;
        }

        // Also stop if engagement over for 5 minutes (debris timeout)
        if (engagement_over && elapsed - engagement_end_time > 300.0) {
            std::cout << "[" << elapsed << "s] Debris tracking timeout." << std::endl;
            break;
        }
        // Build pointer lists for radar/AI updates
        std::vector<Fighter*> all_fighters;
        std::vector<Fighter*> blue_ptrs, red_ptrs;

        for (auto& f : blue_team) {
            all_fighters.push_back(f.get());
            blue_ptrs.push_back(f.get());
        }
        for (auto& f : red_team) {
            all_fighters.push_back(f.get());
            red_ptrs.push_back(f.get());
        }

        // Collect incoming missiles for each team
        std::vector<std::shared_ptr<Missile>> blue_incoming, red_incoming;
        for (const auto& m : all_missiles) {
            if (!m->is_active()) continue;
            if (m->team == Team::BLUE) {
                red_incoming.push_back(m);
            } else {
                blue_incoming.push_back(m);
            }
        }

        // Update Blue team
        for (auto& f : blue_team) {
            if (!f->is_alive()) continue;

            f->update_radar(all_fighters);
            f->run_tactical_ai(blue_ptrs, red_ptrs, blue_incoming);
            f->update(dt);

            // Check for new missiles
            for (const auto& m : f->get_missiles()) {
                bool found = false;
                for (const auto& em : all_missiles) {
                    if (em.get() == m.get()) { found = true; break; }
                }
                if (!found && m->state != Missile::State::ON_RAIL) {
                    all_missiles.push_back(m);
                    std::cout << "[" << elapsed << "s] " << f->get_name()
                              << " FIRES " << (m->type == Missile::Type::AIM120 ? "AIM-120" : "AIM-9")
                              << " at target " << m->target_id << std::endl;

                    MissileLog mlog;
                    mlog.id = m->id;
                    mlog.shooter_id = m->shooter_id;
                    mlog.target_id = m->target_id;
                    mlog.team = m->team;
                    mlog.type = m->type;
                    missile_logs.push_back(mlog);
                }
            }
        }

        // Update Red team
        for (auto& f : red_team) {
            if (!f->is_alive()) continue;

            f->update_radar(all_fighters);
            f->run_tactical_ai(red_ptrs, blue_ptrs, red_incoming);
            f->update(dt);

            // Check for new missiles
            for (const auto& m : f->get_missiles()) {
                bool found = false;
                for (const auto& em : all_missiles) {
                    if (em.get() == m.get()) { found = true; break; }
                }
                if (!found && m->state != Missile::State::ON_RAIL) {
                    all_missiles.push_back(m);
                    std::cout << "[" << elapsed << "s] " << f->get_name()
                              << " FIRES " << (m->type == Missile::Type::AIM120 ? "R-77" : "R-73")
                              << " at target " << m->target_id << std::endl;

                    MissileLog mlog;
                    mlog.id = m->id;
                    mlog.shooter_id = m->shooter_id;
                    mlog.target_id = m->target_id;
                    mlog.team = m->team;
                    mlog.type = m->type;
                    missile_logs.push_back(mlog);
                }
            }
        }

        // Update missiles and check for hits
        for (auto& m : all_missiles) {
            if (!m->is_active()) continue;

            // Find target
            Fighter* target = nullptr;
            for (auto& f : blue_team) {
                if (f->get_id() == m->target_id) target = f.get();
            }
            for (auto& f : red_team) {
                if (f->get_id() == m->target_id) target = f.get();
            }

            if (target && target->is_alive()) {
                FlightState tgt = target->get_flight_state();
                m->update(dt, tgt.latitude, tgt.longitude, tgt.altitude_msl);

                if (m->state == Missile::State::HIT) {
                    target->kill();
                    std::cout << "[" << elapsed << "s] *** " << target->get_name()
                              << " KILLED by missile! ***" << std::endl;

                    // Generate debris field from destroyed aircraft
                    auto debris = create_debris_field(
                        target->get_id(), target->get_team(),
                        tgt.latitude, tgt.longitude, tgt.altitude_msl,
                        tgt.heading, tgt.groundspeed, 12);

                    std::cout << "[" << elapsed << "s] " << debris.size()
                              << " debris pieces created from " << target->get_name() << std::endl;

                    // Create debris logs
                    for (auto& d : debris) {
                        DebrisLog dlog;
                        dlog.id = d.id;
                        dlog.source_fighter_id = d.source_fighter_id;
                        dlog.source_callsign = target->get_name();
                        dlog.team = d.team;
                        debris_logs.push_back(dlog);
                    }

                    // Add to active debris
                    for (auto& d : debris) {
                        all_debris.push_back(std::move(d));
                    }

                    // Record kill time in fighter log
                    for (auto& flog : fighter_logs) {
                        if (flog.callsign == target->get_name()) {
                            flog.kill_time = elapsed;
                        }
                    }
                }
            } else {
                m->state = Missile::State::MISS;
            }

            // Log missile position
            for (auto& mlog : missile_logs) {
                if (mlog.id == m->id && mlog.shooter_id == m->shooter_id) {
                    mlog.times.push_back(elapsed);
                    mlog.lats.push_back(m->lat);
                    mlog.lons.push_back(m->lon);
                    mlog.alts.push_back(m->alt);
                    mlog.final_state = m->state;
                }
            }
        }

        // Update debris
        int debris_still_falling = 0;
        for (auto& d : all_debris) {
            if (d.is_falling) {
                d.update(dt);
                debris_still_falling++;

                // Log debris position
                for (auto& dlog : debris_logs) {
                    if (dlog.id == d.id && dlog.source_fighter_id == d.source_fighter_id) {
                        dlog.times.push_back(elapsed);
                        dlog.lats.push_back(d.lat);
                        dlog.lons.push_back(d.lon);
                        dlog.alts.push_back(d.alt);

                        // Record impact time
                        if (!d.is_falling && dlog.impact_time < 0) {
                            dlog.impact_time = elapsed;
                        }
                    }
                }
            }
        }

        // Record fighter states
        if (elapsed - last_record >= record_interval) {
            int log_idx = 0;
            for (const auto& f : blue_team) {
                fighter_logs[log_idx].trajectory.push_back(f->get_flight_state());
                fighter_logs[log_idx].states.push_back(f->get_tactical_state());
                fighter_logs[log_idx].times.push_back(elapsed);
                log_idx++;
            }
            for (const auto& f : red_team) {
                fighter_logs[log_idx].trajectory.push_back(f->get_flight_state());
                fighter_logs[log_idx].states.push_back(f->get_tactical_state());
                fighter_logs[log_idx].times.push_back(elapsed);
                log_idx++;
            }
            last_record = elapsed;
        }

        // Count survivors
        blue_alive = 0;
        red_alive = 0;
        for (const auto& f : blue_team) if (f->is_alive()) blue_alive++;
        for (const auto& f : red_team) if (f->is_alive()) red_alive++;

        elapsed += dt;
    }

    // Final results
    std::cout << "\n================================================" << std::endl;
    std::cout << "   ENGAGEMENT COMPLETE" << std::endl;
    std::cout << "================================================" << std::endl;
    std::cout << "Duration: " << elapsed << " seconds (" << (elapsed/60.0) << " minutes)" << std::endl;
    std::cout << "\nBlue Team Survivors: " << blue_alive << "/4" << std::endl;
    for (const auto& f : blue_team) {
        std::cout << "  " << f->get_name() << ": "
                  << (f->is_alive() ? "ALIVE" : "KILLED")
                  << " - State: " << tactical_state_name(f->get_tactical_state())
                  << " - AIM-120: " << f->get_loadout().aim120_count
                  << " AIM-9: " << f->get_loadout().aim9_count << std::endl;
    }

    std::cout << "\nRed Team Survivors: " << red_alive << "/4" << std::endl;
    for (const auto& f : red_team) {
        std::cout << "  " << f->get_name() << ": "
                  << (f->is_alive() ? "ALIVE" : "KILLED")
                  << " - State: " << tactical_state_name(f->get_tactical_state())
                  << " - Missiles: " << f->get_loadout().aim120_count
                  << "/" << f->get_loadout().aim9_count << std::endl;
    }

    // Debris summary
    if (!debris_logs.empty()) {
        std::cout << "\nDebris: " << debris_logs.size() << " pieces tracked" << std::endl;
        int landed = 0;
        for (const auto& d : all_debris) {
            if (!d.is_falling) landed++;
        }
        std::cout << "  " << landed << " pieces landed" << std::endl;
    }

    // Export to JSON
    std::ofstream json("dogfight_data.json");
    json << std::fixed << std::setprecision(6);
    json << "{\n";
    json << "  \"metadata\": {\n";
    json << "    \"scenario\": \"4v4 Dogfight over Indiana\",\n";
    json << "    \"duration_s\": " << elapsed << ",\n";
    json << "    \"blue_survivors\": " << blue_alive << ",\n";
    json << "    \"red_survivors\": " << red_alive << ",\n";
    json << "    \"center_lat\": " << INDIANA_LAT << ",\n";
    json << "    \"center_lon\": " << INDIANA_LON << ",\n";
    json << "    \"debris_count\": " << debris_logs.size() << "\n";
    json << "  },\n";

    // Fighters
    json << "  \"fighters\": [\n";
    for (size_t f = 0; f < fighter_logs.size(); f++) {
        const auto& log = fighter_logs[f];
        json << "    {\n";
        json << "      \"callsign\": \"" << log.callsign << "\",\n";
        json << "      \"team\": \"" << (log.team == Team::BLUE ? "BLUE" : "RED") << "\",\n";
        json << "      \"trajectory\": [\n";
        for (size_t i = 0; i < log.trajectory.size(); i++) {
            const auto& fs = log.trajectory[i];
            json << "        {\"t\": " << log.times[i]
                 << ", \"lat\": " << fs.latitude
                 << ", \"lon\": " << fs.longitude
                 << ", \"alt\": " << fs.altitude_msl
                 << ", \"hdg\": " << fs.heading
                 << ", \"spd\": " << fs.groundspeed
                 << ", \"state\": \"" << tactical_state_name(log.states[i]) << "\""
                 << "}";
            if (i < log.trajectory.size() - 1) json << ",";
            json << "\n";
        }
        json << "      ]\n";
        json << "    }";
        if (f < fighter_logs.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ],\n";

    // Missiles
    json << "  \"missiles\": [\n";
    for (size_t m = 0; m < missile_logs.size(); m++) {
        const auto& mlog = missile_logs[m];
        json << "    {\n";
        json << "      \"id\": " << mlog.id << ",\n";
        json << "      \"shooter\": " << mlog.shooter_id << ",\n";
        json << "      \"target\": " << mlog.target_id << ",\n";
        json << "      \"team\": \"" << (mlog.team == Team::BLUE ? "BLUE" : "RED") << "\",\n";
        json << "      \"type\": \"" << (mlog.type == Missile::Type::AIM120 ? "AIM-120" : "AIM-9") << "\",\n";
        json << "      \"result\": \"" << (mlog.final_state == Missile::State::HIT ? "HIT" : "MISS") << "\",\n";
        json << "      \"trajectory\": [\n";
        for (size_t i = 0; i < mlog.times.size(); i++) {
            json << "        {\"t\": " << mlog.times[i]
                 << ", \"lat\": " << mlog.lats[i]
                 << ", \"lon\": " << mlog.lons[i]
                 << ", \"alt\": " << mlog.alts[i] << "}";
            if (i < mlog.times.size() - 1) json << ",";
            json << "\n";
        }
        json << "      ]\n";
        json << "    }";
        if (m < missile_logs.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ],\n";

    // Debris
    json << "  \"debris\": [\n";
    for (size_t d = 0; d < debris_logs.size(); d++) {
        const auto& dlog = debris_logs[d];
        json << "    {\n";
        json << "      \"id\": " << dlog.id << ",\n";
        json << "      \"source_fighter\": " << dlog.source_fighter_id << ",\n";
        json << "      \"source_callsign\": \"" << dlog.source_callsign << "\",\n";
        json << "      \"team\": \"" << (dlog.team == Team::BLUE ? "BLUE" : "RED") << "\",\n";
        json << "      \"impact_time\": " << dlog.impact_time << ",\n";
        json << "      \"trajectory\": [\n";
        for (size_t i = 0; i < dlog.times.size(); i++) {
            json << "        {\"t\": " << dlog.times[i]
                 << ", \"lat\": " << dlog.lats[i]
                 << ", \"lon\": " << dlog.lons[i]
                 << ", \"alt\": " << dlog.alts[i] << "}";
            if (i < dlog.times.size() - 1) json << ",";
            json << "\n";
        }
        json << "      ]\n";
        json << "    }";
        if (d < debris_logs.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ]\n";
    json << "}\n";
    json.close();

    std::cout << "\nExported to: dogfight_data.json" << std::endl;

    return 0;
}
