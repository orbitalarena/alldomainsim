/**
 * Figure of Merit - Base interface for spatial metrics
 *
 * Figures of Merit (FOMs) are scalar values computed across a spatial grid
 * that quantify some aspect of system performance. Examples include:
 * - GPS PDOP (Position Dilution of Precision)
 * - Sensor revisit time (time since last observation)
 * - Communication link availability
 * - Radar coverage probability
 */

#pragma once

#include "fom_grid.hpp"
#include <vector>
#include <string>
#include <memory>
#include <limits>

namespace sim {
namespace fom {

/**
 * A single frame of FOM data at a specific time
 */
struct FOMFrame {
    double time;                    // Simulation time (seconds)
    std::vector<double> values;     // FOM value for each grid cell

    FOMFrame() : time(0) {}
    FOMFrame(double t, size_t num_cells) : time(t), values(num_cells, 0.0) {}
};

/**
 * Metadata about the FOM computation
 */
struct FOMMetadata {
    std::string name;               // Human-readable name
    std::string unit;               // Unit of measurement
    double min_value;               // Minimum possible value
    double max_value;               // Maximum possible value
    double invalid_value;           // Value indicating invalid/no-data
    bool lower_is_better;           // True if lower values are better (e.g., PDOP)

    FOMMetadata()
        : name("Unknown")
        , unit("")
        , min_value(0)
        , max_value(100)
        , invalid_value(-1)
        , lower_is_better(true)
    {}
};

/**
 * Complete FOM result containing grid, metadata, and time series data
 */
struct FOMResult {
    FOMGrid grid;
    FOMMetadata metadata;
    std::vector<FOMFrame> frames;

    // Helper to get value at specific time and cell
    double get_value(size_t frame_idx, size_t cell_idx) const {
        if (frame_idx >= frames.size() || cell_idx >= frames[frame_idx].values.size()) {
            return metadata.invalid_value;
        }
        return frames[frame_idx].values[cell_idx];
    }

    // Compute statistics for a frame
    void compute_frame_stats(size_t frame_idx, double& min_val, double& max_val,
                            double& avg_val, int& valid_count) const {
        min_val = std::numeric_limits<double>::max();
        max_val = std::numeric_limits<double>::lowest();
        double sum = 0;
        valid_count = 0;

        if (frame_idx >= frames.size()) return;

        for (double v : frames[frame_idx].values) {
            if (v != metadata.invalid_value) {
                min_val = std::min(min_val, v);
                max_val = std::max(max_val, v);
                sum += v;
                valid_count++;
            }
        }

        avg_val = valid_count > 0 ? sum / valid_count : 0;
    }
};

/**
 * Abstract base class for Figure of Merit calculators
 */
class FigureOfMerit {
public:
    virtual ~FigureOfMerit() = default;

    /**
     * Get the metadata describing this FOM
     */
    virtual FOMMetadata get_metadata() const = 0;

    /**
     * Compute the FOM across the grid for a single time instant
     * @param time Simulation time in seconds
     * @return Vector of FOM values, one per grid cell
     */
    virtual std::vector<double> compute(double time) = 0;

    /**
     * Compute the FOM for a time series
     * @param start_time Start time in seconds
     * @param end_time End time in seconds
     * @param time_step Time step in seconds
     * @return Complete FOM result with all frames
     */
    virtual FOMResult compute_series(double start_time, double end_time, double time_step) {
        FOMResult result;
        result.metadata = get_metadata();
        result.grid = get_grid();

        for (double t = start_time; t <= end_time; t += time_step) {
            FOMFrame frame(t, result.grid.size());
            frame.values = compute(t);
            result.frames.push_back(std::move(frame));
        }

        return result;
    }

    /**
     * Get the grid being used for computation
     */
    virtual const FOMGrid& get_grid() const = 0;

protected:
    FOMGrid grid_;
};

} // namespace fom
} // namespace sim
