#!/usr/bin/env python3
"""Generate a 50v50 GEO orbital arena scenario JSON.

Layout: Both blue and red forces share a tight 30-degree arc of mean anomaly
([0, 30] degrees) for guaranteed engagements at GEO.

Per side (50 each):
  10 HVAs       (role: hva, no weapons)
  10 Defenders  (role: defender, weapons, assigned to a friendly HVA)
  15 Attackers  (role: attacker, weapons)
  10 Escorts    (role: escort, weapons)
   5 Sweeps     (role: sweep, weapons)

Total: 100 entities.
"""

import json
import os
import random

random.seed(42)

# --- Orbital constants (GEO) ---
SMA = 42164000
ECC = 0.0001
INC = 0.001
RAAN = 0
ARG_PERIGEE = 0

# --- AI parameters ---
SENSOR_RANGE = 1000000
DEFENSE_RADIUS = 500000
MAX_ACCEL = 50.0
KILL_RANGE = 50000
SCAN_INTERVAL = 1.0

# --- Weapon parameters ---
WEAPON_PK = 0.7
WEAPON_COOLDOWN = 5.0

# --- Mean anomaly range (degrees) ---
MA_MIN = 0.0
MA_MAX = 30.0


def random_ma():
    """Return a random mean anomaly in [MA_MIN, MA_MAX] degrees."""
    return round(random.uniform(MA_MIN, MA_MAX), 4)


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


def build_team(team):
    """Build 50 entities for one team."""
    entities = []
    prefix = team  # "blue" or "red"

    # --- 10 HVAs ---
    hva_ids = []
    for i in range(1, 11):
        eid = f"{prefix}-hva-{i:03d}"
        hva_ids.append(eid)
        name = f"{prefix.capitalize()}-HVA-{i:03d}"
        entities.append(make_entity(eid, name, team, "hva", random_ma()))

    # --- 10 Defenders (each assigned to a friendly HVA, cycling) ---
    for i in range(1, 11):
        eid = f"{prefix}-def-{i:03d}"
        name = f"{prefix.capitalize()}-Def-{i:03d}"
        assigned = hva_ids[(i - 1) % len(hva_ids)]
        entities.append(make_entity(eid, name, team, "defender", random_ma(),
                                    assigned_hva_id=assigned))

    # --- 15 Attackers ---
    for i in range(1, 16):
        eid = f"{prefix}-atk-{i:03d}"
        name = f"{prefix.capitalize()}-Atk-{i:03d}"
        entities.append(make_entity(eid, name, team, "attacker", random_ma()))

    # --- 10 Escorts ---
    for i in range(1, 11):
        eid = f"{prefix}-esc-{i:03d}"
        name = f"{prefix.capitalize()}-Esc-{i:03d}"
        entities.append(make_entity(eid, name, team, "escort", random_ma()))

    # --- 5 Sweeps ---
    for i in range(1, 6):
        eid = f"{prefix}-swp-{i:03d}"
        name = f"{prefix.capitalize()}-Swp-{i:03d}"
        entities.append(make_entity(eid, name, team, "sweep", random_ma()))

    return entities


def build_scenario():
    entities = build_team("blue") + build_team("red")

    scenario = {
        "metadata": {
            "name": "Orbital Arena 50v50",
            "description": "50v50 GEO orbital combat in a tight 30-degree arc for guaranteed engagements",
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
        "test_orbital_arena_100.json",
    )
    with open(output_path, "w") as f:
        json.dump(scenario, f, indent=2)

    # Summary
    teams = {}
    roles = {}
    for e in scenario["entities"]:
        t = e["team"]
        r = e["components"]["ai"]["role"]
        teams[t] = teams.get(t, 0) + 1
        key = f"{t}/{r}"
        roles[key] = roles.get(key, 0) + 1

    print(f"Wrote {len(scenario['entities'])} entities to {output_path}")
    for t in sorted(teams):
        print(f"  {t}: {teams[t]} entities")
    for key in sorted(roles):
        print(f"    {key}: {roles[key]}")


if __name__ == "__main__":
    main()
