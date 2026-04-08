import { Router, type IRouter } from "express";
import healthRouter from "./health";
import agentConfigRouter from "./agentConfig";
import matchesRouter from "./matches";
import paperBetsRouter from "./paperBets";
import oddsSnapshotsRouter from "./oddsSnapshots";
import complianceLogsRouter from "./complianceLogs";
import learningNarrativesRouter from "./learningNarratives";
import modelStateRouter from "./modelState";
import featuresRouter from "./features";
import ingestionRouter from "./ingestion";
import predictionsRouter from "./predictions";
import tradingRouter from "./trading";

const router: IRouter = Router();

router.use(healthRouter);
router.use(agentConfigRouter);
router.use(matchesRouter);
router.use(paperBetsRouter);
router.use(oddsSnapshotsRouter);
router.use(complianceLogsRouter);
router.use(learningNarrativesRouter);
router.use(modelStateRouter);
router.use(featuresRouter);
router.use(ingestionRouter);
router.use(predictionsRouter);
router.use(tradingRouter);

export default router;
