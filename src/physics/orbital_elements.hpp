#ifndef ORBITAL_ELEMENTS_HPP
#define ORBITAL_ELEMENTS_HPP

#include "core/state_vector.hpp"

namespace sim {

/**
 * @brief Classical (Keplerian) orbital elements
 */
struct OrbitalElements {
    double semi_major_axis;    // a [m]
    double eccentricity;       // e [dimensionless]
    double inclination;        // i [rad]
    double raan;               // Right Ascension of Ascending Node [rad]
    double arg_periapsis;      // Argument of periapsis [rad]
    double true_anomaly;       // True anomaly [rad]

    // Optional: mean anomaly for epoch-based propagation
    double mean_anomaly;       // M [rad]

    // Derived quantities
    double periapsis() const;  // Periapsis radius [m]
    double apoapsis() const;   // Apoapsis radius [m]
    double period() const;     // Orbital period [s]
    double mean_motion() const; // Mean motion [rad/s]

    // Default constructor
    OrbitalElements()
        : semi_major_axis(0), eccentricity(0), inclination(0),
          raan(0), arg_periapsis(0), true_anomaly(0), mean_anomaly(0) {}

    // Constructor from elements (angles in radians)
    OrbitalElements(double a, double e, double i, double raan_,
                    double arg_pe, double nu)
        : semi_major_axis(a), eccentricity(e), inclination(i),
          raan(raan_), arg_periapsis(arg_pe), true_anomaly(nu), mean_anomaly(0) {}
};

/**
 * @brief Conversions between orbital elements and Cartesian state
 */
class OrbitalMechanics {
public:
    // Earth gravitational parameter
    static constexpr double MU_EARTH = 3.986004418e14;  // m^3/s^2

    // Earth radius
    static constexpr double R_EARTH = 6378137.0;  // m

    /**
     * @brief Convert orbital elements to ECI state vector
     * @param elements Classical orbital elements
     * @param mu Gravitational parameter (default: Earth)
     * @return State vector in ECI frame
     */
    static StateVector elements_to_state(const OrbitalElements& elements,
                                         double mu = MU_EARTH);

    /**
     * @brief Convert ECI state vector to orbital elements
     * @param state State vector in ECI frame
     * @param mu Gravitational parameter (default: Earth)
     * @return Classical orbital elements
     */
    static OrbitalElements state_to_elements(const StateVector& state,
                                             double mu = MU_EARTH);

    /**
     * @brief Compute velocity for circular orbit at given radius
     * @param radius Orbital radius [m]
     * @param mu Gravitational parameter
     * @return Circular orbit velocity [m/s]
     */
    static double circular_velocity(double radius, double mu = MU_EARTH);

    /**
     * @brief Compute escape velocity at given radius
     * @param radius Distance from center [m]
     * @param mu Gravitational parameter
     * @return Escape velocity [m/s]
     */
    static double escape_velocity(double radius, double mu = MU_EARTH);

    /**
     * @brief Solve Kepler's equation for eccentric anomaly
     * @param mean_anomaly Mean anomaly [rad]
     * @param eccentricity Eccentricity
     * @param tolerance Convergence tolerance
     * @return Eccentric anomaly [rad]
     */
    static double solve_kepler(double mean_anomaly, double eccentricity,
                               double tolerance = 1e-10);

    /**
     * @brief Convert true anomaly to eccentric anomaly
     */
    static double true_to_eccentric_anomaly(double true_anomaly, double eccentricity);

    /**
     * @brief Convert eccentric anomaly to true anomaly
     */
    static double eccentric_to_true_anomaly(double eccentric_anomaly, double eccentricity);

    /**
     * @brief Convert true anomaly to mean anomaly
     */
    static double true_to_mean_anomaly(double true_anomaly, double eccentricity);

    /**
     * @brief Convert mean anomaly to true anomaly
     */
    static double mean_to_true_anomaly(double mean_anomaly, double eccentricity);

    /**
     * @brief Propagate mean anomaly forward in time
     * @param M0 Initial mean anomaly [rad]
     * @param n Mean motion [rad/s]
     * @param dt Time step [s]
     * @return New mean anomaly [rad]
     */
    static double propagate_mean_anomaly(double M0, double n, double dt);
};

} // namespace sim

#endif // ORBITAL_ELEMENTS_HPP
