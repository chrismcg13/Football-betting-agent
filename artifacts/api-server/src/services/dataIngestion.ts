import { db, agentConfigTable, complianceLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { runBetfairIngestion } from "./dataIngestionBetfair";
import { runFallbackIngestion } from "./dataIngestionFallback";

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
        "Betfair ingestion failed — switching to football-data fallback",
      );
      await logCompliance("risk_adjustment", {
        action: "betfair_geo_fallback",
        reason:
          err instanceof Error ? err.message : String(err),
        fallback_source: "football_data_fallback",
        timestamp: new Date().toISOString(),
      });
      await runFallbackIngestion();
    }
  } else {
    await runFallbackIngestion();
  }
}
