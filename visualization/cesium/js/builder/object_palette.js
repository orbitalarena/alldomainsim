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
            description: '4th gen multirole fighter. 120km radar, A2A missiles.',
            tooltip: '4th gen multirole fighter. Air-breathing engine, 120km radar, AIM-9X/AIM-120C missiles. Good all-around platform for strike and air superiority.',
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
            description: 'Twin-engine multirole fighter. 150km radar, heavy payload.',
            tooltip: 'Twin-engine multirole fighter. 150km radar, 6x AIM-120C + 2x AIM-9X. Heavy payload capacity for deep strike missions.',
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
            description: '5th-gen stealth air superiority, supercruise.',
            tooltip: '5th-gen stealth air superiority fighter. 200km AESA radar, supercruise capable. Highest detection probability (0.92) and longest-range missiles.',
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
            description: '5th-gen stealth multirole, sensor fusion.',
            tooltip: '5th-gen stealth multirole with advanced sensor fusion. 170km radar, internal weapons bay. Balanced stealth and payload.',
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
            description: 'Carrier-based multirole fighter. 130km radar.',
            tooltip: 'Carrier-based multirole fighter. 130km radar, AIM-9X/AIM-120C missiles. Versatile for carrier strike group operations.',
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
            description: 'Close air support, GAU-8 30mm cannon.',
            tooltip: 'Dedicated close air support aircraft. GAU-8 Avenger 30mm cannon. Low and slow -- vulnerable to SAMs but devastating against ground targets.',
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
            name: 'C-17A Globemaster III',
            icon: '#99bb99',
            description: 'Strategic airlift, 4-engine jet, STOL capable',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 8000, speed: 180, heading: 90, gamma: 0,
                throttle: 0.55, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'c17' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                visual: { type: 'point', color: '#99bb99', pixelSize: 14, trail: true }
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
            description: 'Runway-to-orbit, 3 propulsion modes (P key).',
            tooltip: 'Reusable spaceplane capable of runway takeoff to orbital insertion. Three propulsion modes: Air (160kN), Hypersonic (800kN), Rocket (5MN). Press P to cycle modes.',
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
            description: 'Russian air superiority fighter. Red team default.',
            tooltip: 'Russian air superiority fighter. Similar performance to F-16. 100km radar, R-73/R-77 missiles. Default red team fighter with AI patrol.',
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
        {
            category: 'Aircraft',
            name: 'J-20 Mighty Dragon',
            icon: '#ee3333',
            description: '5th-gen stealth, PL-15/PL-10, AESA radar',
            tooltip: 'Chengdu J-20 Mighty Dragon. Chinese 5th-gen stealth air superiority fighter. Type 1475 AESA radar, 200km range. PL-15 long-range + PL-10 short-range missiles. Delta canard configuration.',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 10000, speed: 300, heading: 270, gamma: 0,
                throttle: 0.65, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f22' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 120, scanRate_dps: 75, detectionProbability: 0.90 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'PL-10', count: 2, minRange: 500, maxRange: 20000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'PL-15', count: 4, minRange: 2000, maxRange: 150000, seekerFOV: 360, Pk: 0.78, speed: 1400, flightTime: 50 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#ee3333', pixelSize: 12, trail: true }
            },
            _custom: { rcs_m2: 0.05 }
        },
        {
            category: 'Aircraft',
            name: 'J-16 Flanker-L',
            icon: '#dd4444',
            description: '4th+ gen multirole, heavy payload, AESA',
            tooltip: 'Shenyang J-16. Chinese 4th+ gen multirole fighter based on Su-30MKK. AESA radar, PL-15/PL-10 + guided bombs. Heavy payload for strike and air superiority.',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 8000, speed: 260, heading: 270, gamma: 0,
                throttle: 0.65, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f15' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 160000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.87 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'PL-10', count: 2, minRange: 500, maxRange: 20000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'PL-15', count: 6, minRange: 2000, maxRange: 150000, seekerFOV: 360, Pk: 0.75, speed: 1400, flightTime: 45 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#dd4444', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'J-10C Vigorous Dragon',
            icon: '#dd5555',
            description: 'Light multirole, AESA radar, PL-15',
            tooltip: 'Chengdu J-10C. Chinese light multirole fighter with AESA radar. PL-15/PL-10 missiles. Delta canard, agile dogfighter. Comparable to F-16 Block 70.',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 7000, speed: 240, heading: 270, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f16' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 130000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'PL-10', count: 2, minRange: 500, maxRange: 20000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'PL-15', count: 4, minRange: 2000, maxRange: 150000, seekerFOV: 360, Pk: 0.75, speed: 1300, flightTime: 42 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#dd5555', pixelSize: 10, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'KJ-500 AWACS',
            icon: '#dd7777',
            description: 'Chinese AEW&C, 3-panel AESA, 450km radar',
            tooltip: 'Shaanxi KJ-500. Chinese AEW&C with three-panel fixed AESA radar. 450km detection range, 360-degree coverage. Command and control for PLA air operations.',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 9000, speed: 180, heading: 270, gamma: 0,
                throttle: 0.5, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'awacs' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                sensors: { type: 'radar', maxRange_m: 450000, fov_deg: 360, scanRate_dps: 20, detectionProbability: 0.90 },
                visual: { type: 'point', color: '#dd7777', pixelSize: 14, trail: true }
            }
        },
        // --- Launch Vehicles ---
        {
            category: 'Launch Vehicles',
            name: 'Falcon 9 Block 5',
            icon: '#00bbff',
            description: 'SpaceX Falcon 9 Block 5 - LEO capacity 22,800 kg',
            tooltip: 'SpaceX Falcon 9 Block 5 medium-lift launch vehicle. 549,054 kg liftoff mass. Reusable first stage. LEO capacity 22,800 kg, GTO 8,300 kg. Merlin 1D+ engines (sea-level + vacuum). Launch from Cape Canaveral.',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                lat: 28.562, lon: -80.577,
                alt: 10, speed: 0, heading: 90, gamma: 90,
                throttle: 0, engineOn: false, infiniteFuel: true
            },
            _custom: {
                propulsion: { modes: ['ROCKET'], rocketEngine: 'RS25' },
                mass: 549054,
                description: 'SpaceX Falcon 9 Block 5 - LEO capacity 22,800 kg'
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#00bbff', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Launch Vehicles',
            name: 'Atlas V 551',
            icon: '#0088cc',
            description: 'ULA Atlas V 551 - LEO capacity 18,850 kg',
            tooltip: 'United Launch Alliance Atlas V 551 heavy configuration. 590,000 kg liftoff mass. 5 solid rocket boosters, Common Core Booster (RD-180), Centaur upper stage (RL10). LEO capacity 18,850 kg, GTO 8,900 kg. Launch from Cape Canaveral.',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                lat: 28.562, lon: -80.577,
                alt: 10, speed: 0, heading: 90, gamma: 90,
                throttle: 0, engineOn: false, infiniteFuel: true
            },
            _custom: {
                propulsion: { modes: ['ROCKET'], rocketEngine: 'RS25' },
                mass: 590000,
                description: 'ULA Atlas V 551 - LEO capacity 18,850 kg'
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#0088cc', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Launch Vehicles',
            name: 'SLS Block 1',
            icon: '#ff8800',
            description: 'NASA SLS Block 1 - LEO capacity 95,000 kg',
            tooltip: 'NASA Space Launch System Block 1 super heavy-lift vehicle. 2,608,000 kg liftoff mass. 4x RS-25 core stage engines + 2x solid rocket boosters. LEO capacity 95,000 kg. Launch from Kennedy Space Center LC-39B.',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                lat: 28.562, lon: -80.577,
                alt: 10, speed: 0, heading: 90, gamma: 90,
                throttle: 0, engineOn: false, infiniteFuel: true
            },
            _custom: {
                propulsion: { modes: ['ROCKET'], rocketEngine: 'RS25' },
                mass: 2608000,
                description: 'NASA SLS Block 1 - LEO capacity 95,000 kg'
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#ff8800', pixelSize: 16, trail: true }
            }
        },
        {
            category: 'Launch Vehicles',
            name: 'Long March 5',
            icon: '#ff4444',
            description: 'CASC Long March 5 - LEO capacity 25,000 kg',
            tooltip: 'China Aerospace Science and Technology Corporation Long March 5 (CZ-5) heavy-lift vehicle. 867,000 kg liftoff mass. Kerolox/hydrolox core + 4x kerolox boosters. LEO capacity 25,000 kg, GTO 14,000 kg. Launch from Wenchang Space Launch Site.',
            type: 'aircraft',
            team: 'red',
            defaults: {
                lat: 19.614, lon: 110.951,
                alt: 10, speed: 0, heading: 90, gamma: 90,
                throttle: 0, engineOn: false, infiniteFuel: true
            },
            _custom: {
                propulsion: { modes: ['ROCKET'], rocketEngine: 'RS25' },
                mass: 867000,
                description: 'CASC Long March 5 - LEO capacity 25,000 kg'
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#ff4444', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Launch Vehicles',
            name: 'Ariane 6',
            icon: '#2266cc',
            description: 'ArianeGroup Ariane 6 - LEO capacity 21,650 kg',
            tooltip: 'ArianeGroup Ariane 6 (A64 configuration) medium-to-heavy lift vehicle. 530,000 kg liftoff mass. Vulcain 2.1 core engine + 4x P120C solid boosters. Vinci re-ignitable upper stage. LEO capacity 21,650 kg, GTO 11,500 kg. Launch from Guiana Space Centre, Kourou.',
            type: 'aircraft',
            team: 'neutral',
            defaults: {
                lat: 5.239, lon: -52.768,
                alt: 10, speed: 0, heading: 90, gamma: 90,
                throttle: 0, engineOn: false, infiniteFuel: true
            },
            _custom: {
                propulsion: { modes: ['ROCKET'], rocketEngine: 'RS25' },
                mass: 530000,
                description: 'ArianeGroup Ariane 6 - LEO capacity 21,650 kg'
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#2266cc', pixelSize: 14, trail: true }
            }
        },
        {
            category: 'Launch Vehicles',
            name: 'PSLV',
            icon: '#ff9944',
            description: 'ISRO PSLV - LEO capacity 3,800 kg',
            tooltip: 'Indian Space Research Organisation Polar Satellite Launch Vehicle (PSLV-XL). 320,000 kg liftoff mass. 4-stage vehicle (solid/liquid/solid/liquid). LEO capacity 3,800 kg, SSO 1,750 kg. Known for multi-satellite deployment. Launch from Satish Dhawan Space Centre, Sriharikota.',
            type: 'aircraft',
            team: 'neutral',
            defaults: {
                lat: 13.72, lon: 80.23,
                alt: 10, speed: 0, heading: 90, gamma: 90,
                throttle: 0, engineOn: false, infiniteFuel: true
            },
            _custom: {
                propulsion: { modes: ['ROCKET'], rocketEngine: 'RL10' },
                mass: 320000,
                description: 'ISRO PSLV - LEO capacity 3,800 kg'
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#ff9944', pixelSize: 12, trail: true }
            }
        },
        // --- Formations (multi-entity groups) ---
        {
            category: 'Formations',
            name: '2-Ship Element (F-16)',
            icon: '#4488ff',
            description: 'Lead + wingman pair, combat spread',
            tooltip: 'Basic 2-ship element: lead + right wingman. Combat spread formation at 1NM spacing. Both F-16C with AIM-9/AIM-120.',
            type: 'aircraft',
            team: 'blue',
            _isFormation: true,
            _formationEntities: [
                { suffix: 'Lead', role: 'lead', offset: [0, 0] },
                { suffix: 'Wing', role: 'wingman', offset: [0.008, -0.003], formation: { position: 'right_wing', separation: 1852 } }
            ],
            defaults: { alt: 6000, speed: 220, heading: 90, gamma: 0, throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true },
            components: {
                physics: { type: 'flight3dof', config: 'f16' },
                sensors: { type: 'radar', maxRange_m: 120000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 40 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#4488ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Formations',
            name: '4-Ship Flight (F-16)',
            icon: '#4488ff',
            description: 'Finger-four formation, standard tactical flight',
            tooltip: 'Standard 4-ship flight: lead + 3 wingmen in finger-four formation. F-16C fighters with full A2A loadout. Formation AI maintains relative positions.',
            type: 'aircraft',
            team: 'blue',
            _isFormation: true,
            _formationEntities: [
                { suffix: 'Lead', role: 'lead', offset: [0, 0] },
                { suffix: '2', role: 'wingman', offset: [0.008, -0.004], formation: { position: 'finger_four_2', separation: 1852 } },
                { suffix: '3', role: 'element lead', offset: [-0.006, 0.008], formation: { position: 'finger_four_3', separation: 1852 } },
                { suffix: '4', role: 'tail', offset: [-0.006, -0.004], formation: { position: 'finger_four_4', separation: 1852 } }
            ],
            defaults: { alt: 6000, speed: 220, heading: 90, gamma: 0, throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true },
            components: {
                physics: { type: 'flight3dof', config: 'f16' },
                sensors: { type: 'radar', maxRange_m: 120000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 40 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#4488ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Formations',
            name: '4-Ship Flight (MiG-29)',
            icon: '#ff4444',
            description: 'Red finger-four, MiG-29 Fulcrum',
            tooltip: 'Red force 4-ship flight: MiG-29 Fulcrum fighters in finger-four. R-73/R-77 missiles. Formation AI maintains spacing.',
            type: 'aircraft',
            team: 'red',
            _isFormation: true,
            _formationEntities: [
                { suffix: 'Lead', role: 'lead', offset: [0, 0] },
                { suffix: '2', role: 'wingman', offset: [0.008, -0.004], formation: { position: 'finger_four_2', separation: 1852 } },
                { suffix: '3', role: 'element lead', offset: [-0.006, 0.008], formation: { position: 'finger_four_3', separation: 1852 } },
                { suffix: '4', role: 'tail', offset: [-0.006, -0.004], formation: { position: 'finger_four_4', separation: 1852 } }
            ],
            defaults: { alt: 6000, speed: 230, heading: 270, gamma: 0, throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true },
            components: {
                physics: { type: 'flight3dof', config: 'mig29' },
                sensors: { type: 'radar', maxRange_m: 100000, fov_deg: 120, scanRate_dps: 50, detectionProbability: 0.80 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'R-73', count: 2, minRange: 300, maxRange: 20000, seekerFOV: 60, Pk: 0.80, speed: 800, flightTime: 18 },
                    { type: 'R-77', count: 4, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.70, speed: 1150, flightTime: 40 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#ff4444', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Formations',
            name: 'Strike Package (4+2)',
            icon: '#66aaff',
            description: '4x F-15E strike + 2x F-16C escort',
            tooltip: '6-ship strike package: 4x F-15E Strike Eagles in wall formation (primary strikers) plus 2x F-16C escorts in trail. F-15Es carry heavy A2G loadout, F-16Cs provide fighter sweep.',
            type: 'aircraft',
            team: 'blue',
            _isFormation: true,
            _formationEntities: [
                { suffix: 'Strike Lead', role: 'lead', offset: [0, 0], config: 'f15' },
                { suffix: 'Strike 2', role: 'striker', offset: [0.005, -0.008], formation: { position: 'right_wing', separation: 2500 }, config: 'f15' },
                { suffix: 'Strike 3', role: 'striker', offset: [0.005, 0.008], formation: { position: 'left_wing', separation: 2500 }, config: 'f15' },
                { suffix: 'Strike 4', role: 'striker', offset: [0.01, 0.0], formation: { position: 'trail', separation: 3000 }, config: 'f15' },
                { suffix: 'Escort 1', role: 'escort', offset: [0.015, -0.005], formation: { position: 'echelon_right', separation: 4000 }, config: 'f16' },
                { suffix: 'Escort 2', role: 'escort', offset: [0.015, 0.005], formation: { position: 'echelon_left', separation: 4000 }, config: 'f16' }
            ],
            defaults: { alt: 8000, speed: 250, heading: 90, gamma: 0, throttle: 0.75, engineOn: true, gearDown: false, infiniteFuel: true },
            components: {
                physics: { type: 'flight3dof', config: 'f15' },
                sensors: { type: 'radar', maxRange_m: 150000, fov_deg: 120, scanRate_dps: 60, detectionProbability: 0.85 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 6, minRange: 2000, maxRange: 100000, seekerFOV: 360, Pk: 0.78, speed: 1200, flightTime: 45 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#66aaff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Formations',
            name: 'AWACS + CAP (1+4)',
            icon: '#88ddff',
            description: 'E-3 AWACS with 4x F-16 combat air patrol',
            tooltip: '5-ship CAP package: 1x E-3 AWACS high-value airborne asset providing 360° radar coverage, protected by 4x F-16C fighters in combat spread. AWACS flies racetrack, fighters maintain formation.',
            type: 'aircraft',
            team: 'blue',
            _isFormation: true,
            _formationEntities: [
                { suffix: 'AWACS', role: 'lead', offset: [0, 0], config: 'awacs', isAwacs: true },
                { suffix: 'CAP 1', role: 'escort', offset: [0.01, -0.015], formation: { position: 'right_wing', separation: 15000 }, config: 'f16' },
                { suffix: 'CAP 2', role: 'escort', offset: [0.01, 0.015], formation: { position: 'left_wing', separation: 15000 }, config: 'f16' },
                { suffix: 'CAP 3', role: 'escort', offset: [0.02, -0.008], formation: { position: 'echelon_right', separation: 20000 }, config: 'f16' },
                { suffix: 'CAP 4', role: 'escort', offset: [0.02, 0.008], formation: { position: 'echelon_left', separation: 20000 }, config: 'f16' }
            ],
            defaults: { alt: 9000, speed: 180, heading: 90, gamma: 0, throttle: 0.5, engineOn: true, gearDown: false, infiniteFuel: true },
            components: {
                physics: { type: 'flight3dof', config: 'awacs' },
                sensors: { type: 'radar', maxRange_m: 400000, fov_deg: 360, scanRate_dps: 20, detectionProbability: 0.92 },
                visual: { type: 'point', color: '#88ddff', pixelSize: 14, trail: true }
            }
        },
        // --- Spacecraft ---
        {
            category: 'Spacecraft',
            name: 'LEO Satellite',
            icon: '#ffaa00',
            description: 'Low Earth Orbit, 400km, ~92 min period.',
            tooltip: 'Low Earth Orbit satellite (400km altitude, 51.6 deg inclination). Fast orbital period (~92 min). Keplerian 2-body propagation with orbit path and ground track.',
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
            description: 'MEO navigation, 20,200km, ~12hr period.',
            tooltip: 'Medium Earth Orbit navigation satellite (20,200km altitude, 55 deg inclination). ~12 hour orbital period. Use 6+ for GPS coverage analysis.',
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
            description: 'GEO, 35,786km, appears stationary over equator.',
            tooltip: 'Geostationary orbit (35,786km altitude, 0 deg inclination). Appears stationary over a point on the equator. ~24 hour period.',
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
        // --- Real-World Constellation Templates ---
        {
            category: 'Spacecraft',
            name: 'ISS',
            icon: '#ffffff',
            description: 'International Space Station, 420km, 51.6° inc.',
            tooltip: 'International Space Station. 420km altitude, 51.6° inclination, ~92 min period. Mass ~420,000 kg, solar array area ~2,500 m². RCS ~400 m².',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 420000, speed: 7660, heading: 51.6, gamma: 0 },
            _custom: { rcs_m2: 400, mass_kg: 420000 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffffff', pixelSize: 14, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Starlink Gen2',
            icon: '#44ccff',
            description: 'SpaceX Starlink v2 Mini, 550km, 53° inc.',
            tooltip: 'SpaceX Starlink Gen2 Mini. 550km shell, 53° inclination. Mass ~800 kg, RCS ~2-4 m². Ka/Ku-band phased array, laser inter-sat links.',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 550000, speed: 7590, heading: 53, gamma: 0 },
            _custom: { rcs_m2: 3, mass_kg: 800 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#44ccff', pixelSize: 5, orbitPath: true, groundTrack: true, apPeMarkers: false }
            }
        },
        {
            category: 'Spacecraft',
            name: 'GPS III',
            icon: '#ffcc44',
            description: 'GPS Block III, 20,180km MEO, 55° inc.',
            tooltip: 'GPS Block IIIF navigation satellite. 20,180km altitude, 55° inclination, ~12hr period. Mass ~2,161 kg. L1/L2/L5 signals, M-code.',
            type: 'satellite',
            team: 'blue',
            defaults: { alt: 20180000, speed: 3874, heading: 55, gamma: 0 },
            _custom: { rcs_m2: 10, mass_kg: 2161 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffcc44', pixelSize: 7, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'SBIRS GEO',
            icon: '#ff4444',
            description: 'Space-Based Infrared System, GEO missile warning.',
            tooltip: 'SBIRS GEO missile warning satellite. Geostationary orbit. Scanning + staring IR sensors for boost-phase missile detection. Mass ~4,500 kg.',
            type: 'satellite',
            team: 'blue',
            defaults: { alt: 35786000, speed: 3075, heading: 0, gamma: 0 },
            _custom: { rcs_m2: 15, mass_kg: 4500, sensors: { ir: { enabled: true, fov_deg: 18, type: 'ir' } } },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                sensors: { type: 'radar', maxRange_m: 6000000, fov_deg: 18, scanRate_dps: 360, detectionProbability: 0.95, updateInterval: 0.5 },
                visual: { type: 'satellite', color: '#ff4444', pixelSize: 8, orbitPath: true, groundTrack: false, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'WGS',
            icon: '#44aaff',
            description: 'Wideband Global SATCOM, GEO, 11 Gbps.',
            tooltip: 'Wideband Global SATCOM. GEO orbit. Ka/X-band, 11+ Gbps aggregate throughput. Mass ~5,987 kg. Primary DoD broadband.',
            type: 'satellite',
            team: 'blue',
            defaults: { alt: 35786000, speed: 3075, heading: 0, gamma: 0 },
            _custom: { rcs_m2: 20, mass_kg: 5987 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#44aaff', pixelSize: 7, orbitPath: true, groundTrack: false, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'AEHF',
            icon: '#ffaa00',
            description: 'Advanced EHF comms, GEO, jam-resistant.',
            tooltip: 'Advanced Extremely High Frequency satellite. GEO orbit. Protected, jam-resistant nuclear C3 comms. Mass ~6,168 kg.',
            type: 'satellite',
            team: 'blue',
            defaults: { alt: 35786000, speed: 3075, heading: 0, gamma: 0 },
            _custom: { rcs_m2: 18, mass_kg: 6168 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffaa00', pixelSize: 7, orbitPath: true, groundTrack: false, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Iridium NEXT',
            icon: '#88ddff',
            description: 'Iridium NEXT, 780km LEO, 86.4° inc.',
            tooltip: 'Iridium NEXT constellation. 780km altitude, 86.4° near-polar orbit. Mass ~860 kg. L-band voice/data, 66 active + spares.',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 780000, speed: 7450, heading: 86.4, gamma: 0 },
            _custom: { rcs_m2: 5, mass_kg: 860 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#88ddff', pixelSize: 5, orbitPath: true, groundTrack: true, apPeMarkers: false }
            }
        },
        {
            category: 'Spacecraft',
            name: 'OneWeb',
            icon: '#44ff88',
            description: 'OneWeb, 1,200km LEO, 87.9° inc.',
            tooltip: 'OneWeb broadband constellation. 1,200km altitude, 87.9° near-polar orbit. Mass ~150 kg. Ku-band, 648 satellites.',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 1200000, speed: 7300, heading: 87.9, gamma: 0 },
            _custom: { rcs_m2: 1.5, mass_kg: 150 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#44ff88', pixelSize: 5, orbitPath: true, groundTrack: true, apPeMarkers: false }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Tiangong',
            icon: '#ff8844',
            description: 'Chinese Space Station, 390km, 41.5° inc.',
            tooltip: 'Tiangong (Chinese Space Station). 390km altitude, 41.5° inclination. Mass ~100,000 kg. Three modules: Tianhe core + Wentian + Mengtian.',
            type: 'satellite',
            team: 'red',
            defaults: { alt: 390000, speed: 7670, heading: 41.5, gamma: 0 },
            _custom: { rcs_m2: 150, mass_kg: 100000 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ff8844', pixelSize: 12, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'Beidou-3 MEO',
            icon: '#ff6644',
            description: 'BeiDou-3, 21,528km MEO, 55° inc.',
            tooltip: 'BeiDou-3 MEO navigation satellite. 21,528km altitude, 55° inclination. Chinese GNSS, 24 MEO + 3 IGSO + 3 GEO.',
            type: 'satellite',
            team: 'red',
            defaults: { alt: 21528000, speed: 3830, heading: 55, gamma: 0 },
            _custom: { rcs_m2: 8, mass_kg: 1014 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ff6644', pixelSize: 6, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'GSSAP Inspector',
            icon: '#aaccff',
            description: 'Geosync Space Situational Awareness, near-GEO.',
            tooltip: 'GSSAP (Geosynchronous Space Situational Awareness Program). Near-GEO orbit for close approach inspection of GEO objects. US Space Force.',
            type: 'satellite',
            team: 'blue',
            defaults: { alt: 35800000, speed: 3074, heading: 0, gamma: 0 },
            _custom: { rcs_m2: 2, mass_kg: 500 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#aaccff', pixelSize: 8, orbitPath: true, groundTrack: false, apPeMarkers: true }
            }
        },
        // --- Ground ---
        {
            category: 'Ground',
            name: 'Ground Station',
            icon: '#00ff88',
            description: 'Fixed ground sensor, 150km 360-degree radar.',
            tooltip: 'Fixed ground sensor platform with 150km 360-degree radar. Tracks and communicates with satellites and aircraft. TT&C facility.',
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
            description: 'SA-20, 200km radar, F2T2EA kill chain.',
            tooltip: 'Surface-to-air missile system with 200km radar and 150km engagement range. F2T2EA kill chain: Detect, Track, Target, Engage, Assess. Active SAM combat.',
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
            name: 'RF Jammer',
            icon: '#ff00ff',
            description: 'EW jammer, barrage/spot, 200km range',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.85 },
                weapons: { type: 'jammer', jamType: 'barrage', bandwidth_ghz: 2.0, power_dbw: 40, range_m: 200000, direction: 'both', activateOnDetection: true },
                visual: { type: 'ground_station', color: '#ff00ff', label: 'JAM', sensorRange_m: 200000, sensorColor: 'rgba(255,0,255,0.04)', sensorOutlineColor: '#ff00ff' }
            }
        },
        {
            category: 'Ground',
            name: 'Cyber Node',
            icon: '#aa00ff',
            description: 'Network attack node — brick, MITM, inject, DDoS',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                cyber: { type: 'cyber_actor', capabilities: ['brick', 'mitm', 'inject', 'ddos', 'exploit'], accessTime_s: 30, exploitTime_s: 60, stealthLevel: 0.8, autoTarget: true, maxSimultaneous: 2 },
                visual: { type: 'ground_station', color: '#aa00ff', label: 'CYBER', sensorRange_m: 0 }
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
        {
            category: 'Ground',
            name: 'S-300PMU2',
            icon: '#dd3300',
            description: 'SA-20 Gargoyle, long-range area defense',
            tooltip: 'S-300PMU2 (SA-20 Gargoyle). Long-range area defense system. 300km detection, 200km engagement. Backbone of Russian-exported IADS.',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 300000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.90 },
                weapons: { type: 'sam_battery', maxRange_m: 200000, numMissiles: 16, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#dd3300', label: 'S300', sensorRange_m: 300000, sensorColor: 'rgba(221,51,0,0.04)', sensorOutlineColor: '#dd3300' }
            }
        },
        {
            category: 'Ground',
            name: 'HQ-9B',
            icon: '#cc2200',
            description: 'PLA long-range SAM, S-300 derivative',
            tooltip: 'HQ-9B. Chinese long-range SAM system. 250km engagement range. Primary PLA strategic air defense.',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 300000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.88 },
                weapons: { type: 'sam_battery', maxRange_m: 250000, numMissiles: 12, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#cc2200', label: 'HQ9', sensorRange_m: 300000, sensorColor: 'rgba(204,34,0,0.04)', sensorOutlineColor: '#cc2200' }
            }
        },
        {
            category: 'Ground',
            name: 'Iron Dome',
            icon: '#44bbff',
            description: 'Short-range rocket/missile defense',
            tooltip: 'Iron Dome. Israeli short-range air defense for rocket/mortar intercept. 70km range, high Pk against short-range threats.',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 100000, fov_deg: 360, scanRate_dps: 60, detectionProbability: 0.90 },
                weapons: { type: 'sam_battery', maxRange_m: 70000, numMissiles: 20, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#44bbff', label: 'IDOM', sensorRange_m: 100000, sensorColor: 'rgba(68,187,255,0.06)', sensorOutlineColor: '#44bbff' }
            }
        },
        {
            category: 'Ground',
            name: 'NASAMS',
            icon: '#3399ee',
            description: 'Norwegian/US medium-range AD, AMRAAM-based',
            tooltip: 'NASAMS. Uses AIM-120 AMRAAM. 25km engagement range. Networked fire distribution.',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 120000, fov_deg: 360, scanRate_dps: 50, detectionProbability: 0.88 },
                weapons: { type: 'sam_battery', maxRange_m: 25000, numMissiles: 12, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#3399ee', label: 'NASM', sensorRange_m: 120000, sensorColor: 'rgba(51,153,238,0.06)', sensorOutlineColor: '#3399ee' }
            }
        },
        {
            category: 'Ground',
            name: 'Aegis Ashore',
            icon: '#2255cc',
            description: 'Land-based Aegis BMD, SM-3/SM-6',
            tooltip: 'Aegis Ashore. Land-based Aegis with AN/SPY-1 radar. SM-3 for ballistic missile defense, SM-6 for air defense. 500km+ detection.',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 600000, fov_deg: 360, scanRate_dps: 25, detectionProbability: 0.95 },
                weapons: { type: 'sam_battery', maxRange_m: 300000, numMissiles: 24, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#2255cc', label: 'AEGIS', sensorRange_m: 600000, sensorColor: 'rgba(34,85,204,0.03)', sensorOutlineColor: '#2255cc' }
            }
        },
        {
            category: 'Ground',
            name: 'AN/TPY-2 Radar',
            icon: '#55aaff',
            description: 'X-band BMD radar, forward-deployed sensor',
            tooltip: 'AN/TPY-2. X-band radar for THAAD and BMD. 1000km+ detection range. High-resolution tracking and discrimination.',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 1000000, fov_deg: 120, scanRate_dps: 20, detectionProbability: 0.96 },
                visual: { type: 'ground_station', color: '#55aaff', label: 'TPY2', sensorRange_m: 1000000, sensorColor: 'rgba(85,170,255,0.02)', sensorOutlineColor: '#55aaff' }
            }
        },
        {
            category: 'Ground',
            name: 'PAVE PAWS',
            icon: '#7799ff',
            description: 'UHF phased array, ICBM/SLBM warning',
            tooltip: 'AN/FPS-132 PAVE PAWS. UHF phased array for missile warning. 5,500km range. Cape Cod, Beale, Clear AFS.',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 5500000, fov_deg: 240, scanRate_dps: 10, detectionProbability: 0.98 },
                visual: { type: 'ground_station', color: '#7799ff', label: 'PAWS', sensorRange_m: 5500000, sensorColor: 'rgba(119,153,255,0.01)', sensorOutlineColor: '#7799ff' }
            }
        },
        {
            category: 'Ground',
            name: 'Cyber Operations Center',
            icon: '#00ff66',
            description: 'Offensive/defensive cyber ops node',
            tooltip: 'Cyber Operations Center. Full-spectrum cyber warfare. Offensive (exploit, DDoS, MITM) and defensive (firewall, IDS, patch).',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                physics: { type: 'static_ground' },
                visual: { type: 'ground_station', color: '#00ff66', label: 'CYBER' }
            },
            _custom: { sensors: [], payloads: [] }
        },
        {
            category: 'Ground',
            name: 'EW Jammer Site',
            icon: '#ffaa00',
            description: 'Ground-based electronic warfare jammer',
            tooltip: 'Ground-based EW jammer. Broadband jamming against radar and comms. 200km effective range.',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 20, detectionProbability: 0.75 },
                visual: { type: 'ground_station', color: '#ffaa00', label: 'JAM', sensorRange_m: 200000, sensorColor: 'rgba(255,170,0,0.04)', sensorOutlineColor: '#ffaa00' }
            },
            _custom: { sensors: [{ type: 'sigint', range_km: 200 }], payloads: ['jammer'] }
        },
        // --- Naval ---
        {
            category: 'Naval',
            name: 'CVN Nimitz Carrier',
            icon: '#4466aa',
            description: 'Nuclear carrier, embarked air wing',
            type: 'naval',
            team: 'blue',
            defaults: { alt: 0, speed: 8 },
            components: {
                physics: { type: 'naval', config: 'cvn_nimitz' },
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.90 },
                visual: { type: 'ground_station', color: '#4466aa', label: 'CVN', sensorRange_m: 200000, sensorColor: 'rgba(68,102,170,0.04)', sensorOutlineColor: '#4466aa' }
            }
        },
        {
            category: 'Naval',
            name: 'DDG Arleigh Burke',
            icon: '#3355aa',
            description: 'Aegis destroyer, SPY-1D radar, SM-2/3',
            type: 'naval',
            team: 'blue',
            defaults: { alt: 0, speed: 10 },
            components: {
                physics: { type: 'naval', config: 'ddg_arleigh_burke' },
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
            type: 'naval',
            team: 'blue',
            defaults: { alt: 0, speed: 8 },
            components: {
                physics: { type: 'naval', config: 'ssn_virginia', submarine: true },
                sensors: { type: 'radar', maxRange_m: 40000, fov_deg: 360, scanRate_dps: 10, detectionProbability: 0.70 },
                visual: { type: 'ground_station', color: '#224488', label: 'SSN', sensorRange_m: 40000, sensorColor: 'rgba(34,68,136,0.06)', sensorOutlineColor: '#224488' }
            }
        },
        {
            category: 'Naval',
            name: 'FFG Constellation',
            icon: '#5577aa',
            description: 'Multi-mission frigate, EASR radar',
            type: 'naval',
            team: 'blue',
            defaults: { alt: 0, speed: 10 },
            components: {
                physics: { type: 'naval', config: 'ffg_constellation' },
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
            type: 'naval',
            team: 'blue',
            defaults: { alt: 0, speed: 10 },
            components: {
                physics: { type: 'naval', config: 'lpd_san_antonio' },
                sensors: { type: 'radar', maxRange_m: 100000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.80 },
                visual: { type: 'ground_station', color: '#668899', label: 'LHD', sensorRange_m: 100000, sensorColor: 'rgba(102,136,153,0.05)', sensorOutlineColor: '#668899' }
            }
        },
        {
            category: 'Naval',
            name: 'Kirov Battlecruiser',
            icon: '#aa3333',
            description: 'Nuclear battlecruiser, S-300F SAM, P-700 AShM',
            type: 'naval',
            team: 'red',
            defaults: { alt: 0, speed: 15 },
            components: {
                physics: { type: 'naval', config: 'ddg_arleigh_burke' },
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
            type: 'naval',
            team: 'red',
            defaults: { alt: 0, speed: 8 },
            components: {
                physics: { type: 'naval', config: 'cvn_nimitz' },
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 30, detectionProbability: 0.85 },
                visual: { type: 'ground_station', color: '#993333', label: 'KUZNTSV', sensorRange_m: 200000, sensorColor: 'rgba(153,51,51,0.04)', sensorOutlineColor: '#993333' }
            }
        },
        {
            category: 'Naval',
            name: 'Kilo-class Submarine',
            icon: '#882222',
            description: 'Diesel-electric attack submarine, very quiet',
            type: 'naval',
            team: 'red',
            defaults: { alt: 0, speed: 5 },
            components: {
                physics: { type: 'naval', config: 'ssk_diesel', submarine: true },
                sensors: { type: 'radar', maxRange_m: 30000, fov_deg: 360, scanRate_dps: 8, detectionProbability: 0.65 },
                visual: { type: 'ground_station', color: '#882222', label: 'KILO', sensorRange_m: 30000, sensorColor: 'rgba(136,34,34,0.06)', sensorOutlineColor: '#882222' }
            }
        },
        {
            category: 'Naval',
            name: 'Slava-class Cruiser',
            icon: '#bb4444',
            description: 'Guided missile cruiser, S-300F, P-500',
            type: 'naval',
            team: 'red',
            defaults: { alt: 0, speed: 15 },
            components: {
                physics: { type: 'naval', config: 'ddg_arleigh_burke' },
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

        // Tooltip from template tooltip or description field
        if (tpl.tooltip) {
            item.title = tpl.tooltip;
        } else if (tpl.description) {
            item.title = tpl.description;
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
            var isAtmo = tpl.components && tpl.components.physics &&
                tpl.components.physics.type === 'flight3dof';
            var hasSpaceProp = tpl._custom && tpl._custom.propulsion &&
                (tpl._custom.propulsion.rocket || tpl._custom.propulsion.hypersonic || tpl._custom.propulsion.ion);
            var defaultMode = (isAtmo && !hasSpaceProp) ? 'aircraft' : 'spacecraft';
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
