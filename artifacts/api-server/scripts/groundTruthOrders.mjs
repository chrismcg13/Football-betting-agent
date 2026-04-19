// Ground-truth check: which of our locally-tracked "EXECUTABLE" orders
// are actually still live on Betfair? Read-only. Logs full response to
// the compliance_logs audit trail before any cancellation is performed.
import { listCurrentOrders } from "../dist/services/betfairLive.js";
import { db, complianceLogsTable, paperBetsTable } from "@workspace/db";
import { sql, and, eq, isNotNull, inArray } from "drizzle-orm";

const candidates = await db
  .select({
    id: paperBetsTable.id,
    matchId: paperBetsTable.matchId,
    marketType: paperBetsTable.marketType,
    selectionName: paperBetsTable.selectionName,
    stake: paperBetsTable.stake,
    betfairBetId: paperBetsTable.betfairBetId,
    betfairMarketId: paperBetsTable.betfairMarketId,
    betfairStatus: paperBetsTable.betfairStatus,
    betfairSizeMatched: paperBetsTable.betfairSizeMatched,
    placedAt: paperBetsTable.placedAt,
  })
  .from(paperBetsTable)
  .where(
    and(
      eq(paperBetsTable.status, "pending"),
      sql`deleted_at IS NULL`,
      sql`placed_at < '2026-04-19T20:00:00Z'`,
      isNotNull(paperBetsTable.betfairBetId),
      sql`betfair_status IN ('EXECUTABLE','EXECUTION_COMPLETE')`,
    ),
  );

const betIds = candidates.map((c) => c.betfairBetId).filter(Boolean);
console.log(`[groundTruth] Querying Betfair for ${betIds.length} bet IDs`);

const live = await listCurrentOrders(betIds);
console.log(`[groundTruth] Betfair returned ${live.length} live orders`);

const liveByBetId = new Map(live.map((o) => [o.betId, o]));

const reconciled = candidates.map((c) => {
  const bf = liveByBetId.get(c.betfairBetId);
  return {
    paperBetId: c.id,
    matchId: c.matchId,
    marketType: c.marketType,
    selectionName: c.selectionName,
    stake: Number(c.stake),
    betfairBetId: c.betfairBetId,
    betfairMarketId: c.betfairMarketId,
    ourDbStatus: c.betfairStatus,
    ourDbSizeMatched: Number(c.betfairSizeMatched ?? 0),
    placedAt: c.placedAt,
    betfairLiveStatus: bf?.status ?? "NOT_PRESENT_ON_BETFAIR",
    betfairLiveSizeMatched: bf?.sizeMatched ?? null,
    betfairLiveSizeRemaining: bf?.sizeRemaining ?? null,
    betfairLiveSizeCancelled: bf?.sizeCancelled ?? null,
    betfairLivePrice: bf?.priceSize?.price ?? null,
    betfairLiveSize: bf?.priceSize?.size ?? null,
    classification:
      !bf
        ? "stale_in_db__not_on_betfair"
        : bf.status === "EXECUTABLE" && (bf.sizeRemaining ?? 0) > 0
          ? "still_live__needs_cancellation"
          : bf.status === "EXECUTION_COMPLETE"
            ? "fully_matched__awaiting_settlement"
            : "other",
  };
});

const summary = reconciled.reduce((acc, r) => {
  acc[r.classification] = (acc[r.classification] ?? 0) + 1;
  return acc;
}, {});

console.log("[groundTruth] Classification summary:", summary);
console.log("[groundTruth] Per-row detail:");
console.table(
  reconciled.map((r) => ({
    paperId: r.paperBetId,
    market: r.marketType,
    sel: r.selectionName,
    stake: r.stake,
    ourStatus: r.ourDbStatus,
    bfLive: r.betfairLiveStatus,
    bfRemain: r.betfairLiveSizeRemaining,
    bfMatched: r.betfairLiveSizeMatched,
    classification: r.classification,
  })),
);

await db.insert(complianceLogsTable).values({
  actionType: "betfair_ground_truth_audit",
  details: {
    queriedAt: new Date().toISOString(),
    candidatesQueriedFromDb: candidates.length,
    betfairReturnedLive: live.length,
    classificationSummary: summary,
    reconciledRows: reconciled,
    purpose: "Pre-cancellation ground-truth check before cleanup of pre-cutoff stale pending bets",
  },
  timestamp: new Date(),
});

console.log(`[groundTruth] Audit log written. Total candidates=${candidates.length}, live-on-betfair=${live.length}`);
process.exit(0);
