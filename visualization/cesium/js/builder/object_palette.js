/**
 * ObjectPalette - Left sidebar entity catalog for the Scenario Builder.
 * Groups entity templates by category (Aircraft, Spacecraft, Ground).
 * Click a template to begin placement on the globe.
 */
var ObjectPalette = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Entity Templates
    // -----------------------------------------------------------------------
    var TEMPLATES = [
        // --- Aircraft ---
        {
            category: 'Aircraft',
            name: 'F-16C Fighting Falcon',
            icon: '#4488ff',
            description: '4th-gen multirole fighter, 3-DOF flight physics',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 5000, speed: 200, heading: 90, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f16' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 120000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 40 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#4488ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'F-15E Strike Eagle',
            icon: '#4488ff',
            description: 'Twin-engine multirole fighter, heavy payload',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 6000, speed: 250, heading: 90, gamma: 0,
                throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f15' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 150000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 6, minRange: 2000, maxRange: 100000, seekerFOV: 360, Pk: 0.78, speed: 1200, flightTime: 45 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#4488ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'F-22A Raptor',
            icon: '#6644ff',
            description: '5th-gen stealth air superiority, supercruise',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 9000, speed: 280, heading: 90, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f22' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 120, scanRate_dps: 80, detectionProbability: 0.92 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.90, speed: 900, flightTime: 20 },
                    { type: 'AIM-120D', count: 6, minRange: 2000, maxRange: 160000, seekerFOV: 360, Pk: 0.82, speed: 1400, flightTime: 50 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#6644ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'F-35A Lightning II',
            icon: '#5566ff',
            description: '5th-gen stealth multirole, sensor fusion',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 7000, speed: 240, heading: 90, gamma: 0,
                throttle: 0.65, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f35' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 170000, fov_deg: 120, scanRate_dps: 70, detectionProbability: 0.90 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.88, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 100000, seekerFOV: 360, Pk: 0.78, speed: 1200, flightTime: 45 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#5566ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'F/A-18E Super Hornet',
            icon: '#3388ff',
            description: 'Carrier-based multirole fighter',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 5000, speed: 220, heading: 90, gamma: 0,
                throttle: 0.65, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f18' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 130000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 40 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#3388ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'A-10C Thunderbolt II',
            icon: '#448844',
            description: 'Close air support, GAU-8 Avenger',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 3000, speed: 130, heading: 90, gamma: 0,
                throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'a10' },
                control: { type: 'player_input', config: 'fighter' },
                visual: { type: 'point', color: '#448844', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'B-2A Spirit',
            icon: '#4444aa',
            description: 'Stealth strategic bomber, subsonic',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 12000, speed: 270, heading: 90, gamma: 0,
                throttle: 0.5, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'bomber' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                visual: { type: 'point', color: '#4444aa', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'B-1B Lancer',
            icon: '#5555bb',
            description: 'Supersonic strategic bomber, swing-wing',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 10000, speed: 300, heading: 90, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'bomber_fast' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                visual: { type: 'point', color: '#5555bb', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'E-3G Sentry AWACS',
            icon: '#00aaff',
            description: 'Airborne early warning, 400km radar',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 9000, speed: 230, heading: 90, gamma: 0,
                throttle: 0.5, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'awacs' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 400000, fov_deg: 360, scanRate_dps: 15, detectionProbability: 0.90 },
                visual: { type: 'point', color: '#00aaff', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'C-130J Super Hercules',
            icon: '#88aa88',
            description: 'Tactical airlift, 4-engine turboprop',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 6000, speed: 150, heading: 90, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'transport' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                visual: { type: 'point', color: '#88aa88', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'MQ-9A Reaper',
            icon: '#44aacc',
            description: 'Armed MALE UAV, ISR/strike',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 7500, speed: 80, heading: 90, gamma: 0,
                throttle: 0.5, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'drone_male' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 50000, fov_deg: 90, scanRate_dps: 20, detectionProbability: 0.75 },
                visual: { type: 'point', color: '#44aacc', pixelSize: 8, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'RQ-4B Global Hawk',
            icon: '#44ccee',
            description: 'HALE ISR drone, 60,000ft ceiling',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 18000, speed: 170, heading: 90, gamma: 0,
                throttle: 0.4, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'drone_hale' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 10, detectionProbability: 0.80 },
                visual: { type: 'point', color: '#44ccee', pixelSize: 8, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'X-37S Spaceplane',
            icon: '#00ccff',
            description: 'Runway-to-orbit vehicle, multi-mode propulsion',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 5000, speed: 200, heading: 90, gamma: 0,
                throttle: 0.5, engineOn: true, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#00ccff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'MiG-29 Fulcrum',
            icon: '#ff4444',
            description: '4th-gen air superiority fighter, AI patrol',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 6000, speed: 220, heading: 270, gamma: 0,
                throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'mig29' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 100000, fov_deg: 120, scanRate_dps: 50, detectionProbability: 0.80 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'R-73', count: 2, minRange: 500, maxRange: 20000, seekerFOV: 90, Pk: 0.80, speed: 900, flightTime: 22 },
                    { type: 'R-77', count: 4, minRange: 2000, maxRange: 70000, seekerFOV: 360, Pk: 0.70, speed: 1100, flightTime: 38 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#ff4444', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'Su-27S Flanker',
            icon: '#ff4444',
            description: 'Heavy air superiority interceptor',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 6000, speed: 230, heading: 270, gamma: 0,
                throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'su27' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 120000, fov_deg: 120, scanRate_dps: 55, detectionProbability: 0.82 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'R-73', count: 4, minRange: 500, maxRange: 20000, seekerFOV: 90, Pk: 0.80, speed: 900, flightTime: 22 },
                    { type: 'R-27R', count: 4, minRange: 2000, maxRange: 60000, seekerFOV: 360, Pk: 0.65, speed: 1000, flightTime: 35 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#ff4444', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'Su-35S Flanker-E',
            icon: '#ff6644',
            description: '4++ gen, thrust vectoring, IRBIS-E radar',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 7000, speed: 250, heading: 270, gamma: 0,
                throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'su35' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 160000, fov_deg: 120, scanRate_dps: 65, detectionProbability: 0.88 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'R-73M', count: 4, minRange: 500, maxRange: 30000, seekerFOV: 90, Pk: 0.85, speed: 950, flightTime: 24 },
                    { type: 'R-77-1', count: 6, minRange: 2000, maxRange: 110000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 42 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#ff6644', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'Su-57 Felon',
            icon: '#ff2266',
            description: '5th-gen stealth fighter, N036 AESA',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 9000, speed: 270, heading: 270, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'su57' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 120, scanRate_dps: 75, detectionProbability: 0.92 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'R-74M', count: 4, minRange: 500, maxRange: 40000, seekerFOV: 90, Pk: 0.88, speed: 950, flightTime: 25 },
                    { type: 'R-77M', count: 6, minRange: 2000, maxRange: 160000, seekerFOV: 360, Pk: 0.80, speed: 1400, flightTime: 48 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#ff2266', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'Tu-160 Blackjack',
            icon: '#cc4444',
            description: 'Supersonic strategic bomber, swing-wing',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 11000, speed: 300, heading: 270, gamma: 0,
                throttle: 0.55, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'bomber_fast' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                visual: { type: 'point', color: '#cc4444', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'Tu-22M3 Backfire',
            icon: '#cc5555',
            description: 'Long-range supersonic bomber/maritime strike',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 10000, speed: 280, heading: 270, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'bomber' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                visual: { type: 'point', color: '#cc5555', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'Bayraktar TB2',
            icon: '#cc8844',
            description: 'Armed tactical UCAV, ISR/strike',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 5500, speed: 70, heading: 270, gamma: 0,
                throttle: 0.5, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'drone_male' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 40000, fov_deg: 90, scanRate_dps: 15, detectionProbability: 0.70 },
                visual: { type: 'point', color: '#cc8844', pixelSize: 8, trail: true }
            }
        },
        // --- Spacecraft ---
        {
            category: 'Spacecraft',
            name: 'LEO Satellite',
            icon: '#ffaa00',
            description: 'Low Earth orbit satellite (400km circular)',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 400000, speed: 7670, heading: 45, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffaa00', pixelSize: 8, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'GPS Satellite',
            icon: '#ffcc00',
            description: 'MEO GPS constellation satellite (20,200km)',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 20200000, speed: 3874, heading: 55, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffcc44', pixelSize: 6, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'GEO Comms Satellite',
            icon: '#ff8800',
            description: 'Geostationary communications satellite (35,786km)',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 35786000, speed: 3075, heading: 90, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ff88ff', pixelSize: 6, orbitPath: true, groundTrack: false, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Satellite Inspector',
            icon: '#88ccff',
            description: 'Proximity operations inspector satellite',
            type: 'satellite',
            team: 'blue',
            defaults: { alt: 400000, speed: 7670, heading: 45, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#88ccff', pixelSize: 10, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Imaging Satellite',
            icon: '#aaddff',
            description: 'LEO electro-optical reconnaissance',
            type: 'satellite',
            team: 'blue',
            defaults: { alt: 500000, speed: 7600, heading: 80, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#aaddff', pixelSize: 8, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'SSO Weather Sat',
            icon: '#88ff88',
            description: 'Sun-synchronous polar orbit weather',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 700000, speed: 7500, heading: 98, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#88ff88', pixelSize: 6, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Molniya Orbit Sat',
            icon: '#ffaa88',
            description: 'Highly elliptical orbit, Arctic coverage',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 500000, speed: 9800, heading: 63, gamma: 10 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffaa88', pixelSize: 6, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Kosmos Radar Sat',
            icon: '#ff8888',
            description: 'LEO radar reconnaissance satellite',
            type: 'satellite',
            team: 'red',
            defaults: { alt: 350000, speed: 7700, heading: 82, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ff8888', pixelSize: 8, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Co-Orbital ASAT',
            icon: '#ff4466',
            description: 'Co-orbital anti-satellite interceptor',
            type: 'satellite',
            team: 'red',
            defaults: { alt: 400000, speed: 7670, heading: 45, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ff4466', pixelSize: 10, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        // --- Ground ---
        {
            category: 'Ground',
            name: 'Ground Station',
            icon: '#00ff88',
            description: 'TT&C facility with radar and sensor cone',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 150000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.9 },
                visual: { type: 'ground_station', color: '#00ff88', label: 'GND', sensorRange_m: 150000 }
            }
        },
        {
            category: 'Ground',
            name: 'GPS Receiver',
            icon: '#44ff44',
            description: 'GPS ground receiver for DOP analysis',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                visual: { type: 'point', color: '#44ff44', pixelSize: 8, label: 'GPS-RX' }
            }
        },
        {
            category: 'Ground',
            name: 'M1A2 Abrams',
            icon: '#668844',
            description: 'Main battle tank, 120mm smoothbore',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                visual: { type: 'point', color: '#668844', pixelSize: 10, label: 'M1A2' }
            }
        },
        {
            category: 'Ground',
            name: 'HMMWV',
            icon: '#889966',
            description: 'Light tactical vehicle, scout',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                visual: { type: 'point', color: '#889966', pixelSize: 8, label: 'HMMWV' }
            }
        },
        {
            category: 'Ground',
            name: 'Patriot Battery',
            icon: '#2288ff',
            description: 'MIM-104 Patriot PAC-3, medium-range AD',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 160000, fov_deg: 360, scanRate_dps: 40, detectionProbability: 0.92 },
                weapons: { type: 'sam_battery', maxRange_m: 100000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#2288ff', label: 'PAT3', sensorRange_m: 160000, sensorColor: 'rgba(34,136,255,0.06)', sensorOutlineColor: '#2288ff' }
            }
        },
        {
            category: 'Ground',
            name: 'THAAD Battery',
            icon: '#3366cc',
            description: 'Terminal High Altitude Area Defense',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 500000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.88 },
                weapons: { type: 'sam_battery', maxRange_m: 200000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#3366cc', label: 'THAAD', sensorRange_m: 500000, sensorColor: 'rgba(51,102,204,0.03)', sensorOutlineColor: '#3366cc' }
            }
        },
        {
            category: 'Ground',
            name: 'Avenger SHORAD',
            icon: '#44aa44',
            description: 'AN/TWQ-1 short-range air defense, Stinger',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 20000, fov_deg: 360, scanRate_dps: 60, detectionProbability: 0.80 },
                weapons: { type: 'sam_battery', maxRange_m: 8000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#44aa44', label: 'SHRD', sensorRange_m: 20000, sensorColor: 'rgba(68,170,68,0.08)', sensorOutlineColor: '#44aa44' }
            }
        },
        {
            category: 'Ground',
            name: 'Command Post',
            icon: '#4488cc',
            description: 'Tactical operations center, C2 node',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 50000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.85 },
                visual: { type: 'ground_station', color: '#4488cc', label: 'CP', sensorRange_m: 50000 }
            }
        },
        {
            category: 'Ground',
            name: 'SAM Battery',
            icon: '#ff2222',
            description: 'SA-20 with radar, kill chain, missiles',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.95 },
                weapons: { type: 'sam_battery', maxRange_m: 150000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#ff2222', label: 'SAM', sensorRange_m: 200000, sensorColor: 'rgba(255,50,50,0.06)', sensorOutlineColor: '#ff4444' }
            }
        },
        {
            category: 'Ground',
            name: 'EW Radar',
            icon: '#ff8800',
            description: 'Early warning radar, 300km detection range',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 300000, fov_deg: 360, scanRate_dps: 20, detectionProbability: 0.8 },
                visual: { type: 'ground_station', color: '#ff8800', label: 'EW', sensorRange_m: 300000, sensorColor: 'rgba(255,136,0,0.03)', sensorOutlineColor: '#ff8800' }
            }
        },
        {
            category: 'Ground',
            name: 'T-90 Main Battle Tank',
            icon: '#884444',
            description: 'Main battle tank, 125mm smoothbore',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                visual: { type: 'point', color: '#884444', pixelSize: 10, label: 'T-90' }
            }
        },
        {
            category: 'Ground',
            name: 'S-400 Triumf',
            icon: '#ff2200',
            description: 'SA-21 Growler, long-range strategic AD',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 400000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.93 },
                weapons: { type: 'sam_battery', maxRange_m: 250000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#ff2200', label: 'S400', sensorRange_m: 400000, sensorColor: 'rgba(255,34,0,0.04)', sensorOutlineColor: '#ff2200' }
            }
        },
        {
            category: 'Ground',
            name: 'Pantsir-S1',
            icon: '#ff6600',
            description: 'SA-22 Greyhound, combined gun/missile SHORAD',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 36000, fov_deg: 360, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'sam_battery', maxRange_m: 20000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#ff6600', label: 'PNTS', sensorRange_m: 36000, sensorColor: 'rgba(255,102,0,0.08)', sensorOutlineColor: '#ff6600' }
            }
        },
        {
            category: 'Ground',
            name: 'Tor-M2',
            icon: '#ff4400',
            description: 'SA-15 Gauntlet, mobile tactical SAM',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 25000, fov_deg: 360, scanRate_dps: 50, detectionProbability: 0.82 },
                weapons: { type: 'sam_battery', maxRange_m: 15000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#ff4400', label: 'TOR', sensorRange_m: 25000, sensorColor: 'rgba(255,68,0,0.08)', sensorOutlineColor: '#ff4400' }
            }
        },
        // --- Naval ---
        {
            category: 'Naval',
            name: 'CVN Nimitz Carrier',
            icon: '#4466aa',
            description: 'Nuclear carrier, embarked air wing',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.90 },
                visual: { type: 'ground_station', color: '#4466aa', label: 'CVN', sensorRange_m: 200000, sensorColor: 'rgba(68,102,170,0.04)', sensorOutlineColor: '#4466aa' }
            }
        },
        {
            category: 'Naval',
            name: 'DDG Arleigh Burke',
            icon: '#3355aa',
            description: 'Aegis destroyer, SPY-1D radar, SM-2/3',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 350000, fov_deg: 360, scanRate_dps: 40, detectionProbability: 0.92 },
                weapons: { type: 'sam_battery', maxRange_m: 170000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#3355aa', label: 'DDG', sensorRange_m: 350000, sensorColor: 'rgba(51,85,170,0.04)', sensorOutlineColor: '#3355aa' }
            }
        },
        {
            category: 'Naval',
            name: 'SSN Virginia',
            icon: '#224488',
            description: 'Nuclear attack submarine, Tomahawk capable',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 40000, fov_deg: 360, scanRate_dps: 10, detectionProbability: 0.70 },
                visual: { type: 'ground_station', color: '#224488', label: 'SSN', sensorRange_m: 40000, sensorColor: 'rgba(34,68,136,0.06)', sensorOutlineColor: '#224488' }
            }
        },
        {
            category: 'Naval',
            name: 'FFG Constellation',
            icon: '#5577aa',
            description: 'Multi-mission frigate, EASR radar',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.85 },
                weapons: { type: 'sam_battery', maxRange_m: 50000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#5577aa', label: 'FFG', sensorRange_m: 200000, sensorColor: 'rgba(85,119,170,0.04)', sensorOutlineColor: '#5577aa' }
            }
        },
        {
            category: 'Naval',
            name: 'LHD Wasp',
            icon: '#668899',
            description: 'Amphibious assault ship, helo/F-35B',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 100000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.80 },
                visual: { type: 'ground_station', color: '#668899', label: 'LHD', sensorRange_m: 100000, sensorColor: 'rgba(102,136,153,0.05)', sensorOutlineColor: '#668899' }
            }
        },
        {
            category: 'Naval',
            name: 'Kirov Battlecruiser',
            icon: '#aa3333',
            description: 'Nuclear battlecruiser, S-300F SAM, P-700 AShM',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 300000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.90 },
                weapons: { type: 'sam_battery', maxRange_m: 150000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#aa3333', label: 'KIROV', sensorRange_m: 300000, sensorColor: 'rgba(170,51,51,0.04)', sensorOutlineColor: '#aa3333' }
            }
        },
        {
            category: 'Naval',
            name: 'Admiral Kuznetsov',
            icon: '#993333',
            description: 'Aircraft carrier, Su-33 air wing',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.85 },
                visual: { type: 'ground_station', color: '#993333', label: 'KUZNTSV', sensorRange_m: 200000, sensorColor: 'rgba(153,51,51,0.04)', sensorOutlineColor: '#993333' }
            }
        },
        {
            category: 'Naval',
            name: 'Kilo-class Submarine',
            icon: '#882222',
            description: 'Diesel-electric attack submarine, very quiet',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 30000, fov_deg: 360, scanRate_dps: 8, detectionProbability: 0.65 },
                visual: { type: 'ground_station', color: '#882222', label: 'KILO', sensorRange_m: 30000, sensorColor: 'rgba(136,34,34,0.06)', sensorOutlineColor: '#882222' }
            }
        },
        {
            category: 'Naval',
            name: 'Slava-class Cruiser',
            icon: '#bb4444',
            description: 'Guided missile cruiser, S-300F, P-500',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 250000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.88 },
                weapons: { type: 'sam_battery', maxRange_m: 120000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#bb4444', label: 'SLAVA', sensorRange_m: 250000, sensorColor: 'rgba(187,68,68,0.04)', sensorOutlineColor: '#bb4444' }
            }
        }
    ];

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _container = null;
    var _activeIndex = -1;       // currently highlighted template index
    var _collapsedCats = {};     // category name -> bool (collapsed)
    var _customTemplates = [];   // user-defined custom platforms

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /** Group templates by category, preserving insertion order. Custom first. */
    function _groupByCategory() {
        var groups = {};
        var order = [];

        // Custom templates first
        if (_customTemplates.length > 0) {
            groups['Custom'] = [];
            order.push('Custom');
            for (var c = 0; c < _customTemplates.length; c++) {
                groups['Custom'].push({ template: _customTemplates[c], index: 'custom_' + c, isCustom: true });
            }
        }

        // Built-in templates
        for (var i = 0; i < TEMPLATES.length; i++) {
            var cat = TEMPLATES[i].category;
            if (!groups[cat]) {
                groups[cat] = [];
                order.push(cat);
            }
            groups[cat].push({ template: TEMPLATES[i], index: i });
        }
        return { groups: groups, order: order };
    }

    /** Build a single palette item element. */
    function _createItem(entry) {
        var tpl = entry.template;
        var idx = entry.index;
        var isCustom = entry.isCustom || false;

        var item = document.createElement('div');
        item.className = 'palette-item';
        if (idx === _activeIndex) {
            item.classList.add('palette-item-active');
        }
        item.setAttribute('data-template-index', idx);
        if (isCustom) {
            item.setAttribute('data-custom', 'true');
        }

        // Icon dot
        var icon = document.createElement('span');
        icon.className = 'palette-icon';
        icon.style.background = tpl.icon;
        item.appendChild(icon);

        // Info block
        var info = document.createElement('div');
        info.className = 'palette-item-info';

        var nameEl = document.createElement('div');
        nameEl.className = 'palette-item-name';
        nameEl.textContent = tpl.name;
        if (isCustom) {
            nameEl.innerHTML += ' <span style="color:#4af;font-size:9px;">★</span>';
        }
        info.appendChild(nameEl);

        var descEl = document.createElement('div');
        descEl.className = 'palette-item-desc';
        descEl.textContent = tpl.description;
        info.appendChild(descEl);

        item.appendChild(info);

        // Custom platform: add placement dropdown + edit/delete buttons
        if (isCustom) {
            var actions = document.createElement('div');
            actions.className = 'palette-item-actions';

            // Placement mode dropdown
            var modeSelect = document.createElement('select');
            modeSelect.className = 'palette-placement-mode';
            var defaultMode = (tpl.components && tpl.components.physics &&
                tpl.components.physics.type === 'flight3dof') ? 'aircraft' : 'spacecraft';
            var modes = [
                { value: 'spacecraft', label: 'Space' },
                { value: 'aircraft', label: 'Air' },
                { value: 'ground', label: 'Ground' }
            ];
            modes.forEach(function(m) {
                var opt = document.createElement('option');
                opt.value = m.value;
                opt.textContent = m.label;
                if (m.value === defaultMode) opt.selected = true;
                modeSelect.appendChild(opt);
            });
            modeSelect.addEventListener('click', function(e) { e.stopPropagation(); });
            modeSelect.addEventListener('mousedown', function(e) { e.stopPropagation(); });
            actions.appendChild(modeSelect);

            // Edit button
            var editBtn = document.createElement('button');
            editBtn.className = 'palette-action-btn palette-edit-btn';
            editBtn.innerHTML = '&#9998;';
            editBtn.title = 'Edit platform';
            editBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (typeof PlatformBuilder !== 'undefined') {
                    PlatformBuilder.edit(tpl).then(function(updated) {
                        if (typeof BuilderApp !== 'undefined') {
                            BuilderApp.showMessage('Updated: ' + updated.name, 3000);
                        }
                    }).catch(function() {});
                }
            });
            actions.appendChild(editBtn);

            // Delete button
            var delBtn = document.createElement('button');
            delBtn.className = 'palette-action-btn palette-del-btn';
            delBtn.innerHTML = '&times;';
            delBtn.title = 'Delete platform';
            delBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!confirm('Delete "' + tpl.name + '"?')) return;
                ObjectPalette.removeCustomTemplate(tpl.id);
                if (typeof PlatformBuilder !== 'undefined') {
                    PlatformBuilder.deleteTemplate(tpl.id);
                }
            });
            actions.appendChild(delBtn);

            item.appendChild(actions);

            // Store reference to mode select for click handler
            item._modeSelect = modeSelect;
        }

        // Click handler
        item.addEventListener('click', function() {
            _setActive(idx);
            if (typeof BuilderApp !== 'undefined') {
                if (isCustom) {
                    var customIdx = parseInt(String(idx).replace('custom_', ''), 10);
                    var template = _customTemplates[customIdx];
                    if (template && item._modeSelect) {
                        template._placementMode = item._modeSelect.value;
                    }
                    BuilderApp.startPlacement(template);
                } else {
                    BuilderApp.startPlacement(TEMPLATES[idx]);
                }
            }
        });

        return item;
    }

    /** Build a category section. */
    function _createCategory(catName, entries) {
        var section = document.createElement('div');
        section.className = 'palette-category';

        // Header
        var header = document.createElement('div');
        header.className = 'palette-category-header';

        var arrow = document.createElement('span');
        arrow.className = 'palette-arrow';
        var collapsed = !!_collapsedCats[catName];
        arrow.textContent = collapsed ? '\u25B6' : '\u25BC';
        header.appendChild(arrow);

        var label = document.createElement('span');
        label.textContent = ' ' + catName;
        header.appendChild(label);

        var count = document.createElement('span');
        count.className = 'palette-category-count';
        count.textContent = ' (' + entries.length + ')';
        header.appendChild(count);

        header.addEventListener('click', function() {
            _collapsedCats[catName] = !_collapsedCats[catName];
            _render();
        });

        section.appendChild(header);

        // Items container
        var itemsDiv = document.createElement('div');
        itemsDiv.className = 'palette-category-items';
        if (collapsed) {
            itemsDiv.style.display = 'none';
        }

        for (var i = 0; i < entries.length; i++) {
            itemsDiv.appendChild(_createItem(entries[i]));
        }

        section.appendChild(itemsDiv);
        return section;
    }

    /** Highlight the active template. */
    function _setActive(index) {
        _activeIndex = index;
        // Update highlight in DOM without full re-render
        if (!_container) return;
        var items = _container.querySelectorAll('.palette-item');
        for (var i = 0; i < items.length; i++) {
            var itemIdx = parseInt(items[i].getAttribute('data-template-index'), 10);
            if (itemIdx === _activeIndex) {
                items[i].classList.add('palette-item-active');
            } else {
                items[i].classList.remove('palette-item-active');
            }
        }
    }

    /** Full re-render into the container. */
    function _render() {
        if (!_container) return;
        _container.innerHTML = '';

        // Title
        var title = document.createElement('div');
        title.className = 'palette-title';
        title.textContent = 'Object Palette';
        _container.appendChild(title);

        // Search / filter (simple text filter)
        var search = document.createElement('input');
        search.type = 'text';
        search.className = 'palette-search';
        search.placeholder = 'Filter entities...';
        search.addEventListener('input', function() {
            _renderFiltered(search.value.trim().toLowerCase());
        });
        _container.appendChild(search);

        // Categories
        var grouped = _groupByCategory();
        for (var ci = 0; ci < grouped.order.length; ci++) {
            var catName = grouped.order[ci];
            var section = _createCategory(catName, grouped.groups[catName]);
            _container.appendChild(section);
        }
    }

    /** Render with text filter applied — hides non-matching items. */
    function _renderFiltered(query) {
        if (!_container) return;
        var items = _container.querySelectorAll('.palette-item');
        for (var i = 0; i < items.length; i++) {
            var idx = parseInt(items[i].getAttribute('data-template-index'), 10);
            var tpl = TEMPLATES[idx];
            if (!query) {
                items[i].style.display = '';
                continue;
            }
            var text = (tpl.name + ' ' + tpl.description + ' ' + tpl.category).toLowerCase();
            items[i].style.display = text.indexOf(query) !== -1 ? '' : 'none';
        }
        // Show/hide category headers if all items hidden
        var sections = _container.querySelectorAll('.palette-category');
        for (var s = 0; s < sections.length; s++) {
            var catItems = sections[s].querySelectorAll('.palette-item');
            var anyVisible = false;
            for (var j = 0; j < catItems.length; j++) {
                if (catItems[j].style.display !== 'none') {
                    anyVisible = true;
                    break;
                }
            }
            sections[s].style.display = anyVisible ? '' : 'none';
        }
    }

    // -----------------------------------------------------------------------
    // Inject scoped CSS
    // -----------------------------------------------------------------------
    function _injectStyles() {
        if (document.getElementById('object-palette-styles')) return;
        var style = document.createElement('style');
        style.id = 'object-palette-styles';
        style.textContent = [
            '.palette-title { font-size: 14px; font-weight: bold; color: #ccc; padding: 8px 10px 4px; text-transform: uppercase; letter-spacing: 1px; }',
            '.palette-search { width: calc(100% - 20px); margin: 4px 10px 8px; padding: 5px 8px; background: #1a1a2e; border: 1px solid #333; border-radius: 3px; color: #ccc; font-size: 12px; outline: none; }',
            '.palette-search:focus { border-color: #4488ff; }',
            '.palette-category { margin-bottom: 2px; }',
            '.palette-category-header { padding: 6px 10px; cursor: pointer; color: #aaa; font-size: 12px; font-weight: bold; background: #141428; user-select: none; }',
            '.palette-category-header:hover { background: #1a1a36; color: #ddd; }',
            '.palette-category-count { color: #666; font-weight: normal; }',
            '.palette-arrow { display: inline-block; width: 12px; font-size: 10px; }',
            '.palette-category-items { }',
            '.palette-item { display: flex; align-items: center; padding: 6px 10px 6px 18px; cursor: pointer; border-left: 3px solid transparent; }',
            '.palette-item:hover { background: #1a1a36; border-left-color: #4488ff; }',
            '.palette-item-active { background: #1a2a4a; border-left-color: #4488ff; }',
            '.palette-icon { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-right: 8px; }',
            '.palette-item-info { overflow: hidden; }',
            '.palette-item-name { color: #ddd; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '.palette-item-desc { color: #777; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '.palette-item-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }',
            '.palette-item:hover .palette-item-actions { opacity: 1; }',
            '.palette-action-btn { background: none; border: 1px solid #444; color: #888; width: 20px; height: 20px; border-radius: 3px; cursor: pointer; font-size: 12px; padding: 0; line-height: 18px; text-align: center; }',
            '.palette-action-btn:hover { border-color: #4488ff; color: #4488ff; }',
            '.palette-del-btn:hover { border-color: #ff4444; color: #ff4444; }',
            '.palette-placement-mode { background: #0a0a14; border: 1px solid #444; color: #aaa; font-size: 10px; padding: 1px 2px; border-radius: 3px; cursor: pointer; max-width: 60px; }',
            '.palette-placement-mode:hover { border-color: #4488ff; }',
            '.palette-item-info { overflow: hidden; flex: 1; min-width: 0; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        /**
         * Initialize the palette into a DOM container.
         * @param {string} containerId - ID of the parent element.
         */
        init: function(containerId) {
            _container = document.getElementById(containerId);
            if (!_container) {
                console.error('[ObjectPalette] Container not found: ' + containerId);
                return;
            }
            _injectStyles();
            _render();
        },

        /** Return the full TEMPLATES array. */
        getTemplates: function() {
            return TEMPLATES;
        },

        /** Look up a template by name (case-insensitive). */
        getTemplateByName: function(name) {
            var lower = name.toLowerCase();
            // Check custom templates first
            for (var c = 0; c < _customTemplates.length; c++) {
                if (_customTemplates[c].name.toLowerCase() === lower) {
                    return _customTemplates[c];
                }
            }
            // Check built-in templates
            for (var i = 0; i < TEMPLATES.length; i++) {
                if (TEMPLATES[i].name.toLowerCase() === lower) {
                    return TEMPLATES[i];
                }
            }
            return null;
        },

        /** Force a full re-render. */
        refresh: function() {
            _render();
        },

        /**
         * Add a custom platform template.
         * @param {object} template - The custom platform definition
         */
        addCustomTemplate: function(template) {
            // Check for duplicate by id
            for (var i = 0; i < _customTemplates.length; i++) {
                if (_customTemplates[i].id === template.id) {
                    console.warn('[ObjectPalette] Custom template already exists:', template.id);
                    return;
                }
            }
            _customTemplates.push(template);
            _render();
            console.log('[ObjectPalette] Added custom template:', template.name);
        },

        /**
         * Update an existing custom platform template (replace by id).
         * @param {object} template - The updated platform definition
         */
        updateCustomTemplate: function(template) {
            for (var i = 0; i < _customTemplates.length; i++) {
                if (_customTemplates[i].id === template.id) {
                    _customTemplates[i] = template;
                    _render();
                    return true;
                }
            }
            // Not found — add instead
            _customTemplates.push(template);
            _render();
            return false;
        },

        /**
         * Remove a custom platform template by id.
         * @param {string} id - The custom platform id
         */
        removeCustomTemplate: function(id) {
            for (var i = 0; i < _customTemplates.length; i++) {
                if (_customTemplates[i].id === id) {
                    _customTemplates.splice(i, 1);
                    _render();
                    return true;
                }
            }
            return false;
        },

        /** Get all custom templates. */
        getCustomTemplates: function() {
            return _customTemplates.slice(); // Return copy
        },

        /** Clear all custom templates. */
        clearCustomTemplates: function() {
            _customTemplates = [];
            _render();
        }
    };
})();
