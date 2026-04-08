import { Router } from "express";
import { runIngestionNow } from "../services/scheduler";
import { logger } from "../lib/logger";

const router = Router();

router.post("/ingestion/run", async (req, res) => {
  logger.info("Manual ingestion run triggered via API");
  res.json({ message: "Data ingestion started" });
  void runIngestionNow();
});

export default router;
