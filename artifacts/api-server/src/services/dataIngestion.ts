import { db, agentConfigTable, complianceLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { runBetfairIngestion } from "./dataIngestionBetfair";

async function getDataSource(): Promise<string> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, "data_source"))
    .limit(1);

  return rows[0]?.value ?? "football_data_fallback";
}

async function logCompliance(
  actionType: string,
  details: Record<string, unknown>,
) {
  try {
    await db.insert(complianceLogsTable).values({
      actionType,
      details,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err }, "Failed to write compliance log");
  }
}

export async function runDataIngestion(): Promise<void> {
  const dataSource = await getDataSource();
  logger.info({ dataSource }, "Data ingestion dispatching to source");

  if (dataSource === "betfair") {
    try {
      await runBetfairIngestion();
    } catch (err) {
      logger.warn(
        { err },
        "Betfair ingestion failed — football-data fallback retired (Stage 4); skipping this cycle",
      );
      await logCompliance("risk_adjustment", {
        action: "betfair_failed_no_fallback",
        reason: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  } else {
    logger.info({}, "data_ingestion: no-op (football-data path retired in Stage 4)");
  }
}
