#ifndef SATELLITE_HPP
#define SATELLITE_HPP

#include "entities/entity.hpp"
#include "io/tle_parser.hpp"

namespace sim {

/**
 * @brief Satellite entity
 * 
 * Represents an orbiting satellite, typically initialized from TLE data
 */
class Satellite : public Entity {
public:
    Satellite(const std::string& name, int id, const TLE& tle, bool use_j2 = true);
    virtual ~Satellite() = default;
    
    // Update state (propagate orbit)
    virtual void update(double dt) override;
    
    // Get TLE data
    const TLE& get_tle() const { return tle_; }
    
    // Initialize state from TLE
    void initialize_from_tle();
    
    // Enable/disable J2 perturbations
    void set_use_j2(bool use_j2) { use_j2_ = use_j2; }
    bool get_use_j2() const { return use_j2_; }
    
private:
    TLE tle_;
    bool use_j2_;
    
    // Propagate using RK4 integrator with gravity model
    void propagate_rk4(double dt);
};

} // namespace sim

#endif // SATELLITE_HPP
