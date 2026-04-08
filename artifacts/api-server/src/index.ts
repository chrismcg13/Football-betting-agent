import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { startScheduler } from "./services/scheduler";
import {
  loadLatestModel,
  bootstrapModels,
} from "./services/predictionEngine";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  await runMigrations();

  startScheduler();

  // Try to load an existing trained model from the database
  const modelLoaded = await loadLatestModel();
  if (!modelLoaded) {
    logger.info(
      "No existing model found — triggering bootstrap training in background",
    );
    // Run bootstrap asynchronously so it doesn't block server startup
    void bootstrapModels().catch((err) =>
      logger.error({ err }, "Background bootstrap training failed"),
    );
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
