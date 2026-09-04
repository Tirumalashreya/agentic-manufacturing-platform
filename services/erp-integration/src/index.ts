process.env.SERVICE_NAME = "erp-integration";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4018);

// §5 stage 1-2 / §11 "ERP Integration — Bi-directional SAP/Oracle/D365 sync
// (IDocs, BAPIs, REST) — erp.*". No real SAP/Oracle/D365 instance exists to
// integrate with here, so this is a mock adapter matching the documented
// contract shape (an IDoc-style payload in, a confirmed Sales Order out)
// rather than a real bi-directional sync.
app.post("/erp/idocs/orders05", async (req, res) => {
  const { customerName, tier, slaDays, penaltyPerDay, dueDate, value } = req.body as {
    customerName: string;
    tier: "PLATINUM" | "GOLD" | "SILVER" | "STANDARD";
    slaDays: number;
    penaltyPerDay: number;
    dueDate: string;
    value: number;
  };

  const customer = await prisma.customer.upsert({
    where: { id: customerName }, // demo keying; a real integration would map SAP customer numbers
    create: { id: customerName, name: customerName, tier, slaDays, penaltyPerDay },
    update: { tier, slaDays, penaltyPerDay },
  });

  const salesOrder = await prisma.salesOrder.create({
    data: { customerId: customer.id, dueDate: new Date(dueDate), value },
  });

  // "Confirmed Sales Order with ATP date" — a real ATP check cross-references
  // committed capacity/material; simplified here to the requested due date
  // itself, since that cross-check is exactly what the scheduling pipeline
  // does later in the flow.
  logger.info("IDoc ORDERS05 processed", { salesOrderId: salesOrder.id, customerId: customer.id });
  res.status(201).json({ salesOrder, atpDate: salesOrder.dueDate });
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`erp-integration listening on :${PORT}`);
});
