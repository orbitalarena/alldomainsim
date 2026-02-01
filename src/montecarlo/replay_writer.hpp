/**
 * ReplayWriter — Collects trajectory samples and writes replay JSON.
 *
 * During simulation, samples ECEF positions at configurable intervals.
 * At the end, writes a replay JSON file that the browser Cesium viewer
 * can load for 3D playback with timeline scrubbing.
 *
 * ECI → ECEF conversion uses GMST rotation (GMST=0 at simTime=0).
 */

#ifndef SIM_MC_REPLAY_WRITER_HPP
#define SIM_MC_REPLAY_WRITER_HPP

#include "mc_world.hpp"
#include "scenario_parser.hpp"
#include <vector>
#include <string>
#include <ostream>
#include <unordered_map>

namespace sim::mc {

struct ReplayEvent {
    double time;
    std::string type;       // "KILL", "MISS", "LAUNCH"
    std::string source_id;
    std::string target_id;
    Vec3 source_pos;        // ECEF at event time
    Vec3 target_pos;        // ECEF at event time
};

class ReplayWriter {
public:
    ReplayWriter() = default;

    /**
     * Initialize with entity list and sample interval.
     * Must be called before any sample() calls.
     */
    void init(const std::vector<MCEntity>& entities, double sample_interval);

    /**
     * Sample all entity positions if sim_time >= next_sample_time.
     * Converts ECI → ECEF using GMST rotation.
     * Returns true if a sample was taken.
     */
    bool sample(const MCWorld& world);

    /**
     * Record an entity death (for truncating position arrays).
     */
    void record_death(const std::string& id, double time);

    /**
     * Record an engagement event with positions.
     */
    void record_event(const ReplayEvent& evt);

    /**
     * Write the complete replay JSON to the output stream.
     */
    void write_json(std::ostream& out, const MCConfig& config,
                    const std::vector<MCEntity>& entities);

    /**
     * Convert ECI position to ECEF using GMST rotation.
     * GMST = OMEGA_EARTH * simTime (GMST=0 at t=0).
     */
    static Vec3 eci_to_ecef(const Vec3& eci, double sim_time);

private:
    double sample_interval_ = 2.0;
    double next_sample_time_ = 0.0;
    std::vector<double> sample_times_;

    // Per-entity trajectory: indexed by entity order in the entities vector
    std::vector<std::vector<Vec3>> positions_;   // ECEF positions
    std::vector<double> death_times_;            // -1 if alive at end

    // Entity ID → index mapping
    std::unordered_map<std::string, size_t> id_to_index_;

    // Engagement events
    std::vector<ReplayEvent> events_;
};

} // namespace sim::mc

#endif // SIM_MC_REPLAY_WRITER_HPP
