#ifndef TIME_UTILS_HPP
#define TIME_UTILS_HPP

#include <string>

namespace sim {

/**
 * @brief Time conversion utilities for orbital mechanics
 *
 * Provides conversions between TLE epochs, Julian dates, and GMST
 */
class TimeUtils {
public:
    // J2000 epoch Julian Date (January 1, 2000, 12:00 TT)
    static constexpr double J2000_EPOCH_JD = 2451545.0;

    // Seconds per day
    static constexpr double SECONDS_PER_DAY = 86400.0;

    /**
     * @brief Convert TLE epoch to Julian Date
     * @param epoch_year Two-digit year (if >= 57 assume 1900s, else 2000s)
     * @param epoch_day Day of year with fractional part
     * @return Julian Date
     */
    static double tle_epoch_to_jd(int epoch_year, double epoch_day);

    /**
     * @brief Compute Greenwich Mean Sidereal Time
     * @param jd Julian Date
     * @return GMST in radians
     */
    static double compute_gmst(double jd);

    /**
     * @brief Add seconds to a Julian Date
     * @param jd Base Julian Date
     * @param seconds Seconds to add
     * @return New Julian Date
     */
    static double add_seconds_to_jd(double jd, double seconds);

    /**
     * @brief Convert Julian Date to ISO 8601 string
     * @param jd Julian Date
     * @return ISO 8601 formatted string (e.g., "2024-01-25T12:00:00Z")
     */
    static std::string jd_to_iso8601(double jd);
};

} // namespace sim

#endif // TIME_UTILS_HPP
