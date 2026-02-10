/**
 * Scenario Validator — Checks scenario configurations for common issues.
 */
const ScenarioValidator = (function() {
    'use strict';

    /**
     * Validate a scenario and return array of issues.
     * @param {object} world - ECS World with entities
     * @returns {Array<{level: 'error'|'warning'|'info', msg: string, entityId: string|null}>}
     */
    function validate(world) {
        var issues = [];
        if (!world || !world.entities) {
            issues.push({ level: 'error', msg: 'No world or entities found', entityId: null });
            return issues;
        }

        var entityCount = 0;
        var hasPlayer = false;
        var teamCounts = { blue: 0, red: 0, neutral: 0 };
        var positions = [];  // For overlap detection

        world.entities.forEach(function(entity) {
            entityCount++;
            var s = entity.state || {};
            var etype = entity.type || 'unknown';
            var eid = entity.id || 'unnamed';
            var ename = entity.name || eid;

            // Check for player
            if (eid === 'player' || (entity.components && entity.getComponent && entity.getComponent('control') &&
                entity.getComponent('control').type === 'player_input')) {
                hasPlayer = true;
            }

            // Team count
            var team = entity.team || 'neutral';
            if (teamCounts[team] != null) teamCounts[team]++;
            else teamCounts[team] = 1;

            // Check: No physics component on non-ground entity
            if (etype !== 'ground_station' && etype !== 'ground') {
                var phys = entity.getComponent ? entity.getComponent('physics') : null;
                if (!phys) {
                    issues.push({
                        level: 'warning',
                        msg: ename + ' (' + etype + ') has no physics component — will be stationary',
                        entityId: eid
                    });
                }
            }

            // Check: SAM without radar
            var weapons = entity.getComponent ? entity.getComponent('weapons') : null;
            if (weapons && (weapons.type === 'sam_battery' || weapons._type === 'sam_battery')) {
                var sensors = entity.getComponent ? entity.getComponent('sensors') : null;
                if (!sensors) {
                    issues.push({
                        level: 'warning',
                        msg: ename + ' is a SAM battery without a radar sensor — cannot detect targets',
                        entityId: eid
                    });
                }
            }

            // Check: Aircraft at altitude 0 with engine off
            if (etype === 'aircraft' && (s.alt || 0) === 0 && !s.engineOn && !s.gearDown) {
                issues.push({
                    level: 'info',
                    msg: ename + ' is on the ground with engines off — ensure this is intentional',
                    entityId: eid
                });
            }

            // Check: Missing team
            if (!entity.team) {
                issues.push({
                    level: 'info',
                    msg: ename + ' has no team assignment',
                    entityId: eid
                });
            }

            // Check: Zero speed in air
            if (etype === 'aircraft' && (s.alt || 0) > 100 && (s.speed || 0) < 1) {
                issues.push({
                    level: 'error',
                    msg: ename + ' is airborne at ' + Math.round(s.alt) + 'm altitude but has zero speed — will crash immediately',
                    entityId: eid
                });
            }

            // Check: Satellite with negative/zero SMA
            if ((etype === 'satellite' || etype === 'leo_satellite' || etype === 'gps_satellite' || etype === 'geo_satellite')) {
                var orbPhys = entity.getComponent ? entity.getComponent('physics') : null;
                if (orbPhys && orbPhys._elements) {
                    var sma = orbPhys._elements.sma || orbPhys._elements.a;
                    var ecc = orbPhys._elements.ecc || orbPhys._elements.eccentricity || 0;
                    if (sma && sma < 6400000) {
                        issues.push({
                            level: 'error',
                            msg: ename + ' has SMA ' + (sma/1000).toFixed(0) + ' km — below Earth surface',
                            entityId: eid
                        });
                    }
                    if (ecc >= 1.0) {
                        issues.push({
                            level: 'error',
                            msg: ename + ' has eccentricity ' + ecc.toFixed(3) + ' — escape trajectory',
                            entityId: eid
                        });
                    }
                }
            }

            // Position for overlap detection
            if (s.lat != null && s.lon != null) {
                positions.push({ id: eid, name: ename, lat: s.lat, lon: s.lon, alt: s.alt || 0 });
            }
        });

        // Check: No player entity
        if (!hasPlayer && entityCount > 0) {
            issues.push({
                level: 'info',
                msg: 'No player entity found — scenario will need observer mode or manual entity selection',
                entityId: null
            });
        }

        // Check: Team imbalance
        if (teamCounts.blue > 0 && teamCounts.red > 0) {
            var ratio = Math.max(teamCounts.blue, teamCounts.red) / Math.min(teamCounts.blue, teamCounts.red);
            if (ratio > 5) {
                issues.push({
                    level: 'info',
                    msg: 'Team imbalance: Blue=' + teamCounts.blue + ' Red=' + teamCounts.red + ' (' + ratio.toFixed(1) + ':1 ratio)',
                    entityId: null
                });
            }
        }

        // Check: Large entity count
        if (entityCount > 500) {
            issues.push({
                level: 'warning',
                msg: entityCount + ' entities — may cause performance issues. Consider reducing or using observer mode.',
                entityId: null
            });
        } else if (entityCount > 200) {
            issues.push({
                level: 'info',
                msg: entityCount + ' entities — visualization will use staggered updates for performance.',
                entityId: null
            });
        }

        // Check: Position overlaps (within 10m of each other)
        for (var i = 0; i < positions.length; i++) {
            for (var j = i + 1; j < positions.length; j++) {
                var pi = positions[i];
                var pj = positions[j];
                var dLat = pi.lat - pj.lat;
                var dLon = pi.lon - pj.lon;
                var approxDist = Math.sqrt(dLat * dLat + dLon * dLon) * 6371000;
                var dAlt = Math.abs(pi.alt - pj.alt);
                if (approxDist < 10 && dAlt < 100) {
                    issues.push({
                        level: 'warning',
                        msg: pi.name + ' and ' + pj.name + ' are at nearly the same position',
                        entityId: pi.id
                    });
                }
            }
        }

        // Check: Empty scenario
        if (entityCount === 0) {
            issues.push({
                level: 'warning',
                msg: 'Scenario has no entities',
                entityId: null
            });
        }

        // Sort: errors first, then warnings, then info
        var levelOrder = { error: 0, warning: 1, info: 2 };
        issues.sort(function(a, b) {
            return (levelOrder[a.level] || 3) - (levelOrder[b.level] || 3);
        });

        return issues;
    }

    return {
        validate: validate
    };
})();
