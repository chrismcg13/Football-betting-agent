import { Router } from "express";
import { runIngestionNow, getSchedulerStatus } from "../services/scheduler";
import { logger } from "../lib/logger";

const router = Router();

router.post("/ingestion/run", async (req, res) => {
  const status = getSchedulerStatus();
  if (status["ingestion"]?.isRunning) {
    res.status(409).json({ success: false, message: "Ingestion already in progress" });
    return;
  }
  logger.info("Manual ingestion triggered via API — awaiting completion");
  try {
    await runIngestionNow();
    const after = getSchedulerStatus();
    res.json({ success: true, message: "Ingestion complete", job: after["ingestion"] });
  } catch (err) {
    logger.error({ err }, "Manual ingestion failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

export default router;
