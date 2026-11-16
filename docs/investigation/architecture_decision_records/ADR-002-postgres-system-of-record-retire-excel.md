# ADR-002: PostgreSQL is the system of record; Excel becomes a shrinking adapter

Status: Proposed

## Context
Delivery, invoice, credit, returns, consignment, export, service, subscription and project data are written to `mock_erp.xlsx` first; Delivery and Invoice are dual-written to Postgres with `postgres_synced` reported, never atomic. Locking is `fcntl.flock` on one host. Agents are behind an `ERPAdapter` interface.

## Problem
Two sources of truth, no reconciliation, single-host only, rewrite-the-workbook performance profile.

## Options
1. Keep as is (demo-grade).
2. **Reconcile, then invert write order per entity (Postgres first, Excel mirror), then retire writes.**
3. Big-bang migration of all sheets. High risk to working flows.

## Decision
Option 2, entity by entity: Delivery, Invoice, Customer/credit, Returns; rest after.

## Consequences
Short period with extra code (mirror writer); eventually Excel disappears from the hot path; `ERPAdapter` stays for SAP.

## Risks
Id mapping (`DEL0001` vs cuid); readers of Excel; agent tools tests depend on the workbook.

## Migration
Report-only reconcile; fix; flip per entity behind a flag; remove Excel reads last.

## Evidence
`delivery_tools.py`, `billing_tools.py`, `idempotency_tools.py` flock notes, `schema.prisma` Delivery/Invoice.
