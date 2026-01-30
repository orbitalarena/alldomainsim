/**
 * IADS Communications — SATCOM relay, message queue, latency model
 * All inter-echelon messages route through GEO SATCOM satellite.
 */
const IadsComms = (function() {
    'use strict';

    // ─── SATCOM Latency Model ────────────────────────────────────
    // Ground → GEO (250ms) + relay processing (50ms) + GEO → Ground (250ms)
    const UPLINK_MS   = 250;
    const RELAY_MS    = 50;
    const DOWNLINK_MS = 250;
    const TOTAL_LATENCY_S = (UPLINK_MS + RELAY_MS + DOWNLINK_MS) / 1000; // 0.55s

    // Leg timing fractions (for animation)
    const UPLINK_FRAC   = UPLINK_MS / (UPLINK_MS + RELAY_MS + DOWNLINK_MS);   // ~0.4545
    const RELAY_FRAC    = RELAY_MS / (UPLINK_MS + RELAY_MS + DOWNLINK_MS);     // ~0.0909
    const DOWNLINK_FRAC = DOWNLINK_MS / (UPLINK_MS + RELAY_MS + DOWNLINK_MS);  // ~0.4545

    let nextMsgId = 1;

    // ─── Message Types ───────────────────────────────────────────

    const MESSAGE_TYPES = {
        DETECTION_REPORT:  { priority: 'HIGH',   color: '#44aaff', label: 'DETECT' },
        TRACK_ASSIGNMENT:  { priority: 'HIGH',   color: '#88ff44', label: 'ASSIGN' },
        TRACK_UPDATE:      { priority: 'HIGH',   color: '#44ff88', label: 'TRACK' },
        THREAT_ASSESSMENT: { priority: 'HIGH',   color: '#ffaa44', label: 'THREAT' },
        WEAPON_ASSIGNMENT: { priority: 'URGENT', color: '#ff8844', label: 'WPN ASSIGN' },
        WEAPONS_FREE:      { priority: 'URGENT', color: '#ff4444', label: 'WPN FREE' },
        LAUNCH_COMMAND:    { priority: 'URGENT', color: '#ff2222', label: 'LAUNCH' },
        ENGAGE_STATUS:     { priority: 'HIGH',   color: '#ffaa22', label: 'ENGAGE' },
        BDA_REPORT:        { priority: 'HIGH',   color: '#ff44ff', label: 'BDA' },
    };

    // ─── Friendly names for routing display ──────────────────────

    const NODE_NAMES = {
        ew_radar: 'EW',
        ttr: 'TTR',
        fcr: 'FCR',
        sam: 'SAM',
        c2: 'C2',
        satcom: 'SAT',
    };

    // ─── Network Creation ────────────────────────────────────────

    function createCommNetwork() {
        return {
            pending: [],
            delivered: [],
        };
    }

    // ─── Send Message ────────────────────────────────────────────

    function send(network, from, to, type, content, simTime) {
        const typeDef = MESSAGE_TYPES[type];
        if (!typeDef) {
            console.warn('Unknown message type:', type);
            return null;
        }

        const msg = {
            id: nextMsgId++,
            type: type,
            typeDef: typeDef,
            from: from,
            to: to,
            via: 'satcom',
            sendTime: simTime,
            arriveTime: simTime + TOTAL_LATENCY_S,
            delivered: false,
            content: content,
            // Animation state
            progress: 0,          // 0-1 overall progress
            leg: 'uplink',        // uplink | relay | downlink | delivered
            legProgress: 0,       // 0-1 within current leg
        };

        network.pending.push(msg);
        return msg;
    }

    // ─── Update Queue ────────────────────────────────────────────

    function update(network, dt, simTime) {
        const justDelivered = [];

        for (let i = network.pending.length - 1; i >= 0; i--) {
            const msg = network.pending[i];

            // Compute overall progress
            const elapsed = simTime - msg.sendTime;
            msg.progress = Math.min(1, elapsed / TOTAL_LATENCY_S);

            // Determine current leg and leg progress
            if (msg.progress < UPLINK_FRAC) {
                msg.leg = 'uplink';
                msg.legProgress = msg.progress / UPLINK_FRAC;
            } else if (msg.progress < UPLINK_FRAC + RELAY_FRAC) {
                msg.leg = 'relay';
                msg.legProgress = (msg.progress - UPLINK_FRAC) / RELAY_FRAC;
            } else if (msg.progress < 1) {
                msg.leg = 'downlink';
                msg.legProgress = (msg.progress - UPLINK_FRAC - RELAY_FRAC) / DOWNLINK_FRAC;
            } else {
                msg.leg = 'delivered';
                msg.legProgress = 1;
            }

            // Deliver if time has arrived
            if (simTime >= msg.arriveTime && !msg.delivered) {
                msg.delivered = true;
                msg.leg = 'delivered';
                msg.progress = 1;
                msg.legProgress = 1;
                network.delivered.push(msg);
                network.pending.splice(i, 1);
                justDelivered.push(msg);
            }
        }

        // Return in send order (loop iterates backwards, so reverse)
        justDelivered.reverse();
        return justDelivered;
    }

    // ─── Query Functions ─────────────────────────────────────────

    function getActiveMessages(network) {
        return network.pending.filter(m => !m.delivered);
    }

    function getMessageLog(network) {
        return network.delivered;
    }

    function getRoutePath(msg) {
        const fromName = NODE_NAMES[msg.from] || msg.from;
        const toName = NODE_NAMES[msg.to] || msg.to;
        return fromName + ' \u2192 SAT \u2192 ' + toName;
    }

    // ─── Public API ──────────────────────────────────────────────

    return {
        TOTAL_LATENCY_S,
        UPLINK_FRAC,
        RELAY_FRAC,
        DOWNLINK_FRAC,
        MESSAGE_TYPES,
        NODE_NAMES,
        createCommNetwork,
        send,
        update,
        getActiveMessages,
        getMessageLog,
        getRoutePath,
    };
})();
