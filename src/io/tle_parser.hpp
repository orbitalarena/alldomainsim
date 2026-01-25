#ifndef TLE_PARSER_HPP
#define TLE_PARSER_HPP

#include <string>
#include <vector>
#include <fstream>
#include <sstream>

namespace sim {

/**
 * @brief Two-Line Element (TLE) data structure
 * 
 * Standard format used by NORAD/CelesTrak for satellite orbital elements
 */
struct TLE {
    std::string name;
    
    // Line 1
    int satellite_number;
    char classification;
    int launch_year;
    int launch_number;
    std::string launch_piece;
    int epoch_year;
    double epoch_day;
    double mean_motion_derivative;      // First derivative of mean motion
    double mean_motion_second_derivative; // Second derivative of mean motion
    double bstar_drag;                  // B* drag term
    int ephemeris_type;
    int element_set_number;
    
    // Line 2
    double inclination;        // [degrees]
    double raan;               // Right Ascension of Ascending Node [degrees]
    double eccentricity;       // [dimensionless]
    double arg_perigee;        // Argument of Perigee [degrees]
    double mean_anomaly;       // [degrees]
    double mean_motion;        // [revolutions per day]
    int revolution_number;
    
    TLE() : satellite_number(0), classification('U'), launch_year(0), 
            launch_number(0), epoch_year(0), epoch_day(0.0),
            mean_motion_derivative(0.0), mean_motion_second_derivative(0.0),
            bstar_drag(0.0), ephemeris_type(0), element_set_number(0),
            inclination(0.0), raan(0.0), eccentricity(0.0),
            arg_perigee(0.0), mean_anomaly(0.0), mean_motion(0.0),
            revolution_number(0) {}
};

/**
 * @brief Parser for TLE files
 */
class TLEParser {
public:
    /**
     * @brief Parse a TLE file containing multiple satellites
     * @param filename Path to the TLE file
     * @return Vector of parsed TLE structures
     */
    static std::vector<TLE> parse_file(const std::string& filename);
    
    /**
     * @brief Parse a single three-line TLE entry
     * @param line0 Satellite name
     * @param line1 TLE line 1
     * @param line2 TLE line 2
     * @return Parsed TLE structure
     */
    static TLE parse_three_line(const std::string& line0, 
                                 const std::string& line1, 
                                 const std::string& line2);

private:
    static double parse_decimal(const std::string& str, int start, int length);
    static double parse_exponential(const std::string& str, int start, int length);
    static int parse_int(const std::string& str, int start, int length);
};

} // namespace sim

#endif // TLE_PARSER_HPP
