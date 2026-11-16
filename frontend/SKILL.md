---
name: commercial-frontend
description: Commercial Sales & Order-to-Cash (O2C) web application (Port 3000). Provides customer order intake, quote generation, Promise Risk Inbox, and approval dashboards.
---

# Commercial Portal (`frontend`)

## Overview
The `frontend` application is the dedicated web portal for the commercial front office (Sales Executives, Account Managers, and Customer Service Representatives). It runs on Next.js on port 3000.

## Workspaces & Views

### 1. Sales Ledger
- `/domestic-sales`: Domestic order intake, customer credit status, and real-time CTP promise badges.
- `/export-sales`: International orders with Incoterms, currency conversion, and customs documentation.
- `/consignment-sales`: Stock allocated to customer warehouses with sell-through reporting.
- `/services-sales` & `/project-sales`: Service work orders and milestone billing.
- `/trading`: Direct third-party drop-ship orders.
- `/returns`: RMA returns, inspection statuses, and credit memo issuance.
- `/billing`: Commercial invoices and payment status tracking.

### 2. Work & Governance
- `/agent-console`: Chat-based interactive agent interface for free-form customer inquiries and order drafting.
- `/promise-inbox`: High-priority inbox alerting account reps when machine disruptions threaten customer delivery promises.
- `/pending-decisions` & `/approvals`: Reviewing and resolving hash-bound proposals (high discounts, rescheduled orders, credit overrides).
- `/trace` & `/audit`: End-to-end distributed trace timeline linked by `run_id` and `x-trace-id`.

## Running the Application
```bash
cd frontend
npm run dev   # Runs on http://localhost:3000
```
