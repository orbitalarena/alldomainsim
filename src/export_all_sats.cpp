#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <iomanip>

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/gravity_model.hpp"
#include "io/tle_parser.hpp"
#include "coordinate/time_utils.hpp"
#include "coordinate/frame_transformer.hpp"

using namespace sim;

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;

// Convert TLE to orbital elements
OrbitalElements tle_to_elements(const TLE& tle) {
    OrbitalElements elem;
    double n = tle.mean_motion * 2.0 * PI / 86400.0;
    double mu = GravityModel::EARTH_MU;
    elem.semi_major_axis = std::pow(mu / (n * n), 1.0/3.0);
    elem.eccentricity = tle.eccentricity;
    elem.inclination = tle.inclination * DEG_TO_RAD;
    elem.raan = tle.raan * DEG_TO_RAD;
    elem.arg_periapsis = tle.arg_perigee * DEG_TO_RAD;

    double M = tle.mean_anomaly * DEG_TO_RAD;
    double e = tle.eccentricity;
    double E = M;
    for (int i = 0; i < 10; i++) {
        E = M + e * std::sin(E);
    }
    double nu = 2.0 * std::atan2(
        std::sqrt(1 + e) * std::sin(E / 2),
        std::sqrt(1 - e) * std::cos(E / 2)
    );
    elem.true_anomaly = nu;
    return elem;
}

int main(int argc, char* argv[]) {
    std::string tle_file = "data/tles/satcat.txt";
    if (argc > 1) {
        tle_file = argv[1];
    }

    std::cout << "Loading TLEs from: " << tle_file << std::endl;
    std::vector<TLE> tles = TLEParser::parse_file(tle_file);

    if (tles.empty()) {
        std::cerr << "Failed to load TLEs" << std::endl;
        return 1;
    }
    std::cout << "Loaded " << tles.size() << " satellites" << std::endl;

    double mu = GravityModel::EARTH_MU;
    double jd = TimeUtils::J2000_EPOCH_JD; // Use J2000 as reference epoch

    std::ofstream json("all_sats.json");
    json << std::fixed << std::setprecision(6);
    json << "{\n";
    json << "  \"count\": " << tles.size() << ",\n";
    json << "  \"satellites\": [\n";

    for (size_t i = 0; i < tles.size(); i++) {
        const auto& tle = tles[i];

        // Convert TLE to state vector
        OrbitalElements elem = tle_to_elements(tle);
        StateVector state = OrbitalMechanics::elements_to_state(elem, mu);

        // Convert to geodetic
        GeodeticCoord geo = FrameTransformer::eci_to_geodetic(state.position, jd);

        // Altitude in km for classification
        double alt_km = geo.altitude / 1000.0;
        std::string orbit_type = "LEO";
        if (alt_km > 35000) orbit_type = "GEO";
        else if (alt_km > 2000) orbit_type = "MEO";

        json << "    {\"name\": \"" << tle.name << "\""
             << ", \"norad\": " << tle.satellite_number
             << ", \"lat\": " << geo.latitude
             << ", \"lon\": " << geo.longitude
             << ", \"alt\": " << geo.altitude
             << ", \"type\": \"" << orbit_type << "\""
             << "}";
        if (i < tles.size() - 1) json << ",";
        json << "\n";

        if ((i + 1) % 100 == 0) {
            std::cout << "Processed " << (i + 1) << " / " << tles.size() << std::endl;
        }
    }

    json << "  ]\n";
    json << "}\n";
    json.close();

    std::cout << "Exported to: all_sats.json" << std::endl;
    return 0;
}
