#include "coordinate/time_utils.hpp"
#include <cmath>
#include <sstream>
#include <iomanip>

namespace sim {

// Constants
constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;

double TimeUtils::tle_epoch_to_jd(int epoch_year, double epoch_day) {
    // TLE epoch year convention: >= 57 means 1900s, < 57 means 2000s
    int year;
    if (epoch_year >= 57) {
        year = 1900 + epoch_year;
    } else {
        year = 2000 + epoch_year;
    }

    // Calculate Julian Date for January 1st of the year
    // Using algorithm from Astronomical Almanac
    int a = (14 - 1) / 12;  // January is month 1
    int y = year + 4800 - a;
    int m = 1 + 12 * a - 3;

    // Julian Day Number for January 1st
    int jdn = 1 + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;

    // Convert to Julian Date (subtract 0.5 because JD starts at noon)
    double jd_jan1 = static_cast<double>(jdn) - 0.5;

    // Add fractional days (epoch_day is 1-based, so subtract 1)
    return jd_jan1 + (epoch_day - 1.0);
}

double TimeUtils::compute_gmst(double jd) {
    // Compute GMST using the formula from the Astronomical Almanac
    // Based on IAU 1982 model

    // Julian centuries since J2000.0
    double T = (jd - J2000_EPOCH_JD) / 36525.0;

    // GMST at 0h UT in seconds
    // GMST = 67310.54841 + (876600h + 8640184.812866)T + 0.093104T^2 - 6.2e-6T^3
    double gmst_seconds = 67310.54841
                        + (876600.0 * 3600.0 + 8640184.812866) * T
                        + 0.093104 * T * T
                        - 6.2e-6 * T * T * T;

    // Convert to radians (360 degrees = 86400 seconds)
    double gmst_rad = gmst_seconds * TWO_PI / 86400.0;

    // Normalize to [0, 2*PI)
    gmst_rad = std::fmod(gmst_rad, TWO_PI);
    if (gmst_rad < 0) {
        gmst_rad += TWO_PI;
    }

    return gmst_rad;
}

double TimeUtils::add_seconds_to_jd(double jd, double seconds) {
    return jd + seconds / SECONDS_PER_DAY;
}

std::string TimeUtils::jd_to_iso8601(double jd) {
    // Convert Julian Date to calendar date
    // Algorithm from Astronomical Algorithms by Jean Meeus

    double jd_plus = jd + 0.5;
    int Z = static_cast<int>(jd_plus);
    double F = jd_plus - Z;

    int A;
    if (Z < 2299161) {
        A = Z;
    } else {
        int alpha = static_cast<int>((Z - 1867216.25) / 36524.25);
        A = Z + 1 + alpha - alpha / 4;
    }

    int B = A + 1524;
    int C = static_cast<int>((B - 122.1) / 365.25);
    int D = static_cast<int>(365.25 * C);
    int E = static_cast<int>((B - D) / 30.6001);

    double day_frac = B - D - static_cast<int>(30.6001 * E) + F;
    int day = static_cast<int>(day_frac);

    int month;
    if (E < 14) {
        month = E - 1;
    } else {
        month = E - 13;
    }

    int year;
    if (month > 2) {
        year = C - 4716;
    } else {
        year = C - 4715;
    }

    // Extract time from fractional day
    double time_frac = day_frac - day;
    int total_seconds = static_cast<int>(time_frac * 86400.0 + 0.5);
    int hour = total_seconds / 3600;
    int minute = (total_seconds % 3600) / 60;
    int second = total_seconds % 60;

    // Format as ISO 8601
    std::ostringstream oss;
    oss << std::setfill('0')
        << year << "-"
        << std::setw(2) << month << "-"
        << std::setw(2) << day << "T"
        << std::setw(2) << hour << ":"
        << std::setw(2) << minute << ":"
        << std::setw(2) << second << "Z";

    return oss.str();
}

} // namespace sim
