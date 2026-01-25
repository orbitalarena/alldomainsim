#ifndef STATE_VECTOR_HPP
#define STATE_VECTOR_HPP

#include <cmath>
#include <array>

namespace sim {

/**
 * @brief Coordinate frame enumeration
 */
enum class CoordinateFrame {
    TEME,        // True Equator Mean Equinox (TLE standard)
    J2000_ECI,   // J2000 Earth-Centered Inertial
    ECEF,        // Earth-Centered Earth-Fixed (WGS84)
    BODY         // Body-fixed frame
};

/**
 * @brief Simple 3D vector (temporary Eigen replacement)
 */
struct Vec3 {
    double x, y, z;
    
    Vec3() : x(0), y(0), z(0) {}
    Vec3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}
    
    double norm() const {
        return std::sqrt(x*x + y*y + z*z);
    }
    
    static Vec3 Zero() { return Vec3(0, 0, 0); }
};

/**
 * @brief Simple quaternion (temporary Eigen replacement)
 */
struct Quat {
    double w, x, y, z;
    
    Quat() : w(1), x(0), y(0), z(0) {}
    Quat(double w_, double x_, double y_, double z_) : w(w_), x(x_), y(y_), z(z_) {}
    
    static Quat Identity() { return Quat(1, 0, 0, 0); }
};

/**
 * @brief Universal state vector for entities
 * 
 * Contains position, velocity, and optional attitude/angular velocity
 * Timestamp and coordinate frame are tracked for proper transformations
 * 
 * NOTE: Currently using simple Vec3/Quat. Will migrate to Eigen when available.
 */
struct StateVector {
    // Position [m]
    Vec3 position;
    
    // Velocity [m/s]
    Vec3 velocity;
    
    // Attitude (quaternion: w, x, y, z)
    Quat attitude;
    
    // Angular velocity [rad/s]
    Vec3 angular_velocity;
    
    // Timestamp (seconds since epoch)
    double time;
    
    // Coordinate frame
    CoordinateFrame frame;
    
    // Constructor
    StateVector() 
        : position(Vec3::Zero()),
          velocity(Vec3::Zero()),
          attitude(Quat::Identity()),
          angular_velocity(Vec3::Zero()),
          time(0.0),
          frame(CoordinateFrame::J2000_ECI) {}
    
    // Altitude above reference ellipsoid (for frame transitions)
    double altitude_msl() const;
};

} // namespace sim

#endif // STATE_VECTOR_HPP
