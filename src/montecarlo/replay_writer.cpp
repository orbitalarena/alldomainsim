#include "montecarlo/replay_writer.hpp"
#include "montecarlo/geo_utils.hpp"
#include "io/json_writer.hpp"
#include <cmath>
#include <algorithm>

namespace sim::mc {

static constexpr double OMEGA_EARTH = 7.2921159e-5;  // rad/s
static constexpr double DEG_TO_RAD = M_PI / 180.0;

void ReplayWriter::init(const std::vector<MCEntity>& entities,
                        double sample_interval) {
    sample_interval_ = sample_interval;
    next_sample_time_ = 0.0;
    sample_times_.clear();

    size_t n = entities.size();
    positions_.resize(n);
    death_times_.assign(n, -1.0);  // -1 = alive at end
    id_to_index_.clear();

    for (size_t i = 0; i < n; i++) {
        positions_[i].clear();
        positions_[i].reserve(
            static_cast<size_t>(600.0 / sample_interval) + 10);
        id_to_index_[entities[i].id] = i;
    }

    events_.clear();
}

static Vec3 entity_to_ecef(const MCEntity& e, double sim_time) {
    switch (e.physics_type) {
        case PhysicsType::ORBITAL_2BODY:
            return ReplayWriter::eci_to_ecef(e.eci_pos, sim_time);
        case PhysicsType::FLIGHT_3DOF:
        case PhysicsType::STATIC:
            return geodetic_to_ecef(e.geo_lat * DEG_TO_RAD,
                                    e.geo_lon * DEG_TO_RAD,
                                    e.geo_alt);
        default:
            return Vec3{0, 0, 0};
    }
}

bool ReplayWriter::sample(const MCWorld& world) {
    if (world.sim_time < next_sample_time_) return false;

    double t = world.sim_time;
    sample_times_.push_back(t);

    const auto& entities = world.entities();
    for (size_t i = 0; i < entities.size(); i++) {
        const auto& e = entities[i];
        if (e.active && !e.destroyed) {
            positions_[i].push_back(entity_to_ecef(e, t));
        } else if (!positions_[i].empty()) {
            // Dead entity: repeat last known position
            positions_[i].push_back(positions_[i].back());
        } else {
            // Dead before first sample (shouldn't happen, but guard)
            positions_[i].push_back(Vec3{0, 0, 0});
        }
    }

    next_sample_time_ = t + sample_interval_;
    return true;
}

void ReplayWriter::record_death(const std::string& id, double time) {
    auto it = id_to_index_.find(id);
    if (it != id_to_index_.end()) {
        death_times_[it->second] = time;
    }
}

void ReplayWriter::record_event(const ReplayEvent& evt) {
    events_.push_back(evt);
}

Vec3 ReplayWriter::eci_to_ecef(const Vec3& eci, double sim_time) {
    double gmst = OMEGA_EARTH * sim_time;
    double c = std::cos(gmst);
    double s = std::sin(gmst);
    return Vec3{
         c * eci.x + s * eci.y,
        -s * eci.x + c * eci.y,
         eci.z
    };
}

void ReplayWriter::write_json(std::ostream& out, const MCConfig& config,
                              const std::vector<MCEntity>& entities) {
    sim::JsonWriter w(out);

    w.begin_object();

    // ── format ──
    w.kv("format", "replay_v1");

    // ── config ──
    w.key("config").begin_object();
    w.kv("seed", config.base_seed);
    w.kv("duration", config.max_sim_time);
    w.kv("sampleInterval", config.sample_interval);
    w.end_object();

    // ── timeline ──
    w.key("timeline").begin_object();
    double end_time = sample_times_.empty() ? 0.0 : sample_times_.back();
    w.kv("endTime", end_time);
    w.key("sampleTimes").begin_array();
    for (double t : sample_times_) {
        w.value(t);
    }
    w.end_array();
    w.end_object();

    // ── entities ──
    w.key("entities").begin_array();
    for (size_t i = 0; i < entities.size(); i++) {
        const auto& e = entities[i];
        w.begin_object();
        w.kv("id", e.id);
        w.kv("name", e.name);
        w.kv("team", e.team);
        w.kv("type", e.type);

        const char* role_str = role_to_string(e.role);
        if (role_str[0] != '\0') {
            w.kv("role", role_str);
        } else {
            w.key("role").null_value();
        }

        if (death_times_[i] < 0) {
            w.key("deathTime").null_value();
        } else {
            w.kv("deathTime", death_times_[i]);
        }

        // Positions as flat arrays [x,y,z] for compactness
        w.key("positions").begin_array();
        for (const auto& pos : positions_[i]) {
            w.begin_array();
            w.value(pos.x);
            w.value(pos.y);
            w.value(pos.z);
            w.end_array();
        }
        w.end_array();

        w.end_object();
    }
    w.end_array();

    // ── events ──
    w.key("events").begin_array();
    // Sort events by time
    auto sorted_events = events_;
    std::sort(sorted_events.begin(), sorted_events.end(),
              [](const ReplayEvent& a, const ReplayEvent& b) {
                  return a.time < b.time;
              });

    for (const auto& evt : sorted_events) {
        w.begin_object();
        w.kv("time", evt.time);
        w.kv("type", evt.type);
        w.kv("sourceId", evt.source_id);
        w.kv("targetId", evt.target_id);
        w.key("sourcePosition").begin_array();
        w.value(evt.source_pos.x);
        w.value(evt.source_pos.y);
        w.value(evt.source_pos.z);
        w.end_array();
        w.key("targetPosition").begin_array();
        w.value(evt.target_pos.x);
        w.value(evt.target_pos.y);
        w.value(evt.target_pos.z);
        w.end_array();
        w.end_object();
    }
    w.end_array();

    // ── summary ──
    w.key("summary").begin_object();
    int blue_alive = 0, blue_total = 0;
    int red_alive = 0, red_total = 0;
    int total_kills = 0, total_launches = 0;

    for (size_t i = 0; i < entities.size(); i++) {
        const auto& e = entities[i];
        // Count all combatant entities (have AI or weapons)
        if (e.has_ai || e.has_weapon) {
            if (e.team == "blue") {
                blue_total++;
                if (death_times_[i] < 0) blue_alive++;
            } else if (e.team == "red") {
                red_total++;
                if (death_times_[i] < 0) red_alive++;
            }
        }
    }

    for (const auto& evt : events_) {
        if (evt.type == "KILL") total_kills++;
        if (evt.type == "LAUNCH") total_launches++;
    }

    w.kv("blueAlive", blue_alive);
    w.kv("blueTotal", blue_total);
    w.kv("redAlive", red_alive);
    w.kv("redTotal", red_total);
    w.kv("totalKills", total_kills);
    w.kv("totalLaunches", total_launches);
    w.end_object();

    w.end_object();
    out << '\n';
}

} // namespace sim::mc
