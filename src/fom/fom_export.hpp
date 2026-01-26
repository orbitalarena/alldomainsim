/**
 * FOM Export - JSON export utilities for Figure of Merit data
 *
 * Exports FOM results to JSON format for visualization with Cesium viewers.
 */

#pragma once

#include "figure_of_merit.hpp"
#include <fstream>
#include <iomanip>
#include <sstream>

namespace sim {
namespace fom {

/**
 * Export FOM result to JSON file
 */
class FOMExporter {
public:
    /**
     * Export FOM result to JSON file
     * @param result The FOM result to export
     * @param filename Output filename
     * @param extra_metadata Optional additional metadata to include
     */
    static void export_json(const FOMResult& result, const std::string& filename,
                           const std::string& extra_metadata = "") {
        std::ofstream out(filename);
        out << std::fixed << std::setprecision(4);

        out << "{\n";

        // Metadata
        out << "  \"metadata\": {\n";
        out << "    \"name\": \"" << result.metadata.name << "\",\n";
        out << "    \"unit\": \"" << result.metadata.unit << "\",\n";
        out << "    \"min_value\": " << result.metadata.min_value << ",\n";
        out << "    \"max_value\": " << result.metadata.max_value << ",\n";
        out << "    \"invalid_value\": " << result.metadata.invalid_value << ",\n";
        out << "    \"lower_is_better\": " << (result.metadata.lower_is_better ? "true" : "false") << ",\n";
        out << "    \"num_grid_cells\": " << result.grid.size() << ",\n";
        out << "    \"num_time_steps\": " << result.frames.size() << ",\n";
        out << "    \"grid_size_km\": " << result.grid.grid_size_km() << ",\n";
        out << "    \"smart_grid\": " << (result.grid.is_smart_grid() ? "true" : "false");

        if (!extra_metadata.empty()) {
            out << ",\n" << extra_metadata;
        }

        out << "\n  },\n";

        // Grid
        out << "  \"grid\": [\n";
        const auto& cells = result.grid.cells();
        for (size_t i = 0; i < cells.size(); i++) {
            out << "    {\"lat\": " << cells[i].lat << ", \"lon\": " << cells[i].lon << "}";
            if (i < cells.size() - 1) out << ",";
            out << "\n";
        }
        out << "  ],\n";

        // Frames
        out << "  \"frames\": [\n";
        for (size_t f = 0; f < result.frames.size(); f++) {
            const auto& frame = result.frames[f];
            out << "    {\n";
            out << "      \"t\": " << frame.time << ",\n";
            out << "      \"values\": [";

            for (size_t i = 0; i < frame.values.size(); i++) {
                out << std::setprecision(1) << frame.values[i];
                if (i < frame.values.size() - 1) out << ",";
            }
            out << "]\n";
            out << "    }";
            if (f < result.frames.size() - 1) out << ",";
            out << "\n";
        }
        out << "  ]\n";

        out << "}\n";
        out.close();
    }

    /**
     * Export with satellite trajectory data (for sensor revisit)
     */
    static void export_with_trajectory(const FOMResult& result,
                                       const std::vector<std::tuple<double, double, double, double>>& trajectory,
                                       const std::string& filename,
                                       const std::string& extra_metadata = "") {
        std::ofstream out(filename);
        out << std::fixed << std::setprecision(4);

        out << "{\n";

        // Metadata
        out << "  \"metadata\": {\n";
        out << "    \"name\": \"" << result.metadata.name << "\",\n";
        out << "    \"unit\": \"" << result.metadata.unit << "\",\n";
        out << "    \"min_value\": " << result.metadata.min_value << ",\n";
        out << "    \"max_value\": " << result.metadata.max_value << ",\n";
        out << "    \"invalid_value\": " << result.metadata.invalid_value << ",\n";
        out << "    \"lower_is_better\": " << (result.metadata.lower_is_better ? "true" : "false") << ",\n";
        out << "    \"num_grid_cells\": " << result.grid.size() << ",\n";
        out << "    \"num_time_steps\": " << result.frames.size() << ",\n";
        out << "    \"grid_size_km\": " << result.grid.grid_size_km() << ",\n";
        out << "    \"smart_grid\": " << (result.grid.is_smart_grid() ? "true" : "false");

        if (!extra_metadata.empty()) {
            out << ",\n" << extra_metadata;
        }

        out << "\n  },\n";

        // Grid
        out << "  \"grid\": [\n";
        const auto& cells = result.grid.cells();
        for (size_t i = 0; i < cells.size(); i++) {
            out << "    {\"lat\": " << cells[i].lat << ", \"lon\": " << cells[i].lon << "}";
            if (i < cells.size() - 1) out << ",";
            out << "\n";
        }
        out << "  ],\n";

        // Frames with trajectory
        out << "  \"frames\": [\n";
        for (size_t f = 0; f < result.frames.size(); f++) {
            const auto& frame = result.frames[f];
            out << "    {\n";
            out << "      \"t\": " << frame.time << ",\n";

            // Include satellite position if available
            if (f < trajectory.size()) {
                auto [t, lat, lon, alt] = trajectory[f];
                out << "      \"sat\": {\"lat\": " << lat << ", \"lon\": " << lon
                    << ", \"alt\": " << alt << "},\n";
            }

            out << "      \"age\": [";  // Use "age" for compatibility with existing viewer

            for (size_t i = 0; i < frame.values.size(); i++) {
                out << std::setprecision(1) << frame.values[i];
                if (i < frame.values.size() - 1) out << ",";
            }
            out << "]\n";
            out << "    }";
            if (f < result.frames.size() - 1) out << ",";
            out << "\n";
        }
        out << "  ]\n";

        out << "}\n";
        out.close();
    }
};

} // namespace fom
} // namespace sim
