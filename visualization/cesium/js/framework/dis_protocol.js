/**
 * DIS Protocol Encoder — IEEE 1278.1 binary PDU encoding.
 *
 * Encodes Entity State (type 1), Fire (type 2), and Detonation (type 3) PDUs
 * for Distributed Interactive Simulation interoperability.
 *
 * All positions are converted from geodetic (lat/lon/alt) to ECEF (X/Y/Z)
 * as required by the DIS standard.
 */
const DISProtocol = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------
    var DIS_PROTOCOL_VERSION = 6;   // DIS v6 (IEEE 1278.1-1995)
    var DIS_PROTOCOL_FAMILY = 1;    // Entity Information/Interaction

    // PDU Types
    var PDU_ENTITY_STATE = 1;
    var PDU_FIRE = 2;
    var PDU_DETONATION = 3;

    // PDU sizes (bytes)
    var ENTITY_STATE_PDU_SIZE = 144;
    var FIRE_PDU_SIZE = 96;
    var DETONATION_PDU_SIZE = 104;

    // WGS-84 ellipsoid
    var WGS84_A = 6378137.0;           // semi-major axis (m)
    var WGS84_B = 6356752.314245;      // semi-minor axis (m)
    var WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

    // Force IDs
    var FORCE_OTHER    = 0;
    var FORCE_FRIENDLY = 1;
    var FORCE_OPPOSING = 2;
    var FORCE_NEUTRAL  = 3;

    // -----------------------------------------------------------------------
    // DIS Entity Type Enumerations (SISO-REF-010)
    // kind, domain, country, category, subcategory, specific, extra
    // -----------------------------------------------------------------------
    var ENTITY_TYPES = {
        // Aircraft
        'f16':        { kind: 1, domain: 2, country: 225, category: 1, subcategory: 2, specific: 0, extra: 0 },
        'mig29':      { kind: 1, domain: 2, country: 222, category: 1, subcategory: 3, specific: 0, extra: 0 },
        'spaceplane': { kind: 1, domain: 2, country: 225, category: 4, subcategory: 0, specific: 0, extra: 0 },
        'aircraft':   { kind: 1, domain: 2, country: 225, category: 1, subcategory: 0, specific: 0, extra: 0 },

        // Satellites
        'satellite':   { kind: 1, domain: 4, country: 225, category: 1, subcategory: 0, specific: 0, extra: 0 },
        'leo_sat':     { kind: 1, domain: 4, country: 225, category: 1, subcategory: 1, specific: 0, extra: 0 },
        'gps_sat':     { kind: 1, domain: 4, country: 225, category: 2, subcategory: 0, specific: 0, extra: 0 },
        'geo_comms':   { kind: 1, domain: 4, country: 225, category: 3, subcategory: 0, specific: 0, extra: 0 },

        // Ground
        'ground_station': { kind: 1, domain: 1, country: 225, category: 12, subcategory: 0, specific: 0, extra: 0 },
        'sam_battery':    { kind: 1, domain: 1, country: 222, category: 28, subcategory: 2, specific: 0, extra: 0 },
        'ew_radar':       { kind: 1, domain: 1, country: 222, category: 28, subcategory: 1, specific: 0, extra: 0 },
        'gps_receiver':   { kind: 1, domain: 1, country: 225, category: 12, subcategory: 1, specific: 0, extra: 0 },
        'ground':         { kind: 1, domain: 1, country: 225, category: 0, subcategory: 0, specific: 0, extra: 0 },

        // Munitions
        'aim9':     { kind: 2, domain: 2, country: 225, category: 1, subcategory: 1, specific: 0, extra: 0 },
        'aim120':   { kind: 2, domain: 2, country: 225, category: 1, subcategory: 2, specific: 0, extra: 0 },
        'sam':      { kind: 2, domain: 2, country: 222, category: 1, subcategory: 3, specific: 0, extra: 0 },

        // Default
        'generic':  { kind: 0, domain: 0, country: 0, category: 0, subcategory: 0, specific: 0, extra: 0 }
    };

    // -----------------------------------------------------------------------
    // Geodetic to ECEF conversion (WGS-84)
    // -----------------------------------------------------------------------

    /**
     * Convert geodetic coordinates to ECEF.
     * @param {number} latRad  Latitude in radians
     * @param {number} lonRad  Longitude in radians
     * @param {number} alt     Altitude in meters above WGS-84 ellipsoid
     * @returns {{x: number, y: number, z: number}} ECEF in meters
     */
    function geodeticToECEF(latRad, lonRad, alt) {
        var sinLat = Math.sin(latRad);
        var cosLat = Math.cos(latRad);
        var sinLon = Math.sin(lonRad);
        var cosLon = Math.cos(lonRad);

        // Radius of curvature in the prime vertical
        var N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

        return {
            x: (N + alt) * cosLat * cosLon,
            y: (N + alt) * cosLat * sinLon,
            z: (N * (1 - WGS84_E2) + alt) * sinLat
        };
    }

    // -----------------------------------------------------------------------
    // Force ID mapping
    // -----------------------------------------------------------------------

    function teamToForceId(team) {
        if (team === 'blue') return FORCE_FRIENDLY;
        if (team === 'red') return FORCE_OPPOSING;
        if (team === 'neutral') return FORCE_NEUTRAL;
        return FORCE_OTHER;
    }

    // -----------------------------------------------------------------------
    // Entity type lookup
    // -----------------------------------------------------------------------

    /**
     * Look up DIS entity type from entity definition.
     * Tries subtype first, then type, then generic fallback.
     */
    function lookupEntityType(entity) {
        // Try entity name-based hints
        var name = (entity.name || '').toLowerCase();
        if (name.indexOf('f-16') >= 0 || name.indexOf('f16') >= 0) return ENTITY_TYPES.f16;
        if (name.indexOf('mig') >= 0) return ENTITY_TYPES.mig29;
        if (name.indexOf('spaceplane') >= 0 || name.indexOf('x-37') >= 0) return ENTITY_TYPES.spaceplane;

        // Try type
        var type = entity.type || 'generic';
        if (ENTITY_TYPES[type]) return ENTITY_TYPES[type];

        // Try subtype from components
        if (entity.components) {
            if (entity.components.weapons && entity.components.weapons.type === 'sam_battery') return ENTITY_TYPES.sam_battery;
            if (entity.components.sensors && entity.components.sensors.type === 'radar') return ENTITY_TYPES.ew_radar;
        }

        return ENTITY_TYPES.generic;
    }

    // -----------------------------------------------------------------------
    // PDU Header Builder
    // -----------------------------------------------------------------------

    /**
     * Write PDU header (12 bytes) into a DataView.
     * @param {DataView} view
     * @param {number} offset     Byte offset to start writing
     * @param {number} pduType    PDU type number
     * @param {number} pduLength  Total PDU length in bytes
     * @param {number} exerciseId Exercise identifier
     * @param {number} timestamp  DIS timestamp (relative/absolute)
     */
    function writePDUHeader(view, offset, pduType, pduLength, exerciseId, timestamp) {
        view.setUint8(offset + 0, DIS_PROTOCOL_VERSION);   // Protocol version
        view.setUint8(offset + 1, exerciseId & 0xFF);      // Exercise ID
        view.setUint8(offset + 2, pduType);                 // PDU Type
        view.setUint8(offset + 3, DIS_PROTOCOL_FAMILY);    // Protocol Family
        view.setUint32(offset + 4, timestamp, false);       // Timestamp (big-endian)
        view.setUint16(offset + 8, pduLength, false);       // Length
        view.setUint16(offset + 10, 0, false);              // Padding
    }

    // -----------------------------------------------------------------------
    // Entity ID Writer (6 bytes: site, app, entity)
    // -----------------------------------------------------------------------

    function writeEntityId(view, offset, siteId, appId, entityId) {
        view.setUint16(offset + 0, siteId, false);
        view.setUint16(offset + 2, appId, false);
        view.setUint16(offset + 4, entityId, false);
    }

    // -----------------------------------------------------------------------
    // Entity Type Writer (8 bytes)
    // -----------------------------------------------------------------------

    function writeEntityType(view, offset, et) {
        view.setUint8(offset + 0, et.kind);
        view.setUint8(offset + 1, et.domain);
        view.setUint16(offset + 2, et.country, false);
        view.setUint8(offset + 4, et.category);
        view.setUint8(offset + 5, et.subcategory);
        view.setUint8(offset + 6, et.specific);
        view.setUint8(offset + 7, et.extra);
    }

    // -----------------------------------------------------------------------
    // World Position Writer (24 bytes: 3 x float64)
    // -----------------------------------------------------------------------

    function writeWorldCoord(view, offset, x, y, z) {
        view.setFloat64(offset + 0, x, false);
        view.setFloat64(offset + 8, y, false);
        view.setFloat64(offset + 16, z, false);
    }

    // -----------------------------------------------------------------------
    // Linear Velocity Writer (12 bytes: 3 x float32)
    // -----------------------------------------------------------------------

    function writeLinearVelocity(view, offset, vx, vy, vz) {
        view.setFloat32(offset + 0, vx, false);
        view.setFloat32(offset + 4, vy, false);
        view.setFloat32(offset + 8, vz, false);
    }

    // -----------------------------------------------------------------------
    // Orientation Writer (12 bytes: psi, theta, phi as float32)
    // -----------------------------------------------------------------------

    function writeOrientation(view, offset, psi, theta, phi) {
        view.setFloat32(offset + 0, psi, false);
        view.setFloat32(offset + 4, theta, false);
        view.setFloat32(offset + 8, phi, false);
    }

    // -----------------------------------------------------------------------
    // Marking Writer (12 bytes: 1 byte charset + 11 bytes string)
    // -----------------------------------------------------------------------

    function writeMarking(view, offset, markingStr) {
        view.setUint8(offset, 1);   // ASCII charset
        var str = markingStr || '';
        for (var i = 0; i < 11; i++) {
            view.setUint8(offset + 1 + i, i < str.length ? str.charCodeAt(i) & 0x7F : 0);
        }
    }

    // -----------------------------------------------------------------------
    // DIS Timestamp (relative to hour)
    // -----------------------------------------------------------------------

    function makeDISTimestamp(simTime) {
        // DIS uses a 31-bit timestamp relative to the hour
        // Units: 2^31 = 1 hour, so each unit = 3600/2^31 seconds
        var hourFrac = (simTime % 3600) / 3600;
        return Math.floor(hourFrac * 0x7FFFFFFF) & 0x7FFFFFFF;
    }

    // -----------------------------------------------------------------------
    // Encode Entity State PDU (Type 1)
    // -----------------------------------------------------------------------

    /**
     * Encode an Entity State PDU.
     * @param {object} entity      ECS entity with state { lat, lon, alt, speed, heading, gamma }
     * @param {number} disEntityId DIS entity ID number
     * @param {number} exerciseId  Exercise ID
     * @param {number} simTime     Simulation time in seconds
     * @param {number} siteId      Site ID (default 1)
     * @param {number} appId       Application ID (default 1)
     * @returns {ArrayBuffer}
     */
    function encodeEntityState(entity, disEntityId, exerciseId, simTime, siteId, appId) {
        siteId = siteId || 1;
        appId = appId || 1;

        var buf = new ArrayBuffer(ENTITY_STATE_PDU_SIZE);
        var view = new DataView(buf);
        var timestamp = makeDISTimestamp(simTime);

        // Header (12 bytes)
        writePDUHeader(view, 0, PDU_ENTITY_STATE, ENTITY_STATE_PDU_SIZE, exerciseId, timestamp);

        // Entity ID (6 bytes, offset 12)
        writeEntityId(view, 12, siteId, appId, disEntityId);

        // Force ID (1 byte, offset 18)
        view.setUint8(18, teamToForceId(entity.team));

        // Number of articulation params (1 byte, offset 19)
        view.setUint8(19, 0);

        // Entity Type (8 bytes, offset 20)
        var entityType = lookupEntityType(entity);
        writeEntityType(view, 20, entityType);

        // Alternative Entity Type (8 bytes, offset 28) — same as entity type
        writeEntityType(view, 28, entityType);

        // Linear Velocity in ECEF frame (12 bytes, offset 36)
        var state = entity.state || {};
        var speed = state.speed || 0;
        var heading = state.heading || 0;
        var gamma = state.gamma || 0;
        var lat = state.lat || 0;
        var lon = state.lon || 0;

        // Convert NED velocity to ECEF
        var vN = speed * Math.cos(gamma) * Math.cos(heading);
        var vE = speed * Math.cos(gamma) * Math.sin(heading);
        var vD = -speed * Math.sin(gamma);

        var sinLat = Math.sin(lat);
        var cosLat = Math.cos(lat);
        var sinLon = Math.sin(lon);
        var cosLon = Math.cos(lon);

        // NED to ECEF rotation
        var vx = -sinLat * cosLon * vN - sinLon * vE - cosLat * cosLon * vD;
        var vy = -sinLat * sinLon * vN + cosLon * vE - cosLat * sinLon * vD;
        var vz =  cosLat * vN - sinLat * vD;

        writeLinearVelocity(view, 36, vx, vy, vz);

        // World Position ECEF (24 bytes, offset 48)
        var alt = state.alt || 0;
        var ecef = geodeticToECEF(lat, lon, alt);
        writeWorldCoord(view, 48, ecef.x, ecef.y, ecef.z);

        // Orientation: Euler angles (12 bytes, offset 72)
        // psi = heading, theta = pitch (gamma), phi = roll
        writeOrientation(view, 72, heading, gamma, state.roll || 0);

        // Dead Reckoning Parameters (40 bytes, offset 84)
        // Algorithm: DRM(F,P,W) = 2 (DRM with velocity)
        view.setUint8(84, 2);
        // Remaining 39 bytes: linear accel (12), angular vel (12), padding (15) — zeroed

        // Marking (12 bytes, offset 124)
        var marking = (entity.name || entity.id || '').substring(0, 11);
        writeMarking(view, 124, marking);

        // Capabilities (4 bytes, offset 136) — zero
        // Padding (4 bytes, offset 140) — zero

        return buf;
    }

    // -----------------------------------------------------------------------
    // Encode Fire PDU (Type 2)
    // -----------------------------------------------------------------------

    /**
     * Encode a Fire PDU.
     * @param {object} opts
     * @param {number} opts.firingEntityId   DIS entity ID of firer
     * @param {number} opts.targetEntityId   DIS entity ID of target (0 if none)
     * @param {number} opts.munitionId       DIS entity ID of munition
     * @param {string} opts.munitionType     Munition type key (e.g. 'aim9', 'sam')
     * @param {object} opts.location         {lat, lon, alt} in radians/meters
     * @param {number} opts.velocity         Launch velocity m/s
     * @param {number} opts.range            Max range m
     * @param {number} exerciseId            Exercise ID
     * @param {number} simTime               Simulation time
     * @param {number} siteId                Site ID
     * @param {number} appId                 Application ID
     * @returns {ArrayBuffer}
     */
    function encodeFire(opts, exerciseId, simTime, siteId, appId) {
        siteId = siteId || 1;
        appId = appId || 1;

        var buf = new ArrayBuffer(FIRE_PDU_SIZE);
        var view = new DataView(buf);
        var timestamp = makeDISTimestamp(simTime);

        // Header (12 bytes)
        writePDUHeader(view, 0, PDU_FIRE, FIRE_PDU_SIZE, exerciseId, timestamp);

        // Firing Entity ID (6 bytes, offset 12)
        writeEntityId(view, 12, siteId, appId, opts.firingEntityId || 0);

        // Target Entity ID (6 bytes, offset 18)
        writeEntityId(view, 18, siteId, appId, opts.targetEntityId || 0);

        // Munition Entity ID (6 bytes, offset 24)
        writeEntityId(view, 24, siteId, appId, opts.munitionId || 0);

        // Event ID (6 bytes, offset 30)
        writeEntityId(view, 30, siteId, appId, opts.eventId || 0);

        // Fire Mission Index (4 bytes, offset 36) — zero

        // Location in World Coords (24 bytes, offset 40)
        var loc = opts.location || {};
        var ecef = geodeticToECEF(loc.lat || 0, loc.lon || 0, loc.alt || 0);
        writeWorldCoord(view, 40, ecef.x, ecef.y, ecef.z);

        // Burst Descriptor: munition type (8 bytes, offset 64)
        var munType = ENTITY_TYPES[opts.munitionType] || ENTITY_TYPES.generic;
        writeEntityType(view, 64, munType);

        // Burst Descriptor: warhead (2 bytes, offset 72), fuse (2 bytes, offset 74)
        view.setUint16(72, 1000, false);  // HE warhead
        view.setUint16(74, 100, false);   // Contact fuse

        // Burst Descriptor: quantity (2 bytes, offset 76), rate (2 bytes, offset 78)
        view.setUint16(76, 1, false);
        view.setUint16(78, 0, false);

        // Velocity (12 bytes, offset 80) — simplified as speed in launch direction
        var velocity = opts.velocity || 0;
        writeLinearVelocity(view, 80, velocity, 0, 0);

        // Range (4 bytes float32, offset 92)
        view.setFloat32(92, opts.range || 0, false);

        return buf;
    }

    // -----------------------------------------------------------------------
    // Encode Detonation PDU (Type 3)
    // -----------------------------------------------------------------------

    /**
     * Encode a Detonation PDU.
     * @param {object} opts
     * @param {number} opts.firingEntityId   DIS entity ID of firer
     * @param {number} opts.targetEntityId   DIS entity ID of target
     * @param {number} opts.munitionId       DIS entity ID of munition
     * @param {string} opts.munitionType     Munition type key
     * @param {object} opts.location         {lat, lon, alt} in radians/meters
     * @param {number} opts.result           Detonation result (0=other, 1=entity impact, 3=ground impact, 5=detonation)
     * @param {number} exerciseId
     * @param {number} simTime
     * @param {number} siteId
     * @param {number} appId
     * @returns {ArrayBuffer}
     */
    function encodeDetonation(opts, exerciseId, simTime, siteId, appId) {
        siteId = siteId || 1;
        appId = appId || 1;

        var buf = new ArrayBuffer(DETONATION_PDU_SIZE);
        var view = new DataView(buf);
        var timestamp = makeDISTimestamp(simTime);

        // Header (12 bytes)
        writePDUHeader(view, 0, PDU_DETONATION, DETONATION_PDU_SIZE, exerciseId, timestamp);

        // Firing Entity ID (6 bytes, offset 12)
        writeEntityId(view, 12, siteId, appId, opts.firingEntityId || 0);

        // Target Entity ID (6 bytes, offset 18)
        writeEntityId(view, 18, siteId, appId, opts.targetEntityId || 0);

        // Munition Entity ID (6 bytes, offset 24)
        writeEntityId(view, 24, siteId, appId, opts.munitionId || 0);

        // Event ID (6 bytes, offset 30)
        writeEntityId(view, 30, siteId, appId, opts.eventId || 0);

        // Velocity (12 bytes, offset 36) — zero for detonation

        // Location in World Coords (24 bytes, offset 48)
        var loc = opts.location || {};
        var ecef = geodeticToECEF(loc.lat || 0, loc.lon || 0, loc.alt || 0);
        writeWorldCoord(view, 48, ecef.x, ecef.y, ecef.z);

        // Burst Descriptor: munition type (8 bytes, offset 72)
        var munType = ENTITY_TYPES[opts.munitionType] || ENTITY_TYPES.generic;
        writeEntityType(view, 72, munType);

        // Burst Descriptor: warhead/fuse/quantity/rate (8 bytes, offset 80)
        view.setUint16(80, 1000, false);  // HE warhead
        view.setUint16(82, 100, false);   // Contact fuse
        view.setUint16(84, 1, false);
        view.setUint16(86, 0, false);

        // Location in Entity Coords (12 bytes float32, offset 88) — zero (center)

        // Detonation Result (1 byte, offset 100)
        view.setUint8(100, opts.result || 0);

        // Number of articulation parameters (1 byte, offset 101)
        view.setUint8(101, 0);

        // Padding (2 bytes, offset 102)

        return buf;
    }

    // -----------------------------------------------------------------------
    // Utility: concatenate ArrayBuffers
    // -----------------------------------------------------------------------

    function concatBuffers(buffers) {
        var totalLen = 0;
        for (var i = 0; i < buffers.length; i++) {
            totalLen += buffers[i].byteLength;
        }
        var result = new Uint8Array(totalLen);
        var offset = 0;
        for (var j = 0; j < buffers.length; j++) {
            result.set(new Uint8Array(buffers[j]), offset);
            offset += buffers[j].byteLength;
        }
        return result.buffer;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        // Constants
        PDU_ENTITY_STATE: PDU_ENTITY_STATE,
        PDU_FIRE: PDU_FIRE,
        PDU_DETONATION: PDU_DETONATION,
        ENTITY_STATE_PDU_SIZE: ENTITY_STATE_PDU_SIZE,
        FIRE_PDU_SIZE: FIRE_PDU_SIZE,
        DETONATION_PDU_SIZE: DETONATION_PDU_SIZE,
        ENTITY_TYPES: ENTITY_TYPES,

        // Conversion
        geodeticToECEF: geodeticToECEF,
        teamToForceId: teamToForceId,
        lookupEntityType: lookupEntityType,
        makeDISTimestamp: makeDISTimestamp,

        // Encoding
        encodeEntityState: encodeEntityState,
        encodeFire: encodeFire,
        encodeDetonation: encodeDetonation,
        concatBuffers: concatBuffers
    };
})();
