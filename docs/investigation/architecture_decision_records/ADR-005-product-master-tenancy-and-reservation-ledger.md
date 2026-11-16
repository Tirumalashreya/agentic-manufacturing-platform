# ADR-005: Tenant-scope the product master; introduce a stock reservation ledger

Status: Proposed

## Context
`Product.sku` is globally unique with no `enterpriseId`; `Inventory.qtyReserved` is a counter; `InventoryMovement` has only RECEIPT/ISSUE. Recent audit commits fixed a double-reservation race.

## Problem
Two enterprises cannot own the same SKU; reservations are not traceable to orders and are only as safe as the application locks around a counter.

## Options
1. Leave. Blocks multi-tenant and weakens audit.
2. **Add `enterpriseId` to Product (unique on enterprise+sku); add `StockReservation` rows with states (ACTIVE, RELEASED, CONSUMED) and make `qtyReserved` derived/maintained in the same transaction.**
3. Event-sourced inventory. Overkill.

## Decision
Option 2, expand/contract migrations.

## Consequences
Touches routing-service, inventory-service, order-service and orchestrator tools; clearer audit; simpler shortages.

## Risks
Backfill and unique-key change; every service reading `Product`.

## Migration
Add nullable column, backfill from owning enterprise, dual-read, enforce NOT NULL, swap unique; reservation ledger written alongside the counter, then counter derived.

## Evidence
`schema.prisma:374,1117,1202`; commit `bc6d1be`.
