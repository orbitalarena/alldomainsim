/**
 * NavalFormation AI component — keeps escort ships in formation around a flagship.
 *
 * Supports formation patterns:
 *   'screen'       — escorts spread in an arc ahead of flagship
 *   'diamond'      — diamond pattern around flagship
 *   'line_abreast' — side by side
 *   'column'       — single file behind flagship
 *   'wedge'        — V-shaped formation
 *
 * Config:
 *   flagshipId:      entity ID of the formation leader
 *   formation:       'screen' | 'diamond' | 'line_abreast' | 'column' | 'wedge'
 *   stationIndex:    which position in formation (0, 1, 2, ...)
 *   stationDistance:  desired distance from flagship (m), default 5000
 *   speedMatch:      match flagship speed (default true)
 *   maxSpeed:        maximum speed in m/s (default 15)
 *
 * The component writes to entity.state.targetHeading and entity.state.targetSpeed,
 * which are consumed by the NavalComponent physics update.
 *
 * Registers as: ai/naval_formation
 */
(function() {
    'use strict';

    var R_EARTH = 6371000;
    var PI2 = Math.PI * 2;

    /** Haversine distance (meters) between two positions in radians. */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Great-circle bearing (radians [0,2PI)) from p1 to p2 (all radians). */
    function gcBearing(lat1, lon1, lat2, lon2) {
        var dLon = lon2 - lon1;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        var brg = Math.atan2(y, x);
        if (brg < 0) brg += PI2;
        return brg;
    }

    /** Destination point from start (rad), bearing (rad), distance (m). */
    function destinationPoint(lat1, lon1, bearing, distance) {
        var angDist = distance / R_EARTH;
        var lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(angDist) +
            Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
        );
        var lon2 = lon1 + Math.atan2(
            Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
            Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
        );
        return { lat: lat2, lon: lon2 };
    }

    /** Shortest signed angle difference, result in [-PI, PI]. */
    function angleDiff(a, b) {
        var d = a - b;
        while (d > Math.PI) d -= PI2;
        while (d < -Math.PI) d += PI2;
        return d;
    }

    // Formation pattern generators: return bearing offset (rad) from flagship heading
    // and distance multiplier for each station index.
    var FORMATIONS = {
        /**
         * Screen: escorts spread in 120-degree arc ahead of flagship.
         * Index 0 = directly ahead, others fan out.
         */
        screen: function(index, total, dist) {
            var arcSpan = (2 * Math.PI) / 3;  // 120 degrees
            var startAngle = -arcSpan / 2;
            var step = total > 1 ? arcSpan / (total - 1) : 0;
            return {
                bearingOffset: startAngle + step * index,
                distance: dist
            };
        },

        /**
         * Diamond: 4-point diamond (ahead, left, right, behind).
         * Additional ships fill second ring.
         */
        diamond: function(index, total, dist) {
            var angles = [0, Math.PI / 2, -Math.PI / 2, Math.PI];
            if (index < 4) {
                return {
                    bearingOffset: angles[index],
                    distance: dist
                };
            }
            // Second ring: offset 45 degrees, 1.5x distance
            var outerAngles = [Math.PI / 4, -Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4];
            var outerIdx = (index - 4) % outerAngles.length;
            return {
                bearingOffset: outerAngles[outerIdx],
                distance: dist * 1.5
            };
        },

        /**
         * Line abreast: side by side, perpendicular to heading.
         */
        line_abreast: function(index, total, dist) {
            var halfCount = (total - 1) / 2;
            var offset = (index - halfCount) * dist;
            var side = offset >= 0 ? Math.PI / 2 : -Math.PI / 2;
            return {
                bearingOffset: side,
                distance: Math.abs(offset) || dist
            };
        },

        /**
         * Column: single file behind flagship.
         */
        column: function(index, total, dist) {
            return {
                bearingOffset: Math.PI,
                distance: dist * (index + 1)
            };
        },

        /**
         * Wedge: V-shaped, like a formation of geese.
         */
        wedge: function(index, total, dist) {
            var row = Math.floor((index + 1) / 2);
            var side = (index % 2 === 0) ? 1 : -1;
            var angle = side * (Math.PI / 6) * row;  // 30 degrees per row
            return {
                bearingOffset: Math.PI + angle,  // behind and to the side
                distance: dist * row
            };
        }
    };

    class NavalFormation extends ECS.Component {
        constructor(config) {
            super(config);
            this._flagshipId = config.flagshipId || null;
            this._formation = config.formation || 'screen';
            this._stationIndex = config.stationIndex != null ? config.stationIndex : 0;
            this._stationDistance = config.stationDistance || 5000;
            this._speedMatch = config.speedMatch !== false;
            this._maxSpeed = config.maxSpeed || 15;

            // Runtime
            this._stationLat = 0;
            this._stationLon = 0;
        }

        init(world) {
            var s = this.entity.state;
            s._formationRole = 'escort';
            s._formationPattern = this._formation;
            s._formationStatus = 'forming';
            s._formationFlagship = this._flagshipId;
        }

        update(dt, world) {
            if (!world || !this._flagshipId) return;
            var flagship = world.getEntity(this._flagshipId);
            if (!flagship || !flagship.state || !flagship.active) {
                this.entity.state._formationStatus = 'lost';
                return;
            }

            var fs = flagship.state;
            var es = this.entity.state;

            // Count how many formation members exist (for formation spacing)
            var total = this._countFormationMembers(world);

            // Compute assigned station position
            var formationFn = FORMATIONS[this._formation] || FORMATIONS.screen;
            var station = formationFn(this._stationIndex, Math.max(total, 1), this._stationDistance);

            // Station bearing is relative to flagship heading
            var stationBearing = (fs.heading || 0) + station.bearingOffset;
            while (stationBearing < 0) stationBearing += PI2;
            while (stationBearing >= PI2) stationBearing -= PI2;

            // Compute station position
            var stationPt = destinationPoint(
                fs.lat || 0, fs.lon || 0,
                stationBearing, station.distance
            );
            this._stationLat = stationPt.lat;
            this._stationLon = stationPt.lon;

            // Distance to station
            var distToStation = haversineDistance(
                es.lat || 0, es.lon || 0,
                stationPt.lat, stationPt.lon
            );

            // Bearing to station
            var bearingToStation = gcBearing(
                es.lat || 0, es.lon || 0,
                stationPt.lat, stationPt.lon
            );

            // Set target heading for naval physics
            es.targetHeading = bearingToStation;

            // Speed control: match flagship when on station, speed up to catch up
            var flagshipSpeed = fs.speed || 0;
            if (distToStation < this._stationDistance * 0.2) {
                // On station — match flagship speed
                es.targetSpeed = flagshipSpeed;
                es._formationStatus = 'on_station';
            } else if (distToStation < this._stationDistance * 2) {
                // Close — slight speed boost to close gap
                var boost = 1 + (distToStation / (this._stationDistance * 2)) * 0.5;
                es.targetSpeed = Math.min(flagshipSpeed * boost, this._maxSpeed);
                es._formationStatus = 'forming';
            } else {
                // Far — maximum speed to rejoin
                es.targetSpeed = this._maxSpeed;
                es._formationStatus = 'rejoining';
            }

            // Expose formation state for HUD
            es._formationDist = distToStation;
            es._formationBearing = bearingToStation;
        }

        /** Count entities with naval_formation AI targeting same flagship. */
        _countFormationMembers(world) {
            var count = 0;
            var self = this;
            world.entities.forEach(function(ent) {
                if (!ent.active) return;
                var ai = ent.getComponent('ai');
                if (ai && ai.config && ai.config.type === 'naval_formation' &&
                    ai._flagshipId === self._flagshipId) {
                    count++;
                }
            });
            return count;
        }

        cleanup(world) {
            var s = this.entity.state;
            s._formationStatus = null;
            s._formationRole = null;
            s._formationFlagship = null;
        }
    }

    ComponentRegistry.register('ai', 'naval_formation', NavalFormation);
    window.NavalFormation = NavalFormation;
})();
