---
name: erp-integration-service
description: Inbound enterprise ERP ingestion boundary (Port 4018). Ingests SAP ORDERS05 IDocs and legacy EDI feeds into platform sales orders.
---

# ERP Integration Service (`services/erp-integration`)

## Overview
The `erp-integration` service acts as the inbound ingestion boundary for external enterprise backbones (such as SAP S/4HANA, ECC, or legacy EDI brokers).

## Core Capabilities
- **IDoc Processing**: Exposes `POST /erp/idocs/orders05` to receive standard SAP `ORDERS05` XML/JSON structures.
- **Master Data Resolution**: Matches external customer partner numbers and material codes to internal platform identifiers.
- **Document Ingestion**: Translates external orders into platform `SalesOrder` records, documented as an authorized external creation path in `architecture/contract.yaml` (Invariant A1).

## Running & Testing
```bash
cd services/erp-integration
npx tsx src/index.ts  # Runs on port 4018
npx vitest run        # Runs ERP integration tests
```
