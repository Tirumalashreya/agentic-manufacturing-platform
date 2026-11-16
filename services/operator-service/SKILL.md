---
name: operator-service
description: Operator labor management service (Port 4009). Manages employee profiles, machine skills, minimum proficiencies, and shift assignments.
---

# Operator Service (`services/operator-service`)

## Overview
The `operator-service` manages plant personnel, certifications, and shift rosters. It provides labor availability data to `scheduling-service` for joint machine-and-operator scheduling.

## Core Capabilities
- **Operator Skill Matrix**: Tracks employee certifications (e.g. `CNC_LEVEL_3`, `WELDING_TIG`) and proficiency levels (1–5).
- **Shift Assignments**: Connects operators to factory shifts (`WorkCenterShift`, `OperatorShift`).
- **Availability Queries**: Provides qualified operator candidates for specific routing operations.

## Running & Testing
```bash
cd services/operator-service
npx tsx src/index.ts  # Runs on port 4009
```
