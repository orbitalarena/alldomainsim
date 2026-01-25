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
    Satellite(const std::string& name, int id, const TLE& tle);
    virtual ~Satellite() = default;
    
    // Update state (propagate orbit)
    virtual void update(double dt) override;
    
    // Get TLE data
    const TLE& get_tle() const { return tle_; }
    
    // Initialize state from TLE
    void initialize_from_tle();
    
private:
    TLE tle_;
    
    // Simple Keplerian orbit propagation (placeholder for now)
    void propagate_keplerian(double dt);
};

} // namespace sim

#endif // SATELLITE_HPP
