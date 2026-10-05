import { logger } from "@aps/shared";
import { app } from "./app";

const PORT = Number(process.env.PORT ?? 4001);

app.listen(PORT, () => {
  logger.info(`order-service listening on :${PORT}`);
});
