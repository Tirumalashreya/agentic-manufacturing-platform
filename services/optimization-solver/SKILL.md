---
name: optimization-solver
description: Python OR-Tools CP-SAT mathematical constraint solver (Port 4007). Solves makespan minimization and non-overlap constraint satisfaction problems.
---

# Optimization Solver (`services/optimization-solver`)

## Overview
The `optimization-solver` is a Python/FastAPI service utilizing Google OR-Tools CP-SAT (Constraint Programming - Satisfiability) to find mathematically optimal machine sequences.

## Core Capabilities
- **CP-SAT Modeling**: Formulates machine reservations as non-overlapping interval variables (`NewIntervalVar`).
- **Makespan Minimization**: Minimizes the global completion time of all pending operations across eligible machines.
- **Precedence Enforcement**: Guarantees routing operation constraints ($Start(Op_{2}) \ge End(Op_{1})$).

## Running the Service
```bash
cd services/optimization-solver
uvicorn main:app --port 4007
```
