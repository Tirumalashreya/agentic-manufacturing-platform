---
name: aps-platform-web
description: Advanced Planning & Scheduling (APS) and Shop-Floor Terminal web application (Port 3001). Provides finite Gantt charts, operator rosters, and touch-friendly execution terminals.
---

# APS & Plant Operations Portal (`web`)

## Overview
The `web` application is the dedicated portal for plant operations (Master Schedulers, Plant Managers, Maintenance Leads, and Machine Operators). It runs on Next.js on port 3001.

## Workspaces & Views

### 1. Master Planning & Scheduling
- `/schedule`: High-density interactive Gantt chart displaying machine rows, operator rows, setup times, and delivery-risk lateness indicators.
- **Disruption Simulator**: Panel on `/schedule` enabling planners to simulate machine breakdowns, order cancellations, and quantity changes, triggering background Kafka rescheduling.
- `/materials`: Component stock levels, BOM structures, and real-time material shortage warnings.
- `/machines`: Work center layouts, machine operational statuses (`AVAILABLE`, `DOWN`, `MAINTENANCE`), and OEE metrics.
- `/calendar`: Factory working calendars, shift definitions, and holiday exceptions.

### 2. Labor & Operators
- `/operators`: Operator employee profiles, skill matrices (minimum proficiency), and shift allocations.

### 3. Shop-Floor Terminal ("My Jobs")
- `/my-jobs`: Fulcrum-style touch-friendly execution terminal for machinists and operators:
  - Displays jobs queued by scheduled start time.
  - Large touch buttons: **Start**, **Complete** (records good and scrap units), and **Block** (reports machine breakdown).

## Running the Application
```bash
cd web
npm run dev   # Runs on http://localhost:3001
```
