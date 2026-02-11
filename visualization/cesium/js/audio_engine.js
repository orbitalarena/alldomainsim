/**
 * SimAudio — Procedural audio engine for flight/space simulation.
 * All sounds synthesized via Web Audio API oscillators and noise. No sample files.
 *
 * Usage:
 *   SimAudio.init();                         // call once (lazy AudioContext)
 *   SimAudio.update(playerState, dt);        // call every frame
 *   SimAudio.playWeaponFire(type);           // 'missile' | 'gun'
 *   SimAudio.playExplosion();                // kill/hit
 *   SimAudio.playWarning(type);              // 'stall' | 'overspeed' | 'altitude' | 'gear' | 'lock'
 *   SimAudio.setMasterVolume(0.0 - 1.0);
 *   SimAudio.toggle();                       // mute/unmute (localStorage)
 *   SimAudio.cleanup();                      // tear down context
 */
const SimAudio = (function() {
    'use strict';

    var ctx = null, masterGain = null, compressor = null;
    var initialized = false, muted = false, masterVolume = 0.7, prevMach = 0;
    var noiseBuffer = null;

    // Persistent sound node groups
    var eng = {}, wind = {}, entry = {};

    // Warning state: { active, osc, gain, timerId }
    var warnings = {};
    var WARN_TYPES = ['stall', 'overspeed', 'altitude', 'gear', 'lock'];

    // Smoothed continuous values
    var sm = {
        turbG: 0, turbF: 2000, rktG: 0, hypG: 0, ionG: 0,
        windG: 0, windF: 200, entG: 0, entF: 800
    };

    // --- Helpers -----------------------------------------------------------

    function createNoiseBuffer() {
        if (noiseBuffer) return noiseBuffer;
        var len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        noiseBuffer = buf;
        return buf;
    }

    function noiseSrc() {
        var s = ctx.createBufferSource();
        s.buffer = createNoiseBuffer();
        s.loop = true;
        return s;
    }

    function osc(type, freq) {
        var o = ctx.createOscillator();
        o.type = type; o.frequency.value = freq;
        return o;
    }

    function gain(val) {
        var g = ctx.createGain();
        g.gain.value = val || 0;
        return g;
    }

    function bqf(type, freq, q) {
        var f = ctx.createBiquadFilter();
        f.type = type; f.frequency.value = freq;
        if (q !== undefined) f.Q.value = q;
        return f;
    }

    function lerp(cur, tgt, dt, rate) {
        return cur + (tgt - cur) * Math.min(1, dt * (rate || 5));
    }

    function propCat(mode) {
        if (!mode) return 'AIR';
        var u = String(mode).toUpperCase();
        if (u === 'ROCKET') return 'ROCKET';
        if (u === 'HYPERSONIC') return 'HYPERSONIC';
        if (u.indexOf('ION') === 0 || u.indexOf('HALL') === 0 ||
            u.indexOf('RCS') === 0 || u.indexOf('COLD GAS') === 0) return 'ION';
        if (u === 'AIR' || u === 'TAXI') return 'AIR';
        // Named rocket engines from live_sim_engine presets
        if (/^(OMS|AJ10|NERVA|RAPTOR|MERLIN|RS-25|F-1|SATURN|1G ACCEL|PROP|TURBOPROP)/
            .test(u)) return 'ROCKET';
        return 'AIR';
    }

    // --- Context creation --------------------------------------------------

    function _createContext() {
        if (ctx) return;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        createNoiseBuffer();

        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -12; compressor.knee.value = 10;
        compressor.ratio.value = 8; compressor.attack.value = 0.003;
        compressor.release.value = 0.1;

        masterGain = gain(muted ? 0 : masterVolume);
        compressor.connect(masterGain);
        masterGain.connect(ctx.destination);

        _buildEngine();
        _buildWind();
        _buildEntry();
    }

    // --- Engine nodes (persistent, gain-modulated) -------------------------

    function _chain(nodes, dest) {
        for (var i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
        nodes[nodes.length - 1].connect(dest);
        // Start source/oscillator nodes
        if (nodes[0].start) nodes[0].start();
    }

    function _buildEngine() {
        eng.grp = gain(1); eng.grp.connect(compressor);

        // Turbofan: sawtooth rumble + sine whine + LFO wobble
        eng.turbRG = gain(); eng.turbWG = gain();
        eng.turbR = osc('sawtooth', 80); eng.turbW = osc('sine', 2000);
        _chain([eng.turbR, eng.turbRG], eng.grp);
        _chain([eng.turbW, eng.turbWG], eng.grp);
        eng.turbLfo = osc('sine', 5); eng.turbLG = gain(20);
        eng.turbLfo.connect(eng.turbLG);
        eng.turbLG.connect(eng.turbW.frequency);
        eng.turbLfo.start();

        // Rocket: bandpass noise + low sine + crackle LFO
        eng.rktNG = gain(); eng.rktBP = bqf('bandpass', 500, 0.5);
        eng.rktN = noiseSrc();
        _chain([eng.rktN, eng.rktBP, eng.rktNG], eng.grp);
        eng.rktLG = gain(); eng.rktL = osc('sine', 60);
        _chain([eng.rktL, eng.rktLG], eng.grp);
        eng.rktCL = osc('sawtooth', 30); eng.rktCG = gain();
        eng.rktCL.connect(eng.rktCG);
        eng.rktCG.connect(eng.rktNG.gain);
        eng.rktCL.start();

        // Hypersonic: highpass noise + deep throb
        eng.hypNG = gain(); eng.hypHP = bqf('highpass', 1000);
        eng.hypN = noiseSrc();
        _chain([eng.hypN, eng.hypHP, eng.hypNG], eng.grp);
        eng.hypTG = gain(); eng.hypT = osc('sine', 40);
        _chain([eng.hypT, eng.hypTG], eng.grp);

        // Ion: high-pitch hum
        eng.ionG = gain(); eng.ionO = osc('sine', 6000);
        _chain([eng.ionO, eng.ionG], eng.grp);
    }

    // --- Wind nodes --------------------------------------------------------

    function _buildWind() {
        wind.grp = gain(1); wind.grp.connect(compressor);
        wind.bp = bqf('bandpass', 200, 1.0); wind.g = gain();
        wind.n = noiseSrc();
        _chain([wind.n, wind.bp, wind.g], wind.grp);
        wind.rG = gain(); wind.rO = osc('sine', 30);
        _chain([wind.rO, wind.rG], wind.grp);
    }

    // --- Atmospheric entry nodes -------------------------------------------

    function _buildEntry() {
        entry.grp = gain(1); entry.grp.connect(compressor);
        entry.bp = bqf('bandpass', 800, 0.8); entry.g = gain();
        entry.n = noiseSrc();
        _chain([entry.n, entry.bp, entry.g], entry.grp);
        entry.cL = osc('sawtooth', 20); entry.cG = gain();
        entry.cL.connect(entry.cG);
        entry.cG.connect(entry.g.gain);
        entry.cL.start();
    }

    // --- init() ------------------------------------------------------------

    function init() {
        if (initialized) return;
        var stored = localStorage.getItem('sim_audio_enabled');
        muted = (stored === 'false');

        // Reset warning state
        for (var i = 0; i < WARN_TYPES.length; i++)
            warnings[WARN_TYPES[i]] = { active: false, osc: null, gain: null, timerId: null };

        var onGesture = function() {
            if (!ctx) _createContext();
            else if (ctx.state === 'suspended') ctx.resume();
            document.removeEventListener('click', onGesture);
            document.removeEventListener('keydown', onGesture);
        };
        document.addEventListener('click', onGesture);
        document.addEventListener('keydown', onGesture);
        try { _createContext(); } catch (e) { /* created on gesture */ }
        initialized = true;
    }

    // --- update(playerState, dt) -------------------------------------------

    function update(playerState, dt) {
        if (!ctx || !playerState) return;
        if (ctx.state === 'suspended') { ctx.resume(); return; }

        var s = playerState;
        var throttle = s.throttle || 0, engineOn = !!s.engineOn;
        var speed = s.speed || 0, alt = s.alt || 0;
        var mach = s.mach || 0, dynQ = s.dynamicPressure || 0;
        var aeroBlend = s.aeroBlend !== undefined ? s.aeroBlend : 1;
        var alpha = s.alpha || 0, phase = s.phase || 'FLIGHT';
        var gearDown = !!s.gearDown;
        var cat = propCat(s.propulsionMode);
        var eff = engineOn ? throttle : 0;

        // Engine targets
        var tTurb = 0, tRkt = 0, tHyp = 0, tIon = 0, wFreq = 2000;
        if (engineOn) {
            if (cat === 'AIR')       { tTurb = eff * 0.3; wFreq = 2000 + eff * 2000; }
            else if (cat === 'ROCKET')    tRkt = eff * 0.5;
            else if (cat === 'HYPERSONIC') tHyp = eff * 0.4;
            else if (cat === 'ION')       tIon = eff > 0 ? 0.05 : 0;
        }

        sm.turbG = lerp(sm.turbG, tTurb, dt);
        sm.turbF = lerp(sm.turbF, wFreq, dt, 3);
        sm.rktG  = lerp(sm.rktG,  tRkt,  dt);
        sm.hypG  = lerp(sm.hypG,  tHyp,  dt);
        sm.ionG  = lerp(sm.ionG,  tIon,  dt);

        eng.turbRG.gain.value = sm.turbG;
        eng.turbWG.gain.value = sm.turbG * 0.6;
        eng.turbW.frequency.value = sm.turbF;
        eng.rktNG.gain.value = sm.rktG;
        eng.rktLG.gain.value = sm.rktG * 0.7;
        eng.rktCG.gain.value = sm.rktG > 0.05 ? sm.rktG * 0.3 : 0;
        eng.hypNG.gain.value = sm.hypG;
        eng.hypTG.gain.value = sm.hypG * 0.5;
        eng.ionG.gain.value  = sm.ionG;

        // Wind
        var wGt = dynQ > 1 ? Math.min(0.4, dynQ / 10000) : 0;
        sm.windG = lerp(sm.windG, wGt, dt);
        sm.windF = lerp(sm.windF, 200 + speed * 2, dt, 3);
        wind.g.gain.value = sm.windG;
        wind.bp.frequency.value = Math.min(sm.windF, 12000);
        var rumT = speed > 200 ? Math.min(0.15, (speed - 200) / 3000) : 0;
        wind.rG.gain.value = lerp(wind.rG.gain.value, rumT, dt);

        // Atmospheric entry
        var eGt = 0, eFt = 800;
        if (alt > 80000 && speed > 3000 && aeroBlend > 0.01) {
            eGt = Math.min(0.6, dynQ / 5000);
            eFt = 400 + Math.min(4000, dynQ / 2);
        }
        sm.entG = lerp(sm.entG, eGt, dt);
        sm.entF = lerp(sm.entF, eFt, dt, 3);
        entry.g.gain.value = sm.entG;
        entry.bp.frequency.value = Math.min(sm.entF, 12000);
        entry.cG.gain.value = sm.entG > 0.05 ? sm.entG * 0.4 : 0;

        // Sonic boom
        if (prevMach > 0 &&
            ((prevMach < 1.0 && mach >= 1.0) || (prevMach >= 1.0 && mach < 1.0)))
            _playSonicBoom();
        prevMach = mach;

        // Warnings
        _setWarn('stall',     alpha > 0.26 && speed < 80 && phase === 'FLIGHT');
        _setWarn('overspeed', mach > 1.8 && alt < 5000);
        _setWarn('gear',      alt < 500 && !gearDown && speed < 100 && phase === 'FLIGHT');
    }

    // --- Warnings ----------------------------------------------------------

    function _setWarn(type, cond) {
        var w = warnings[type];
        if (!w) return;
        if (cond && !w.active) _startWarn(type);
        else if (!cond && w.active) _stopWarn(type);
    }

    function _startWarn(type) {
        if (!ctx) return;
        var w = warnings[type];
        w.active = true;
        w.gain = gain(); w.gain.connect(compressor);
        w.osc = ctx.createOscillator();

        if (type === 'stall') {
            // 1kHz square, 0.1s on/off
            w.osc.type = 'square'; w.osc.frequency.value = 1000;
            w.osc.connect(w.gain); w.osc.start();
            var sOn = true;
            w.timerId = setInterval(function() {
                if (w.gain) { sOn = !sOn; w.gain.gain.value = sOn ? 0.3 : 0; }
            }, 100);
            w.gain.gain.value = 0.3;

        } else if (type === 'overspeed') {
            // 2kHz sine continuous
            w.osc.type = 'sine'; w.osc.frequency.value = 2000;
            w.osc.connect(w.gain); w.osc.start();
            w.gain.gain.value = 0.2;

        } else if (type === 'altitude') {
            // 500Hz triangle, 0.2s on / 0.3s off
            w.osc.type = 'triangle'; w.osc.frequency.value = 500;
            w.osc.connect(w.gain); w.osc.start();
            w.gain.gain.value = 0.4;
            var aP = 1;
            var altCyc = function() {
                if (!w.active) return;
                aP = 1 - aP;
                if (w.gain) w.gain.gain.value = aP ? 0.4 : 0;
                w.timerId = setTimeout(altCyc, aP ? 200 : 300);
            };
            w.timerId = setTimeout(altCyc, 200);

        } else if (type === 'gear') {
            // 1.5kHz sine, 3 beeps (0.1s on/off each) then 1s pause
            w.osc.type = 'sine'; w.osc.frequency.value = 1500;
            w.osc.connect(w.gain); w.osc.start();
            w.gain.gain.value = 0.3;
            var gP = 0;
            var gCyc = function() {
                if (!w.active) return;
                if (gP < 6) {
                    if (w.gain) w.gain.gain.value = (gP % 2 === 0) ? 0.3 : 0;
                    gP++;
                    w.timerId = setTimeout(gCyc, 100);
                } else {
                    if (w.gain) w.gain.gain.value = 0;
                    gP = 0;
                    w.timerId = setTimeout(gCyc, 1000);
                }
            };
            w.timerId = setTimeout(gCyc, 100);

        } else if (type === 'lock') {
            // 3kHz rapid, 0.05s on/off
            w.osc.type = 'sine'; w.osc.frequency.value = 3000;
            w.osc.connect(w.gain); w.osc.start();
            var lOn = true;
            w.timerId = setInterval(function() {
                if (w.gain) { lOn = !lOn; w.gain.gain.value = lOn ? 0.5 : 0; }
            }, 50);
            w.gain.gain.value = 0.5;
        }
    }

    function _stopWarn(type) {
        var w = warnings[type];
        if (!w) return;
        w.active = false;
        if (w.timerId) { clearInterval(w.timerId); clearTimeout(w.timerId); w.timerId = null; }
        try { if (w.osc) { w.osc.stop(); w.osc.disconnect(); } } catch (e) {}
        try { if (w.gain) w.gain.disconnect(); } catch (e) {}
        w.osc = null; w.gain = null;
    }

    // --- One-shot sounds ---------------------------------------------------

    function playWeaponFire(type) {
        if (!ctx || muted) return;
        if (ctx.state === 'suspended') ctx.resume();
        var now = ctx.currentTime;
        if (type === 'gun') {
            // Square 800Hz, 0.05s on/off bursts over 0.3s
            var bg = gain(); bg.connect(compressor);
            var bo = osc('square', 800); bo.connect(bg); bo.start(now); bo.stop(now + 0.35);
            for (var t = 0; t < 0.3; t += 0.1) {
                bg.gain.setValueAtTime(0.4, now + t);
                bg.gain.setValueAtTime(0, now + t + 0.05);
            }
        } else {
            // Missile whoosh: noise burst + rising sine sweep
            var ng = gain(); ng.connect(compressor);
            ng.gain.setValueAtTime(0.6, now);
            ng.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
            var ns = noiseSrc(); ns.connect(ng); ns.start(now); ns.stop(now + 0.6);

            var so = osc('sine', 500);
            so.frequency.setValueAtTime(500, now);
            so.frequency.exponentialRampToValueAtTime(2000, now + 0.3);
            var sg = gain(); sg.connect(compressor);
            sg.gain.setValueAtTime(0.4, now);
            sg.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
            so.connect(sg); so.start(now); so.stop(now + 0.6);
        }
    }

    function playExplosion() {
        if (!ctx || muted) return;
        if (ctx.state === 'suspended') ctx.resume();
        var now = ctx.currentTime;

        // Low boom 60Hz
        var bo = osc('sine', 60), bg = gain(); bg.connect(compressor);
        bg.gain.setValueAtTime(0.8, now);
        bg.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
        bo.connect(bg); bo.start(now); bo.stop(now + 0.9);

        // Bandpass noise burst
        var ns = noiseSrc(), bp = bqf('bandpass', 300, 0.5), ng = gain();
        ng.connect(compressor);
        ng.gain.setValueAtTime(0.6, now);
        ng.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        ns.connect(bp); bp.connect(ng); ns.start(now); ns.stop(now + 0.4);
    }

    function playWarning(type) {
        if (!ctx || muted) return;
        if (ctx.state === 'suspended') ctx.resume();
        if (warnings[type] && !warnings[type].active) {
            _startWarn(type);
            if (type === 'altitude' || type === 'lock')
                setTimeout(function() { _stopWarn(type); }, 2000);
        }
    }

    function _playSonicBoom() {
        if (!ctx || muted) return;
        var now = ctx.currentTime;
        // 40Hz thump
        var to = osc('sine', 40), tg = gain(); tg.connect(compressor);
        tg.gain.setValueAtTime(0.7, now);
        tg.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        to.connect(tg); to.start(now); to.stop(now + 0.25);
        // Click
        var cs = noiseSrc(), cg = gain(); cg.connect(compressor);
        cg.gain.setValueAtTime(0.7, now);
        cg.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
        cs.connect(cg); cs.start(now); cs.stop(now + 0.03);
    }

    // --- Ace Combat-style threat tones (continuous) -------------------------

    // Threat tone states
    var threat = {
        rwrOsc: null, rwrGain: null, rwrActive: false, rwrType: 'none',
        mwsOsc: null, mwsGain: null, mwsActive: false, mwsTimerId: null,
        mwsRate: 0  // beeps per second
    };

    /**
     * Update threat tones based on current RWR and MWS state.
     * Called every frame from live_sim_engine.
     * @param {Array} rwr - _playerState._rwr array
     * @param {Array} mws - _playerState._mws array
     */
    function updateThreatTones(rwr, mws) {
        if (!ctx || muted) return;
        if (ctx.state === 'suspended') return;

        // --- RWR tone: changes character based on threat level ---
        var highestThreat = 'none';
        var closestLock = 1.0; // normalized range of closest lock
        if (rwr && rwr.length > 0) {
            for (var i = 0; i < rwr.length; i++) {
                var t = rwr[i];
                if (t.type === 'lock' && highestThreat !== 'lock') {
                    highestThreat = 'lock';
                    if (t.range_norm < closestLock) closestLock = t.range_norm;
                } else if (t.type === 'track' && highestThreat === 'none') {
                    highestThreat = 'track';
                }
            }
        }

        if (highestThreat !== threat.rwrType) {
            // Tear down old RWR tone
            _stopRWRTone();

            if (highestThreat === 'track') {
                // Steady 1.2kHz pulse — "being tracked" awareness chirp
                threat.rwrGain = gain(); threat.rwrGain.connect(compressor);
                threat.rwrOsc = osc('sine', 1200);
                threat.rwrOsc.connect(threat.rwrGain);
                threat.rwrOsc.start();
                threat.rwrGain.gain.value = 0.12;
                threat.rwrActive = true;
                // Slow pulse: 0.15s on / 0.85s off
                var rwrPulseOn = true;
                threat.rwrTimerId = setInterval(function() {
                    if (threat.rwrGain) {
                        rwrPulseOn = !rwrPulseOn;
                        threat.rwrGain.gain.value = rwrPulseOn ? 0.12 : 0;
                    }
                }, rwrPulseOn ? 150 : 850);

            } else if (highestThreat === 'lock') {
                // Urgent rapid tone — "LOCKED, missile incoming possible"
                // Frequency increases as target gets closer
                var freq = 2000 + (1 - closestLock) * 2000; // 2kHz to 4kHz
                threat.rwrGain = gain(); threat.rwrGain.connect(compressor);
                threat.rwrOsc = osc('square', freq);
                threat.rwrOsc.connect(threat.rwrGain);
                threat.rwrOsc.start();
                threat.rwrGain.gain.value = 0.25;
                threat.rwrActive = true;
                // Rapid toggle: 50ms on/off
                var rwrLockOn = true;
                threat.rwrTimerId = setInterval(function() {
                    if (threat.rwrGain) {
                        rwrLockOn = !rwrLockOn;
                        threat.rwrGain.gain.value = rwrLockOn ? 0.25 : 0;
                    }
                }, 60);
            }
            threat.rwrType = highestThreat;

        } else if (highestThreat === 'lock' && threat.rwrOsc) {
            // Update frequency based on range (closer = higher pitch)
            var freq2 = 2000 + (1 - closestLock) * 2000;
            threat.rwrOsc.frequency.value = freq2;
        }

        // --- MWS tone: active missile(s) inbound, urgency based on range ---
        var hasMissile = mws && mws.length > 0;
        var closestRange = Infinity;
        if (hasMissile) {
            for (var m = 0; m < mws.length; m++) {
                if (mws[m].range < closestRange) closestRange = mws[m].range;
            }
        }

        if (hasMissile && !threat.mwsActive) {
            // Start MWS tone
            threat.mwsGain = gain(); threat.mwsGain.connect(compressor);
            threat.mwsOsc = osc('sawtooth', 3500);
            threat.mwsOsc.connect(threat.mwsGain);
            threat.mwsOsc.start();
            threat.mwsGain.gain.value = 0.35;
            threat.mwsActive = true;
            threat.mwsRate = 4;  // initial beep rate
            var mwsOn = true;
            threat.mwsTimerId = setInterval(function() {
                if (threat.mwsGain) {
                    mwsOn = !mwsOn;
                    threat.mwsGain.gain.value = mwsOn ? 0.35 : 0;
                }
            }, 80);

        } else if (!hasMissile && threat.mwsActive) {
            _stopMWSTone();

        } else if (hasMissile && threat.mwsActive && threat.mwsOsc) {
            // Modulate MWS tone based on closest missile range
            // Under 5km: highest urgency (5kHz, fastest beep)
            // 5-20km: high (4kHz)
            // 20-50km: medium (3.5kHz)
            var urgency = closestRange < 5000 ? 1.0 :
                          closestRange < 20000 ? 0.7 :
                          closestRange < 50000 ? 0.4 : 0.2;
            threat.mwsOsc.frequency.value = 3000 + urgency * 2000;
            // Volume ramps up with urgency
            if (threat.mwsGain) {
                // We set max gain in the toggle interval, so adjust the reference
                threat.mwsGain.gain.value = 0.15 + urgency * 0.35;
            }
        }
    }

    function _stopRWRTone() {
        if (threat.rwrTimerId) { clearInterval(threat.rwrTimerId); threat.rwrTimerId = null; }
        try { if (threat.rwrOsc) { threat.rwrOsc.stop(); threat.rwrOsc.disconnect(); } } catch(e) {}
        try { if (threat.rwrGain) threat.rwrGain.disconnect(); } catch(e) {}
        threat.rwrOsc = null; threat.rwrGain = null;
        threat.rwrActive = false; threat.rwrType = 'none';
    }

    function _stopMWSTone() {
        if (threat.mwsTimerId) { clearInterval(threat.mwsTimerId); threat.mwsTimerId = null; }
        try { if (threat.mwsOsc) { threat.mwsOsc.stop(); threat.mwsOsc.disconnect(); } } catch(e) {}
        try { if (threat.mwsGain) threat.mwsGain.disconnect(); } catch(e) {}
        threat.mwsOsc = null; threat.mwsGain = null;
        threat.mwsActive = false; threat.mwsRate = 0;
    }

    /** Play a short "Fox" call (missile launch confirmation). */
    function playFoxCall() {
        if (!ctx || muted) return;
        if (ctx.state === 'suspended') return;
        var now = ctx.currentTime;
        // Rising chirp: 800Hz → 1600Hz over 0.15s, then drop
        var fo = osc('triangle', 800);
        fo.frequency.setValueAtTime(800, now);
        fo.frequency.linearRampToValueAtTime(1600, now + 0.15);
        fo.frequency.linearRampToValueAtTime(1200, now + 0.25);
        var fg = gain(); fg.connect(compressor);
        fg.gain.setValueAtTime(0.3, now);
        fg.gain.linearRampToValueAtTime(0.2, now + 0.15);
        fg.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        fo.connect(fg); fo.start(now); fo.stop(now + 0.45);
    }

    /** Play target kill confirmation sound. */
    function playKillConfirm() {
        if (!ctx || muted) return;
        var now = ctx.currentTime;
        // Double tone: 1kHz + 1.5kHz, like a "boop-boop"
        for (var i = 0; i < 2; i++) {
            var t = now + i * 0.12;
            var ko = osc('sine', 1000 + i * 500);
            var kg = gain(); kg.connect(compressor);
            kg.gain.setValueAtTime(0.3, t);
            kg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
            ko.connect(kg); ko.start(t); ko.stop(t + 0.12);
        }
    }

    // --- Volume / toggle / cleanup -----------------------------------------

    function setMasterVolume(v) {
        masterVolume = Math.max(0, Math.min(1, v));
        if (masterGain && !muted) masterGain.gain.value = masterVolume;
    }

    function toggle() {
        muted = !muted;
        localStorage.setItem('sim_audio_enabled', muted ? 'false' : 'true');
        if (masterGain) masterGain.gain.value = muted ? 0 : masterVolume;
        return !muted;
    }

    function cleanup() {
        var i;
        _stopRWRTone();
        _stopMWSTone();
        for (i = 0; i < WARN_TYPES.length; i++) _stopWarn(WARN_TYPES[i]);

        var oscNodes = [eng.turbR, eng.turbW, eng.turbLfo, eng.rktL, eng.rktCL,
                        eng.hypT, eng.ionO, wind.rO, entry.cL];
        var srcNodes = [eng.rktN, eng.hypN, wind.n, entry.n];
        var all = oscNodes.concat(srcNodes);
        for (i = 0; i < all.length; i++) {
            try { if (all[i]) { all[i].stop(); all[i].disconnect(); } } catch (e) {}
        }
        var gNodes = [eng.turbRG, eng.turbWG, eng.turbLG, eng.rktNG, eng.rktLG,
                      eng.rktCG, eng.rktBP, eng.hypNG, eng.hypHP, eng.hypTG,
                      eng.ionG, eng.grp, wind.bp, wind.g, wind.rG, wind.grp,
                      entry.bp, entry.g, entry.cG, entry.grp, compressor, masterGain];
        for (i = 0; i < gNodes.length; i++) {
            try { if (gNodes[i]) gNodes[i].disconnect(); } catch (e) {}
        }
        if (ctx) { try { ctx.close(); } catch (e) {} }

        ctx = null; masterGain = null; compressor = null;
        noiseBuffer = null; initialized = false; prevMach = 0;
        sm.turbG = 0; sm.turbF = 2000; sm.rktG = 0; sm.hypG = 0; sm.ionG = 0;
        sm.windG = 0; sm.windF = 200; sm.entG = 0; sm.entF = 800;
    }

    // --- Public API --------------------------------------------------------

    return {
        init: init,
        update: update,
        updateThreatTones: updateThreatTones,
        playWeaponFire: playWeaponFire,
        playExplosion: playExplosion,
        playWarning: playWarning,
        playFoxCall: playFoxCall,
        playKillConfirm: playKillConfirm,
        setMasterVolume: setMasterVolume,
        cleanup: cleanup,
        toggle: toggle
    };
})();
