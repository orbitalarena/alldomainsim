#include <iostream>
#include <fstream>
#include <iomanip>
#include <vector>
#include <cmath>

#include "entities/aircraft.hpp"

using namespace sim;

// Airport coordinates
constexpr double ORD_LAT = 41.9742;   // Chicago O'Hare
constexpr double ORD_LON = -87.9073;
constexpr double JFK_LAT = 40.6413;   // New York JFK
constexpr double JFK_LON = -73.7781;

// Flight parameters
constexpr double CRUISE_ALTITUDE_FT = 35000.0;
constexpr double CRUISE_ALTITUDE_M = CRUISE_ALTITUDE_FT * 0.3048;
constexpr double CRUISE_SPEED_KTS = 450.0;
constexpr double CRUISE_SPEED_MS = CRUISE_SPEED_KTS * 0.514444;

int main() {
    std::cout << std::fixed << std::setprecision(2);
    std::cout << "========================================" << std::endl;
    std::cout << "  Flight Simulation: ORD -> JFK" << std::endl;
    std::cout << "  Chicago O'Hare to New York JFK" << std::endl;
    std::cout << "========================================" << std::endl;

    // Create aircraft configuration (Boeing 737-800 like)
    AircraftConfig config;
    config.name = "Boeing 737-800";
    config.model_path = "models/737.glb";

    // Mass
    config.empty_mass = 41413.0;      // kg
    config.max_fuel = 20894.0;        // kg (26,020 liters)
    config.payload_mass = 16000.0;    // kg (passengers + cargo)

    // Aerodynamics
    config.wing_area = 124.6;         // m²
    config.wing_span = 35.8;          // m
    config.aspect_ratio = 10.3;
    config.oswald_efficiency = 0.85;
    config.cd0 = 0.024;
    config.cl_max = 2.1;

    // Engines (CFM56-7B)
    config.num_engines = 2;
    config.max_thrust_per_engine = 121400.0;  // N (27,300 lbf)
    config.tsfc = 0.06;               // kg/(N*hr) - converted from 0.55 lb/(lbf*hr)

    // Performance
    config.max_mach = 0.82;
    config.service_ceiling = 12500.0; // m (41,000 ft)
    config.max_bank_angle = 30.0;
    config.max_climb_rate = 20.0;     // m/s
    config.max_descent_rate = 15.0;   // m/s

    // Create aircraft
    Aircraft aircraft(1, "UAL123", config);

    // Set initial position at O'Hare
    aircraft.set_initial_position(ORD_LAT, ORD_LON, 0.0);
    aircraft.set_fuel(config.max_fuel * 0.6);  // 60% fuel (enough for ~1200 km flight)

    // Create flight plan
    std::vector<Waypoint> route = create_flight_route(
        "KORD", ORD_LAT, ORD_LON,
        "KJFK", JFK_LAT, JFK_LON,
        CRUISE_ALTITUDE_M, CRUISE_SPEED_MS,
        8  // Number of intermediate waypoints
    );

    aircraft.set_flight_plan(route);

    // Set wind field (typical westerlies)
    std::vector<WindVector> winds = {
        {5.0,  270.0, 0.0},       // Surface: 5 m/s from west
        {15.0, 280.0, 3000.0},    // 10,000 ft: 15 m/s from west-northwest
        {30.0, 285.0, 6000.0},    // 20,000 ft: 30 m/s
        {45.0, 290.0, 9000.0},    // 30,000 ft: 45 m/s (jet stream)
        {55.0, 290.0, 10500.0},   // 35,000 ft: 55 m/s (core jet stream)
        {40.0, 285.0, 12000.0},   // 40,000 ft: 40 m/s
    };
    aircraft.set_wind_field(winds);

    std::cout << "\nAircraft: " << config.name << std::endl;
    std::cout << "Callsign: UAL123" << std::endl;
    std::cout << "Route: KORD -> KJFK" << std::endl;
    std::cout << "Distance: ~1180 km (735 nm)" << std::endl;
    std::cout << "Cruise altitude: " << CRUISE_ALTITUDE_FT << " ft" << std::endl;
    std::cout << "Cruise speed: " << CRUISE_SPEED_KTS << " kts TAS" << std::endl;

    std::cout << "\nFlight plan waypoints:" << std::endl;
    for (size_t i = 0; i < route.size(); i++) {
        const auto& wp = route[i];
        std::cout << "  " << i << ". " << wp.name
                  << " (" << wp.latitude << "°, " << wp.longitude << "°)"
                  << " ALT: " << (wp.altitude / 0.3048) << " ft" << std::endl;
    }

    // Simulation parameters
    double dt = 1.0;          // 1 second timestep
    double max_time = 4 * 3600.0;  // Max 4 hours
    double record_interval = 10.0;  // Record every 10 seconds

    // Start flight
    aircraft.set_throttle(1.0);  // Full throttle for takeoff

    std::vector<FlightState> flight_log;
    double last_record_time = 0.0;

    std::cout << "\n=== Beginning Flight Simulation ===" << std::endl;
    std::cout << "Time step: " << dt << " s" << std::endl;

    // Run simulation
    double elapsed = 0.0;
    int last_phase = -1;

    while (elapsed < max_time && !aircraft.has_reached_destination()) {
        aircraft.update(dt);
        elapsed += dt;

        FlightState fs = aircraft.get_flight_state();

        // Phase change announcements
        if ((int)fs.phase != last_phase) {
            last_phase = (int)fs.phase;
            std::string phase_name;
            switch (fs.phase) {
                case FlightPhase::PARKED: phase_name = "PARKED"; break;
                case FlightPhase::TAXI: phase_name = "TAXI"; break;
                case FlightPhase::TAKEOFF: phase_name = "TAKEOFF"; break;
                case FlightPhase::CLIMB: phase_name = "CLIMB"; break;
                case FlightPhase::CRUISE: phase_name = "CRUISE"; break;
                case FlightPhase::DESCENT: phase_name = "DESCENT"; break;
                case FlightPhase::APPROACH: phase_name = "APPROACH"; break;
                case FlightPhase::LANDING: phase_name = "LANDING"; break;
                case FlightPhase::LANDED: phase_name = "LANDED"; break;
            }
            std::cout << "\n[" << (elapsed / 60.0) << " min] Phase: " << phase_name << std::endl;
        }

        // Record state
        if (elapsed - last_record_time >= record_interval) {
            flight_log.push_back(fs);
            last_record_time = elapsed;

            // Progress update every 5 minutes
            if ((int)(elapsed / 60.0) % 5 == 0 && std::fmod(elapsed, 60.0) < record_interval) {
                std::cout << "  T+" << std::setw(6) << (elapsed / 60.0) << " min"
                          << " | ALT: " << std::setw(6) << (fs.altitude_msl / 0.3048) << " ft"
                          << " | GS: " << std::setw(5) << (fs.groundspeed / 0.514444) << " kts"
                          << " | HDG: " << std::setw(5) << fs.heading << "°"
                          << " | FUEL: " << std::setw(6) << fs.fuel_remaining << " kg"
                          << std::endl;
            }
        }
    }

    // Final status
    FlightState final_state = aircraft.get_flight_state();
    std::cout << "\n========================================" << std::endl;
    std::cout << "  FLIGHT COMPLETE" << std::endl;
    std::cout << "========================================" << std::endl;
    std::cout << "Total flight time: " << (elapsed / 60.0) << " minutes ("
              << (elapsed / 3600.0) << " hours)" << std::endl;
    std::cout << "Final position: " << final_state.latitude << "°, "
              << final_state.longitude << "°" << std::endl;
    std::cout << "Fuel remaining: " << final_state.fuel_remaining << " kg" << std::endl;
    std::cout << "Fuel burned: " << (config.max_fuel * 0.6 - final_state.fuel_remaining) << " kg" << std::endl;

    // Export to JSON for Cesium visualization
    std::ofstream json("ord_jfk_flight.json");
    json << std::fixed << std::setprecision(6);
    json << "{\n";
    json << "  \"metadata\": {\n";
    json << "    \"aircraft\": \"" << config.name << "\",\n";
    json << "    \"callsign\": \"UAL123\",\n";
    json << "    \"departure\": \"KORD\",\n";
    json << "    \"departure_name\": \"Chicago O'Hare International\",\n";
    json << "    \"arrival\": \"KJFK\",\n";
    json << "    \"arrival_name\": \"New York John F. Kennedy International\",\n";
    json << "    \"flight_time_hours\": " << (elapsed / 3600.0) << ",\n";
    json << "    \"distance_km\": 1180,\n";
    json << "    \"cruise_altitude_ft\": " << CRUISE_ALTITUDE_FT << ",\n";
    json << "    \"cruise_speed_kts\": " << CRUISE_SPEED_KTS << ",\n";
    json << "    \"fuel_burned_kg\": " << (config.max_fuel * 0.6 - final_state.fuel_remaining) << ",\n";
    json << "    \"record_interval_s\": " << record_interval << "\n";
    json << "  },\n";

    // Flight plan
    json << "  \"flight_plan\": [\n";
    for (size_t i = 0; i < route.size(); i++) {
        const auto& wp = route[i];
        json << "    {\"name\": \"" << wp.name << "\""
             << ", \"lat\": " << wp.latitude
             << ", \"lon\": " << wp.longitude
             << ", \"alt_m\": " << wp.altitude
             << "}";
        if (i < route.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ],\n";

    // Wind data
    json << "  \"wind_field\": [\n";
    for (size_t i = 0; i < winds.size(); i++) {
        json << "    {\"speed_ms\": " << winds[i].speed
             << ", \"direction_deg\": " << winds[i].direction
             << ", \"altitude_m\": " << winds[i].altitude << "}";
        if (i < winds.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ],\n";

    // Flight trajectory
    json << "  \"trajectory\": [\n";
    for (size_t i = 0; i < flight_log.size(); i++) {
        const auto& fs = flight_log[i];
        json << "    {\"time\": " << fs.time
             << ", \"lat\": " << fs.latitude
             << ", \"lon\": " << fs.longitude
             << ", \"alt\": " << fs.altitude_msl
             << ", \"heading\": " << fs.heading
             << ", \"pitch\": " << fs.pitch
             << ", \"bank\": " << fs.bank
             << ", \"groundspeed\": " << fs.groundspeed
             << ", \"airspeed\": " << fs.true_airspeed
             << ", \"mach\": " << fs.mach_number
             << ", \"vertical_speed\": " << fs.vertical_speed
             << ", \"throttle\": " << fs.throttle
             << ", \"fuel\": " << fs.fuel_remaining
             << ", \"phase\": " << (int)fs.phase
             << ", \"wind_speed\": " << fs.wind_speed
             << ", \"wind_dir\": " << fs.wind_direction
             << "}";
        if (i < flight_log.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ]\n";
    json << "}\n";
    json.close();

    std::cout << "\nExported flight data to: ord_jfk_flight.json" << std::endl;
    std::cout << "Trajectory points: " << flight_log.size() << std::endl;

    return 0;
}
