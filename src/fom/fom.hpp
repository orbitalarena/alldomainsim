/**
 * Figures of Merit - Main include header
 *
 * Include this header to access all FOM functionality:
 * - FOMGrid: Spatial grid for FOM calculations
 * - FigureOfMerit: Base interface
 * - GPSPDOP: GPS Position Dilution of Precision
 * - SensorRevisit: Sensor revisit time tracking
 * - FOMExporter: JSON export utilities
 *
 * Example usage:
 *
 *   // Create a global grid
 *   auto grid = FOMGrid::create_global(50.0);  // 50km cells
 *
 *   // Create a sensor revisit calculator
 *   auto revisit = SensorRevisit::single_satellite(grid, 400.0, 51.6, 25.0);
 *
 *   // Compute over 30 minutes
 *   auto result = revisit.compute_series(0, 1800, 2.0);
 *
 *   // Export to JSON
 *   FOMExporter::export_json(result, "output.json");
 */

#pragma once

#include "fom_grid.hpp"
#include "figure_of_merit.hpp"
#include "gps_pdop.hpp"
#include "sensor_revisit.hpp"
#include "fom_export.hpp"
