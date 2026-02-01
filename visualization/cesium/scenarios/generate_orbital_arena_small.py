#!/usr/bin/env python3
"""Generate a 5v5 GEO orbital arena scenario JSON."""

import json
import os

SMA = 42164000
ECC = 0.0001
INC = 0.001
RAAN = 0
ARG_PERIGEE = 0

SENSOR_RANGE = 1000000
DEFENSE_RADIUS = 500000
MAX_ACCEL = 50.0
KILL_RANGE = 50000
SCAN_INTERVAL = 1.0

WEAPON_PK = 0.7
WEAPON_COOLDOWN = 5.0

# Mean anomalies: Blue 0-30 deg, Red 10-40 deg
BLUE_ANOMALIES = {
    "hva-001": 0,
    "hva-002": 8,
    "defender-001": 4,
    "attacker-001": 20,
    "sweep-001": 30,
}

RED_ANOMALIES = {
    "hva-001": 10,
    "hva-002": 18,
    "defender-001": 14,
    "attacker-001": 30,
    "sweep-001": 40,
}


def make_physics(mean_anomaly_deg):
    return {
        "type": "orbital_2body",
        "source": "elements",
        "sma": SMA,
        "ecc": ECC,
        "inc": INC,
        "raan": RAAN,
        "argPerigee": ARG_PERIGEE,
        "meanAnomaly": mean_anomaly_deg,
    }


def make_ai(role, assigned_hva_id=None):
    ai = {
        "type": "orbital_combat",
        "role": role,
        "sensorRange": SENSOR_RANGE,
        "defenseRadius": DEFENSE_RADIUS,
        "maxAccel": MAX_ACCEL,
        "killRange": KILL_RANGE,
        "scanInterval": SCAN_INTERVAL,
    }
    if assigned_hva_id is not None:
        ai["assignedHvaId"] = assigned_hva_id
    return ai


def make_weapons():
    return {
        "type": "kinetic_kill",
        "Pk": WEAPON_PK,
        "killRange": KILL_RANGE,
        "cooldown": WEAPON_COOLDOWN,
    }


def make_entity(entity_id, name, team, role, mean_anomaly_deg, assigned_hva_id=None):
    components = {
        "physics": make_physics(mean_anomaly_deg),
        "ai": make_ai(role, assigned_hva_id),
    }
    # HVAs get NO weapons
    if role != "hva":
        components["weapons"] = make_weapons()

    return {
        "id": entity_id,
        "name": name,
        "type": "satellite",
        "team": team,
        "initialState": {},
        "components": components,
    }


def build_scenario():
    entities = []

    # --- Blue team ---
    entities.append(make_entity(
        "blue-hva-001", "Blue-HVA-001", "blue", "hva",
        BLUE_ANOMALIES["hva-001"],
    ))
    entities.append(make_entity(
        "blue-hva-002", "Blue-HVA-002", "blue", "hva",
        BLUE_ANOMALIES["hva-002"],
    ))
    entities.append(make_entity(
        "blue-defender-001", "Blue-Defender-001", "blue", "defender",
        BLUE_ANOMALIES["defender-001"],
        assigned_hva_id="blue-hva-001",
    ))
    entities.append(make_entity(
        "blue-attacker-001", "Blue-Attacker-001", "blue", "attacker",
        BLUE_ANOMALIES["attacker-001"],
    ))
    entities.append(make_entity(
        "blue-sweep-001", "Blue-Sweep-001", "blue", "sweep",
        BLUE_ANOMALIES["sweep-001"],
    ))

    # --- Red team ---
    entities.append(make_entity(
        "red-hva-001", "Red-HVA-001", "red", "hva",
        RED_ANOMALIES["hva-001"],
    ))
    entities.append(make_entity(
        "red-hva-002", "Red-HVA-002", "red", "hva",
        RED_ANOMALIES["hva-002"],
    ))
    entities.append(make_entity(
        "red-defender-001", "Red-Defender-001", "red", "defender",
        RED_ANOMALIES["defender-001"],
        assigned_hva_id="red-hva-001",
    ))
    entities.append(make_entity(
        "red-attacker-001", "Red-Attacker-001", "red", "attacker",
        RED_ANOMALIES["attacker-001"],
    ))
    entities.append(make_entity(
        "red-sweep-001", "Red-Sweep-001", "red", "sweep",
        RED_ANOMALIES["sweep-001"],
    ))

    scenario = {
        "metadata": {
            "name": "Test Orbital Arena Small",
            "description": "5v5 GEO combat test",
            "version": "2.0",
        },
        "environment": {
            "maxTimeWarp": 64,
        },
        "entities": entities,
        "events": [],
        "camera": {
            "target": "blue-hva-001",
            "range": 500000,
            "pitch": -0.5,
        },
    }
    return scenario


def main():
    scenario = build_scenario()
    output_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "test_orbital_arena_small.json",
    )
    with open(output_path, "w") as f:
        json.dump(scenario, f, indent=2)
    print(f"Wrote {len(scenario['entities'])} entities to {output_path}")


if __name__ == "__main__":
    main()
