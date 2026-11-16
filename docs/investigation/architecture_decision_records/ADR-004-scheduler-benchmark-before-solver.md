# ADR-004: Keep the rule-based scheduler; benchmark before any solver change

Status: Proposed

## Context
`pipeline.ts` is a finite-capacity, dispatch-rule engine with calendars, alternates, a frozen zone, an independent validator and versioned publish. Setup is flat per operation. A CP-SAT service exists but models only no-overlap, precedence and makespan, and is undeployed here.

## Problem
No evidence on schedule quality; temptation to swap in CP-SAT or claim superiority.

## Options
1. Replace the engine with CP-SAT. High risk; the CP-SAT model lacks most constraints.
2. **Build a benchmark harness; add sequence-dependent setup to the rule engine; evaluate CP-SAT as a proposer behind the existing validator.**
3. Do nothing.

## Decision
Option 2. A solver is adopted only if it beats the baseline on pilot-like instances and passes the validator within the runtime budget.

## Consequences
Two weeks of tooling before any APS change; claims become evidence-based.

## Risks
Synthetic instances may not represent pilot data; mitigate by capturing anonymised pilot data.

## Migration
Bench → baseline table → changeover in pipeline → optional proposer.

## Evidence
`dispatch-rules.ts`, `pipeline.ts:662`, `schedule-validator.ts`, `optimization-solver/main.py:81`.
