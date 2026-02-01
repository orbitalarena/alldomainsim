/**
 * SimRNG — Seeded PRNG for deterministic Monte Carlo simulation.
 *
 * Exact port of the JavaScript SimRNG (mulberry32 algorithm).
 * Given the same seed, produces identical sequences to the JS version,
 * enabling cross-validation between browser and C++ MC runners.
 *
 * Header-only. No dependencies beyond <cstdint> and <cmath>.
 */

#ifndef SIM_MC_SIM_RNG_HPP
#define SIM_MC_SIM_RNG_HPP

#include <cstdint>
#include <cmath>

namespace sim::mc {

class SimRNG {
public:
    explicit SimRNG(int32_t seed = 42)
        : seed_(seed), state_(seed ? seed : 1) {}

    /**
     * Next float in [0, 1) — mulberry32 core.
     * Identical to JS: var t = (this._state += 0x6D2B79F5);
     *                  t = Math.imul(t ^ (t >>> 15), t | 1);
     *                  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
     *                  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
     */
    double random() {
        // JS: this._state += 0x6D2B79F5  (with |0 coercion to signed 32-bit)
        state_ += 0x6D2B79F5;
        uint32_t t = static_cast<uint32_t>(state_);

        // JS: Math.imul(t ^ (t >>> 15), t | 1)
        t = imul(t ^ (t >> 15), t | 1u);

        // JS: t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        t ^= t + imul(t ^ (t >> 7), t | 61u);

        // JS: ((t ^ (t >>> 14)) >>> 0) / 4294967296
        return static_cast<double>((t ^ (t >> 14))) / 4294967296.0;
    }

    /** Bernoulli trial: returns true with probability p. */
    bool bernoulli(double p) {
        return random() < p;
    }

    /** Uniform float in [min, max). */
    double uniform(double a, double b) {
        return a + random() * (b - a);
    }

    /** Gaussian sample via Box-Muller transform. */
    double gaussian(double mean = 0.0, double stddev = 1.0) {
        double u1 = random();
        double u2 = random();
        if (u1 < 1e-10) u1 = 1e-10;
        double z0 = std::sqrt(-2.0 * std::log(u1)) * std::cos(2.0 * M_PI * u2);
        return mean + z0 * stddev;
    }

    int32_t getSeed() const { return seed_; }
    int32_t getState() const { return state_; }

    void setSeed(int32_t seed) {
        seed_ = seed;
        state_ = seed ? seed : 1;
    }

private:
    int32_t seed_;
    int32_t state_;

    /**
     * Emulate JavaScript Math.imul: 32-bit integer multiplication.
     * Result is the low 32 bits of the full 64-bit product.
     */
    static uint32_t imul(uint32_t a, uint32_t b) {
        return static_cast<uint32_t>(
            static_cast<uint64_t>(a) * static_cast<uint64_t>(b)
        );
    }
};

} // namespace sim::mc

#endif // SIM_MC_SIM_RNG_HPP
