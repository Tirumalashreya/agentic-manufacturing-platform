import { logger } from "@aps/shared";
import { app } from "./app";

const PORT = Number(process.env.PORT ?? 4018);

app.listen(PORT, () => {
  logger.info(`erp-integration listening on :${PORT}`);
});
