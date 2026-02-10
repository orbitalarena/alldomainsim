/**
 * TacticalDatalink — Link-16 style track sharing between networked entities.
 *
 * When entities on the same comm network detect targets, they share track data
 * to all network members. Each entity gets both "organic" (own sensor) and
 * "contributed" (network shared) tracks.
 *
 * Usage:
 *   TacticalDatalink.init(world);
 *   TacticalDatalink.update(dt, world);  // call each frame
 *
 * Writes to entity.state:
 *   _sharedTracks: [{ targetId, targetName, range_m, bearing_deg, source, quality, age }]
 *   _organicTracks: [{ targetId, ... }]  (from own sensors)
 *   _contributedTracks: [{ targetId, ..., contributorId, contributorName }]  (from network)
 *   _trackCount: total unique tracks
 */
var TacticalDatalink = (function() {
    'use strict';

    var _initialized = false;
    var _lastUpdate = 0;
    var _updateInterval = 1.0; // 1Hz track sharing

    // Track database: targetId → { bestTrack, contributors: Set }
    var _trackDb = {};

    function init(world) {
        _initialized = true;
        _trackDb = {};
    }

    function update(dt, world) {
        if (!_initialized || !world) return;

        var now = world.simTime || 0;
        if (now - _lastUpdate < _updateInterval) return;
        _lastUpdate = now;

        // Build network membership map: networkId → [entityIds]
        var networks = {};
        if (typeof CommEngine !== 'undefined' && CommEngine.getNetworks) {
            var nets = CommEngine.getNetworks();
            for (var n = 0; n < nets.length; n++) {
                var net = nets[n];
                networks[net.id] = net.members || [];
            }
        }

        // If no CommEngine, check for entity-level network membership
        // (from scenario JSON `networks` field wired by live_sim_engine)
        if (Object.keys(networks).length === 0 && world._networks) {
            for (var nk = 0; nk < world._networks.length; nk++) {
                var nw = world._networks[nk];
                networks[nw.id] = nw.members || [];
            }
        }

        // Collect organic tracks per entity
        var organicTracks = {}; // entityId → [tracks]
        world.entities.forEach(function(ent) {
            if (!ent.active) return;
            var detections = ent.state._detections;
            if (!detections || detections.length === 0) return;

            var tracks = [];
            for (var i = 0; i < detections.length; i++) {
                var det = detections[i];
                if (!det.detected) continue;
                tracks.push({
                    targetId: det.targetId,
                    targetName: det.targetName,
                    range_m: det.range_m,
                    bearing_deg: det.bearing_deg,
                    source: 'organic',
                    quality: 1.0,
                    age: 0,
                    contributorId: ent.id,
                    contributorName: ent.name
                });
            }
            organicTracks[ent.id] = tracks;
            ent.state._organicTracks = tracks;
        });

        // Share tracks across networks
        for (var netId in networks) {
            var members = networks[netId];
            if (!members || members.length < 2) continue;

            // Collect all tracks from all members on this network
            var networkTracks = {}; // targetId → best track info
            for (var m = 0; m < members.length; m++) {
                var memberId = members[m];
                var memberTracks = organicTracks[memberId] || [];
                for (var t = 0; t < memberTracks.length; t++) {
                    var track = memberTracks[t];
                    var existing = networkTracks[track.targetId];
                    if (!existing || track.range_m < existing.range_m) {
                        // Keep best (closest) track per target
                        networkTracks[track.targetId] = {
                            targetId: track.targetId,
                            targetName: track.targetName,
                            range_m: track.range_m,
                            bearing_deg: track.bearing_deg,
                            contributorId: memberId,
                            contributorName: track.contributorName,
                            source: 'network',
                            quality: 0.7, // network tracks are lower quality
                            age: 0
                        };
                    }
                }
            }

            // Distribute shared tracks to all members
            for (var m2 = 0; m2 < members.length; m2++) {
                var ent = world.getEntity(members[m2]);
                if (!ent || !ent.active) continue;

                var organic = ent.state._organicTracks || [];
                var organicIds = new Set();
                for (var o = 0; o < organic.length; o++) {
                    organicIds.add(organic[o].targetId);
                }

                // Contributed = network tracks not in own organic
                var contributed = [];
                for (var tid in networkTracks) {
                    if (organicIds.has(tid)) continue;
                    if (networkTracks[tid].contributorId === ent.id) continue;
                    contributed.push(networkTracks[tid]);
                }

                // Write to entity state
                ent.state._contributedTracks = contributed;
                ent.state._sharedTracks = organic.concat(contributed);
                ent.state._trackCount = organic.length + contributed.length;
            }
        }

        // Entities not on any network: only organic tracks
        world.entities.forEach(function(ent) {
            if (!ent.active) return;
            if (ent.state._sharedTracks) return; // already processed
            var organic = ent.state._organicTracks || [];
            ent.state._sharedTracks = organic;
            ent.state._contributedTracks = [];
            ent.state._trackCount = organic.length;
        });
    }

    function destroy() {
        _initialized = false;
        _trackDb = {};
    }

    return {
        init: init,
        update: update,
        destroy: destroy
    };
})();
