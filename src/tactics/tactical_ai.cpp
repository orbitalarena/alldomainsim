#include "tactical_ai.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

const char* tactical_state_to_string(TacticalState state) {
    switch (state) {
        case TacticalState::PATROL:    return "PATROL";
        case TacticalState::DETECTED:  return "DETECTED";
        case TacticalState::COMMIT:    return "COMMIT";
        case TacticalState::LAUNCH:    return "LAUNCH";
        case TacticalState::CRANK:     return "CRANK";
        case TacticalState::PUMP:      return "PUMP";
        case TacticalState::DEFEND:    return "DEFEND";
        case TacticalState::MERGE:     return "MERGE";
        case TacticalState::DISENGAGE: return "DISENGAGE";
        case TacticalState::KILLED:    return "KILLED";
        default:                       return "UNKNOWN";
    }
}

double normalize_heading(double heading) {
    while (heading < 0.0) heading += 360.0;
    while (heading >= 360.0) heading -= 360.0;
    return heading;
}

double heading_difference(double h1, double h2) {
    double diff = h2 - h1;
    while (diff > 180.0) diff -= 360.0;
    while (diff < -180.0) diff += 360.0;
    return diff;
}

double compute_bearing(double own_lat, double own_lon, double tgt_lat, double tgt_lon) {
    double lat1 = own_lat * M_PI / 180.0;
    double lat2 = tgt_lat * M_PI / 180.0;
    double dlon = (tgt_lon - own_lon) * M_PI / 180.0;

    double y = std::sin(dlon) * std::cos(lat2);
    double x = std::cos(lat1) * std::sin(lat2) - std::sin(lat1) * std::cos(lat2) * std::cos(dlon);

    double bearing = std::atan2(y, x) * 180.0 / M_PI;
    return normalize_heading(bearing);
}

double compute_range_km(double own_lat, double own_lon, double tgt_lat, double tgt_lon) {
    const double R = 6371.0;  // Earth radius in km

    double lat1 = own_lat * M_PI / 180.0;
    double lat2 = tgt_lat * M_PI / 180.0;
    double dlat = (tgt_lat - own_lat) * M_PI / 180.0;
    double dlon = (tgt_lon - own_lon) * M_PI / 180.0;

    double a = std::sin(dlat/2) * std::sin(dlat/2) +
               std::cos(lat1) * std::cos(lat2) *
               std::sin(dlon/2) * std::sin(dlon/2);

    double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1-a));
    return R * c;
}

TacticalAI::TacticalAI(const EngagementParams& params)
    : params_(params)
    , bvr_remaining_(params.bvr_missiles)
    , wvr_remaining_(params.wvr_missiles)
    , guns_remaining_(params.guns_rounds) {
}

TargetInfo* TacticalAI::select_priority_target(std::vector<TargetInfo>& targets) {
    TargetInfo* best = nullptr;
    double best_score = -1e12;

    for (auto& t : targets) {
        if (!t.is_hostile) continue;

        // Scoring: closer = higher priority, head-on = higher
        double score = 0.0;

        // Range factor (closer is better, but not too close)
        if (t.range_km < params_.wvr_range_km) {
            score += 100.0;  // Immediate threat
        } else if (t.range_km < params_.bvr_max_range_km) {
            score += 50.0 * (params_.bvr_max_range_km - t.range_km) / params_.bvr_max_range_km;
        }

        // Aspect factor (head-on is higher threat)
        double aspect_factor = std::abs(std::cos(t.aspect_deg * M_PI / 180.0));
        score += 20.0 * aspect_factor;

        // Closure rate (closing fast = higher threat)
        if (t.closure_rate_mps > 0) {
            score += t.closure_rate_mps / 10.0;
        }

        if (score > best_score) {
            best_score = score;
            best = &t;
        }
    }

    return best;
}

double TacticalAI::compute_intercept_heading(double own_heading, const TargetInfo& target) {
    // Simple: head directly toward target
    return normalize_heading(own_heading + target.bearing_deg);
}

double TacticalAI::compute_crank_heading(double own_heading, const TargetInfo& target) {
    // Turn to put target at crank angle off nose
    double target_bearing = normalize_heading(own_heading + target.bearing_deg);

    // Crank left or right (choose based on current relative bearing)
    double crank_dir = (target.bearing_deg > 0) ? -1.0 : 1.0;
    return normalize_heading(target_bearing + crank_dir * params_.crank_angle_deg);
}

TacticalDecision TacticalAI::update(
    TacticalState current_state,
    double own_heading,
    double own_altitude,
    double own_speed,
    const std::vector<TargetInfo>& targets,
    double time_in_state) {

    TacticalDecision decision;
    decision.new_state = current_state;
    decision.commanded_heading_deg = own_heading;
    decision.commanded_altitude_m = own_altitude;
    decision.commanded_speed_mps = own_speed;
    decision.fire_bvr = false;
    decision.fire_wvr = false;
    decision.fire_guns = false;
    decision.target_id = -1;
    decision.reason = "";

    // Make a mutable copy for target selection
    std::vector<TargetInfo> mutable_targets = targets;

    // Find hostile targets
    std::vector<TargetInfo*> hostile_targets;
    for (auto& t : mutable_targets) {
        if (t.is_hostile) {
            hostile_targets.push_back(&t);
        }
    }

    // Check for incoming threats (anyone shooting at us)
    bool under_attack = false;
    for (const auto& t : targets) {
        if (t.is_hostile && t.closure_rate_mps > 200.0 && t.range_km < params_.bvr_max_range_km) {
            under_attack = true;
            break;
        }
    }

    // State machine
    switch (current_state) {
        case TacticalState::PATROL: {
            // Searching - maintain patrol heading
            if (!hostile_targets.empty()) {
                decision.new_state = TacticalState::DETECTED;
                decision.reason = "Contact detected";
            }
            break;
        }

        case TacticalState::DETECTED: {
            // Evaluate and decide to engage
            TargetInfo* priority = select_priority_target(mutable_targets);
            if (!priority) {
                decision.new_state = TacticalState::PATROL;
                decision.reason = "Lost contact";
                break;
            }

            decision.target_id = priority->id;

            if (priority->range_km < params_.commit_range_km) {
                decision.new_state = TacticalState::COMMIT;
                decision.commanded_heading_deg = compute_intercept_heading(own_heading, *priority);
                decision.reason = "Committing to engagement";
            } else {
                // Continue tracking, close range
                decision.commanded_heading_deg = compute_intercept_heading(own_heading, *priority);
                decision.reason = "Tracking, closing";
            }
            break;
        }

        case TacticalState::COMMIT: {
            TargetInfo* priority = select_priority_target(mutable_targets);
            if (!priority) {
                decision.new_state = TacticalState::PATROL;
                decision.reason = "Lost target";
                break;
            }

            decision.target_id = priority->id;
            decision.commanded_heading_deg = compute_intercept_heading(own_heading, *priority);

            // Check for launch opportunity
            if (priority->range_km < params_.bvr_max_range_km &&
                priority->range_km > params_.bvr_min_range_km &&
                bvr_remaining_ > 0 &&
                time_since_last_shot_ > params_.reattack_delay_s) {

                decision.new_state = TacticalState::LAUNCH;
                decision.fire_bvr = true;
                decision.reason = "FOX THREE - BVR launch";
                time_since_last_shot_ = 0.0;
            }
            else if (priority->range_km < params_.merge_range_km) {
                decision.new_state = TacticalState::MERGE;
                decision.reason = "Merge range";
            }
            else if (under_attack) {
                decision.new_state = TacticalState::DEFEND;
                decision.reason = "Defensive - threat inbound";
            }
            break;
        }

        case TacticalState::LAUNCH: {
            // Transition to crank after launch
            TargetInfo* priority = select_priority_target(mutable_targets);
            if (priority) {
                decision.target_id = priority->id;
                decision.commanded_heading_deg = compute_crank_heading(own_heading, *priority);
            }
            decision.new_state = TacticalState::CRANK;
            decision.reason = "Post-launch crank";
            break;
        }

        case TacticalState::CRANK: {
            // Maintain crank maneuver
            TargetInfo* priority = select_priority_target(mutable_targets);
            if (priority) {
                decision.target_id = priority->id;
                decision.commanded_heading_deg = compute_crank_heading(own_heading, *priority);

                if (time_in_state > params_.crank_duration_s) {
                    // Decide: recommit or pump
                    if (priority->range_km < params_.bvr_min_range_km) {
                        decision.new_state = TacticalState::MERGE;
                        decision.reason = "Crank complete, merge";
                    } else if (bvr_remaining_ > 0) {
                        decision.new_state = TacticalState::COMMIT;
                        decision.reason = "Crank complete, recommit";
                    } else {
                        decision.new_state = TacticalState::PUMP;
                        decision.reason = "Crank complete, pumping";
                    }
                }
            } else {
                decision.new_state = TacticalState::PATROL;
                decision.reason = "Target lost during crank";
            }
            break;
        }

        case TacticalState::PUMP: {
            // Turn away then recommit
            if (time_in_state < params_.pump_duration_s / 2.0) {
                // Turning away
                decision.commanded_heading_deg = normalize_heading(own_heading + 90.0);
                decision.reason = "Pump - extending";
            } else {
                // Turn back
                decision.new_state = TacticalState::COMMIT;
                decision.reason = "Pump complete, recommit";
            }
            break;
        }

        case TacticalState::DEFEND: {
            // Defensive maneuvers
            // Turn perpendicular to threat, descend, increase speed
            TargetInfo* threat = nullptr;
            for (auto* t : hostile_targets) {
                if (t->closure_rate_mps > 200.0) {
                    threat = t;
                    break;
                }
            }

            if (threat) {
                // Beam the threat (turn perpendicular)
                double threat_heading = normalize_heading(own_heading + threat->bearing_deg);
                decision.commanded_heading_deg = normalize_heading(threat_heading + 90.0);
                decision.commanded_altitude_m = own_altitude - 1000.0;  // Descend
                decision.reason = "Defensive - beaming threat";

                if (threat->range_km > params_.escape_range_km) {
                    decision.new_state = TacticalState::COMMIT;
                    decision.reason = "Threat evaded, recommit";
                }
            } else {
                decision.new_state = TacticalState::COMMIT;
                decision.reason = "No immediate threat";
            }
            break;
        }

        case TacticalState::MERGE: {
            // Close range fight
            TargetInfo* priority = select_priority_target(mutable_targets);
            if (priority) {
                decision.target_id = priority->id;
                decision.commanded_heading_deg = compute_intercept_heading(own_heading, *priority);

                if (priority->range_km < params_.guns_range_km && guns_remaining_ > 0) {
                    decision.fire_guns = true;
                    decision.reason = "GUNS GUNS GUNS";
                } else if (priority->range_km < params_.wvr_range_km && wvr_remaining_ > 0) {
                    decision.fire_wvr = true;
                    decision.reason = "FOX TWO - WVR launch";
                }

                // Check if should disengage
                if (bvr_remaining_ == 0 && wvr_remaining_ == 0 && guns_remaining_ < 100) {
                    decision.new_state = TacticalState::DISENGAGE;
                    decision.reason = "Winchester - disengaging";
                }
            } else {
                decision.new_state = TacticalState::PATROL;
                decision.reason = "Lost target in merge";
            }
            break;
        }

        case TacticalState::DISENGAGE: {
            // Break off and extend
            TargetInfo* nearest = nullptr;
            double min_range = 1e12;
            for (auto* t : hostile_targets) {
                if (t->range_km < min_range) {
                    min_range = t->range_km;
                    nearest = t;
                }
            }

            if (nearest) {
                // Turn away from nearest threat
                double threat_bearing = normalize_heading(own_heading + nearest->bearing_deg);
                decision.commanded_heading_deg = normalize_heading(threat_bearing + 180.0);
                decision.reason = "Extending from threat";

                if (nearest->range_km > params_.escape_range_km) {
                    decision.new_state = TacticalState::PATROL;
                    decision.reason = "Safe distance, returning to patrol";
                }
            } else {
                decision.new_state = TacticalState::PATROL;
                decision.reason = "No threats, returning to patrol";
            }
            break;
        }

        case TacticalState::KILLED: {
            // Dead - no decisions
            decision.reason = "Aircraft destroyed";
            break;
        }
    }

    time_since_last_shot_ += 0.1;  // Assume 0.1s update rate

    return decision;
}

} // namespace sim
