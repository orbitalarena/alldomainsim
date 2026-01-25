#include "io/tle_parser.hpp"
#include <iostream>
#include <cmath>
#include <algorithm>

namespace sim {

std::vector<TLE> TLEParser::parse_file(const std::string& filename) {
    std::vector<TLE> tles;
    std::ifstream file(filename);
    
    if (!file.is_open()) {
        std::cerr << "ERROR: Could not open TLE file: " << filename << std::endl;
        return tles;
    }
    
    std::string line0, line1, line2;
    
    // Read three lines at a time
    while (std::getline(file, line0)) {
        // Skip empty lines
        if (line0.empty() || line0[0] == '#') continue;
        
        // Read line 1 and line 2
        if (!std::getline(file, line1) || !std::getline(file, line2)) {
            std::cerr << "WARNING: Incomplete TLE entry for: " << line0 << std::endl;
            break;
        }
        
        // Parse the three-line entry
        try {
            TLE tle = parse_three_line(line0, line1, line2);
            tles.push_back(tle);
        } catch (const std::exception& e) {
            std::cerr << "WARNING: Failed to parse TLE for " << line0 
                      << ": " << e.what() << std::endl;
        }
    }
    
    file.close();
    std::cout << "Loaded " << tles.size() << " TLEs from " << filename << std::endl;
    return tles;
}

TLE TLEParser::parse_three_line(const std::string& line0, 
                                  const std::string& line1, 
                                  const std::string& line2) {
    TLE tle;
    
    // Line 0: Satellite name
    tle.name = line0;
    // Trim whitespace
    tle.name.erase(tle.name.find_last_not_of(" \n\r\t") + 1);
    
    // Line 1: Basic orbital elements
    if (line1.length() < 69) {
        throw std::runtime_error("Line 1 too short");
    }
    
    tle.satellite_number = parse_int(line1, 2, 5);
    tle.classification = line1[7];
    tle.launch_year = parse_int(line1, 9, 2);
    tle.launch_number = parse_int(line1, 11, 3);
    tle.launch_piece = line1.substr(14, 3);
    tle.epoch_year = parse_int(line1, 18, 2);
    tle.epoch_day = parse_decimal(line1, 20, 12);
    tle.mean_motion_derivative = parse_decimal(line1, 33, 10);
    tle.mean_motion_second_derivative = parse_exponential(line1, 44, 8);
    tle.bstar_drag = parse_exponential(line1, 53, 8);
    tle.ephemeris_type = parse_int(line1, 62, 1);
    tle.element_set_number = parse_int(line1, 64, 4);
    
    // Line 2: Orbital elements
    if (line2.length() < 69) {
        throw std::runtime_error("Line 2 too short");
    }
    
    tle.inclination = parse_decimal(line2, 8, 8);
    tle.raan = parse_decimal(line2, 17, 8);
    tle.eccentricity = parse_decimal(line2, 26, 7) / 1e7; // Implied decimal point
    tle.arg_perigee = parse_decimal(line2, 34, 8);
    tle.mean_anomaly = parse_decimal(line2, 43, 8);
    tle.mean_motion = parse_decimal(line2, 52, 11);
    tle.revolution_number = parse_int(line2, 63, 5);
    
    return tle;
}

double TLEParser::parse_decimal(const std::string& str, int start, int length) {
    std::string substr = str.substr(start, length);
    // Remove leading/trailing whitespace
    substr.erase(0, substr.find_first_not_of(" \t"));
    substr.erase(substr.find_last_not_of(" \t") + 1);
    
    if (substr.empty()) return 0.0;
    return std::stod(substr);
}

double TLEParser::parse_exponential(const std::string& str, int start, int length) {
    // TLE exponential format: -12345-6 means -0.12345e-6
    std::string substr = str.substr(start, length);
    
    // Remove whitespace
    substr.erase(0, substr.find_first_not_of(" \t"));
    substr.erase(substr.find_last_not_of(" \t") + 1);
    
    if (substr.empty() || substr == "00000-0" || substr == "00000+0") return 0.0;
    
    // Extract sign, mantissa, exponent
    char sign = (substr[0] == '-') ? '-' : '+';
    std::string mantissa = substr.substr((substr[0] == '-' || substr[0] == '+') ? 1 : 0, 5);
    char exp_sign = substr[substr.length() - 2];
    char exp_digit = substr[substr.length() - 1];
    
    // Build proper exponential string
    std::string value_str = std::string(1, sign) + "0." + mantissa + "e" + exp_sign + exp_digit;
    
    return std::stod(value_str);
}

int TLEParser::parse_int(const std::string& str, int start, int length) {
    std::string substr = str.substr(start, length);
    // Remove leading/trailing whitespace
    substr.erase(0, substr.find_first_not_of(" \t"));
    substr.erase(substr.find_last_not_of(" \t") + 1);
    
    if (substr.empty()) return 0;
    return std::stoi(substr);
}

} // namespace sim
