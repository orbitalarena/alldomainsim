/**
 * SimRNG — Seeded pseudorandom number generator for deterministic simulation.
 *
 * Uses mulberry32 algorithm: fast, 32-bit state, period ~2^32, good distribution.
 * Drop-in replacement for Math.random() with additional distribution functions.
 *
 * Usage:
 *   var rng = new SimRNG(42);
 *   rng.random();            // float in [0, 1)
 *   rng.bernoulli(0.85);    // true/false with probability p
 *   rng.uniform(10, 50);    // float in [10, 50)
 *   rng.gaussian(0, 1);     // normal distribution sample
 *   rng.integer(1, 6);      // integer in [1, 6]
 */
var SimRNG = (function() {
    'use strict';

    /**
     * @param {number} seed  Integer seed value
     */
    function SimRNG(seed) {
        this._seed = seed;
        this._state = seed | 0;
        if (this._state === 0) this._state = 1;
    }

    /**
     * Next float in [0, 1) — mulberry32 core.
     */
    SimRNG.prototype.random = function() {
        var t = (this._state += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    /**
     * Bernoulli trial: returns true with probability p.
     * Direct replacement for `Math.random() < p`.
     * @param {number} p  Probability in [0, 1]
     */
    SimRNG.prototype.bernoulli = function(p) {
        return this.random() < p;
    };

    /**
     * Uniform float in [min, max).
     * @param {number} min
     * @param {number} max
     */
    SimRNG.prototype.uniform = function(min, max) {
        return min + this.random() * (max - min);
    };

    /**
     * Gaussian sample via Box-Muller transform.
     * @param {number} mean    Default 0
     * @param {number} stddev  Default 1
     */
    SimRNG.prototype.gaussian = function(mean, stddev) {
        if (mean === undefined) mean = 0;
        if (stddev === undefined) stddev = 1;
        var u1 = this.random();
        var u2 = this.random();
        if (u1 < 1e-10) u1 = 1e-10;
        var z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return mean + z0 * stddev;
    };

    /**
     * Random integer in [min, max] (inclusive both ends).
     * @param {number} min
     * @param {number} max
     */
    SimRNG.prototype.integer = function(min, max) {
        return Math.floor(this.uniform(min, max + 1));
    };

    /**
     * Pick a random element from an array.
     * @param {Array} arr
     */
    SimRNG.prototype.pick = function(arr) {
        if (!arr || arr.length === 0) return undefined;
        return arr[this.integer(0, arr.length - 1)];
    };

    /**
     * Get the original seed this RNG was created with.
     */
    SimRNG.prototype.getSeed = function() {
        return this._seed;
    };

    /**
     * Get the current internal state (for checkpointing).
     */
    SimRNG.prototype.getState = function() {
        return this._state;
    };

    /**
     * Clone this RNG at its current state (for forking sub-streams).
     */
    SimRNG.prototype.clone = function() {
        var copy = new SimRNG(0);
        copy._seed = this._seed;
        copy._state = this._state;
        return copy;
    };

    return SimRNG;
})();
