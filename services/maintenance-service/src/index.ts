import { logger } from "@aps/shared";
import { app } from "./app";

const PORT = Number(process.env.PORT ?? 4012);

app.listen(PORT, () => {
  logger.info(`maintenance-service listening on :${PORT}`);
});
