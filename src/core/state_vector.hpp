#ifndef STATE_VECTOR_HPP
#define STATE_VECTOR_HPP

#include <Eigen/Dense>
#include <chrono>

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
 * @brief Universal state vector for entities
 * 
 * Contains position, velocity, and optional attitude/angular velocity
 * Timestamp and coordinate frame are tracked for proper transformations
 */
struct StateVector {
    // Position [m]
    Eigen::Vector3d position;
    
    // Velocity [m/s]
    Eigen::Vector3d velocity;
    
    // Attitude (quaternion: w, x, y, z)
    Eigen::Quaterniond attitude;
    
    // Angular velocity [rad/s]
    Eigen::Vector3d angular_velocity;
    
    // Timestamp (seconds since epoch)
    double time;
    
    // Coordinate frame
    CoordinateFrame frame;
    
    // Constructor
    StateVector() 
        : position(Eigen::Vector3d::Zero()),
          velocity(Eigen::Vector3d::Zero()),
          attitude(Eigen::Quaterniond::Identity()),
          angular_velocity(Eigen::Vector3d::Zero()),
          time(0.0),
          frame(CoordinateFrame::J2000_ECI) {}
    
    // Altitude above reference ellipsoid (for frame transitions)
    double altitude_msl() const;
};

} // namespace sim

#endif // STATE_VECTOR_HPP
