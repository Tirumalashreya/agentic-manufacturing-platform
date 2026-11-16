# ADR-006: Agents are propose-only; changes gated by an evaluation suite

Status: Proposed (formalises existing contract rules C1, D1)

## Context
Agents call typed tools; approvals are hash-bound and revalidated. No eval datasets, prompt versions or enforced per-agent tool allow-lists exist. Nine agents are unaudited for write safety.

## Problem
A prompt or model change can silently degrade accuracy or widen behaviour; permissions follow whatever tools are wired in.

## Options
1. Status quo.
2. **Per-agent tool allow-list asserted in tests; write tools require an approved proposal id; eval suite (accuracy, policy, action correctness, latency, cost) must pass before prompt/model changes merge.**
3. Prohibit LLM use in write-adjacent flows. Too restrictive.

## Decision
Option 2; move fulfillment strategy and vendor choice to deterministic rules if still LLM-decided.

## Consequences
Slower prompt iteration; measurable quality.

## Risks
Eval sets can be gamed or stale; refresh from pilot data.

## Migration
Audit nine agents → allow-lists → eval harness → CI gate.

## Evidence
`architecture/contract.yaml` C1/D1, `approval_proposal.py`, `config.py`, grep for eval/prompt-version = 0.
