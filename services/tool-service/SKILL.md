---
name: tool-service
description: Tooling and fixture management service (Port 4011). Manages CNC tooling life cycles, tool wear, and machine fixture availability.
---

# Tool Service (`services/tool-service`)

## Overview
The `tool-service` manages cutting tools, dies, molds, and fixtures required by routing operations.

## Core Capabilities
- **Tool Inventory**: Tracks physical tool location, status (`READY`, `IN_USE`, `SHARPENING`, `RETIRED`).
- **Tool Wear & Usage**: Records cumulative cutting cycles and operating hours against maximum rated life.

## Running & Testing
```bash
cd services/tool-service
npx tsx src/index.ts  # Runs on port 4011
```
