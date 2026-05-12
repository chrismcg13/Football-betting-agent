// ============================================================================
// Live mode integrity reconciliation (2026-05-06)
// ----------------------------------------------------------------------------
// Two checks, both daily, both alert-only (never silently mutate state):
//
// 1. reconcileLiveBalance()
//    - Compare Betfair's actual total balance against the expected balance
//      derived from our local ledger. Catches silent drift between the local
//      paper_bets ledger and Betfair's authoritative wallet.
//
//        actual   = funds.availableToBetBalance + |funds.exposure|
//        expected = starting_deposit + Σ(net_pnl on settled real-money bets)
//
//      Drift > £2 → warning, drift > £20 → critical. Threshold is tunable via
//      agent_config (live_balance_drift_warn / live_balance_drift_critical).
//
// 2. reconcileLiveAccountStatement()
//    - Walk getAccountStatement for the past 48h (configurable). Sum the
//      Betfair amount column per refId. Compare against local net_pnl per
//      bet. Three discrepancy classes:
//        ORPHAN     : Betfair refId we have no local bet for.
//        MISSING    : local settled bet has no Betfair statement entry in window.
//        PNL_DRIFT  : |local.net_pnl - Σ(amount per refId)| > £0.50.
//
// Both functions are no-ops outside live mode and idempotent — safe to run
// repeatedly. Alert dedup is handled by createAlert (per-code cooldown).
// ============================================================================

import { db, paperBetsTable, complianceLogsTable } from "@workspace/db";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getAccountFunds,
  isLiveMode,
  listAccountStatement,
  type AccountStatementItem,
} from "./betfairLive";
import { getStartingDeposit } from "./liveRiskManager";
import { getConfigValue } from "./paperTrading";
import { createAlert } from "./alerting";

const STATEMENT_LOOKBACK_HOURS_DEFAULT = 48;
const PNL_DRIFT_TOLERANCE_GBP = 0.5;
const SETTLED_BET_STATUSES = ["won", "lost", "void"] as const;

// ── 1. Balance vs ledger ──────────────────────────────────────────────────

export interface BalanceReconcileResult {
  actual: number;
  expected: number;
  drift: number;
  startingDeposit: number;
  settledNetPnl: number;
  alertSeverity: "ok" | "warning" | "critical";
}

async function readDriftThreshold(key: string, defaultValue: number): Promise<number> {
  try {
    const raw = await getConfigValue(key);
    if (!raw) return defaultValue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return defaultValue;
    return n;
  } catch {
    return defaultValue;
  }
}

export async function reconcileLiveBalance(): Promise<BalanceReconcileResult | null> {
  if (!isLiveMode()) return null;

  // 2026-05-12: settledNetPnl is computed over bets placed on or after the
  // live cutover (2026-05-09). Anything before that was pre-cutover Replit-
  // era / paper-rail data that doesn't represent real Betfair P&L — including
  // it in the drift calc was producing a £1,110+ phantom drift even though
  // every actual live bet was correctly reconciled. The `betfair_bet_id IS
  // NOT NULL` filter alone isn't sufficient because some pre-cutover paper
  // rows carry stale Betfair IDs from earlier experimentation.
  const [funds, startingDeposit, pnlSumRows] = await Promise.all([
    getAccountFunds(),
    getStartingDeposit(),
    db
      .select({
        netPnlSum: sql<string>`COALESCE(SUM(${paperBetsTable.netPnl}), 0)`,
      })
      .from(paperBetsTable)
      .where(
        and(
          isNotNull(paperBetsTable.betfairBetId),
          sql`${paperBetsTable.placedAt} >= '2026-05-09'::timestamptz`,
          sql`${paperBetsTable.status} IN ('won','lost','void')`,
          sql`${paperBetsTable.deletedAt} IS NULL`,
        ),
      ),
  ]);

  const settledNetPnl = Number(pnlSumRows[0]?.netPnlSum ?? 0);
  const actual = funds.availableToBetBalance + Math.abs(funds.exposure);
  const expected = startingDeposit + settledNetPnl;
  const drift = actual - expected;
  const absDrift = Math.abs(drift);

  const warnThreshold = await readDriftThreshold("live_balance_drift_warn", 2);
  const criticalThreshold = await readDriftThreshold("live_balance_drift_critical", 20);

  let severity: BalanceReconcileResult["alertSeverity"] = "ok";
  if (absDrift > criticalThreshold) severity = "critical";
  else if (absDrift > warnThreshold) severity = "warning";

  if (severity !== "ok") {
    await createAlert({
      severity,
      category: "anomaly",
      code: "LIVE_BALANCE_DRIFT",
      title: `Live balance drift: £${drift.toFixed(2)}`,
      message:
        `Betfair total (£${actual.toFixed(2)}) diverges from local ledger ` +
        `(starting £${startingDeposit.toFixed(2)} + settled net P&L £${settledNetPnl.toFixed(2)} ` +
        `= £${expected.toFixed(2)}) by £${drift.toFixed(2)}. ` +
        `Investigate via account statement reconciliation.`,
      metadata: {
        actual,
        expected,
        drift,
        startingDeposit,
        settledNetPnl,
        availableToBet: funds.availableToBetBalance,
        exposure: Math.abs(funds.exposure),
      },
    });
    logger.warn(
      { actual, expected, drift, severity },
      "Live balance drift detected",
    );
  } else {
    logger.info(
      { actual, expected, drift },
      "Live balance reconciliation: within tolerance",
    );
  }

  await db.insert(complianceLogsTable).values({
    actionType: "live_balance_reconciliation",
    details: {
      actual,
      expected,
      drift,
      startingDeposit,
      settledNetPnl,
      severity,
    },
    timestamp: new Date(),
  });

  return { actual, expected, drift, startingDeposit, settledNetPnl, alertSeverity: severity };
}

// ── 2. Account-statement walk ─────────────────────────────────────────────

export interface StatementReconcileResult {
  itemsScanned: number;
  uniqueRefIds: number;
  orphans: number;
  missing: number;
  pnlDrifts: number;
  totalLocalNetPnl: number;
  totalBetfairNetAmount: number;
  betfairPnlBackfilled: number;
}

interface PerBetfairRefAggregate {
  refId: string;
  totalAmount: number;
  itemCount: number;
  firstItemDate: string;
  lastItemDate: string;
  legacyEventId?: number;
  legacyMarketName?: string;
  legacySelectionName?: string;
}

function aggregateStatementByRefId(items: AccountStatementItem[]): Map<string, PerBetfairRefAggregate> {
  const out = new Map<string, PerBetfairRefAggregate>();
  for (const item of items) {
    const refId = item.refId;
    // Some statement items (deposits, commissions) carry no refId — skip them
    // here; balance reconciliation already accounts for them at the aggregate
    // level via funds.availableToBetBalance + exposure.
    if (!refId || refId === "0") continue;

    const existing = out.get(refId);
    if (existing) {
      existing.totalAmount += Number(item.amount ?? 0);
      existing.itemCount += 1;
      if (item.itemDate < existing.firstItemDate) existing.firstItemDate = item.itemDate;
      if (item.itemDate > existing.lastItemDate) existing.lastItemDate = item.itemDate;
    } else {
      out.set(refId, {
        refId,
        totalAmount: Number(item.amount ?? 0),
        itemCount: 1,
        firstItemDate: item.itemDate,
        lastItemDate: item.itemDate,
        legacyEventId: item.legacyData?.eventId,
        legacyMarketName: item.legacyData?.fullMarketName ?? item.legacyData?.marketName,
        legacySelectionName: item.legacyData?.selectionName,
      });
    }
  }
  return out;
}

export async function reconcileLiveAccountStatement(
  lookbackHours: number = STATEMENT_LOOKBACK_HOURS_DEFAULT,
): Promise<StatementReconcileResult | null> {
  if (!isLiveMode()) return null;

  const now = new Date();
  const fromDate = new Date(now.getTime() - lookbackHours * 3_600_000);

  const items = await listAccountStatement(
    { from: fromDate.toISOString(), to: now.toISOString() },
    "EXCHANGE",
  );
  const byRefId = aggregateStatementByRefId(items);

  // Local settled real-money bets in the same window. Window is by settledAt
  // since the statement records financial impact at settlement time, not at
  // placement time.
  const localBets = await db
    .select({
      id: paperBetsTable.id,
      betfairBetId: paperBetsTable.betfairBetId,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      netPnl: paperBetsTable.netPnl,
      grossPnl: paperBetsTable.grossPnl,
      settledAt: paperBetsTable.settledAt,
    })
    .from(paperBetsTable)
    .where(
      and(
        isNotNull(paperBetsTable.betfairBetId),
        sql`${paperBetsTable.status} IN ('won','lost','void')`,
        sql`${paperBetsTable.deletedAt} IS NULL`,
        gte(paperBetsTable.settledAt, fromDate),
      ),
    );

  const localByBetfairBetId = new Map<string, (typeof localBets)[number]>();
  for (const b of localBets) {
    if (b.betfairBetId) localByBetfairBetId.set(b.betfairBetId, b);
  }

  let orphans = 0;
  let missing = 0;
  let pnlDrifts = 0;
  let totalLocalNetPnl = 0;
  let totalBetfairNetAmount = 0;
  let betfairPnlBackfilled = 0;

  // Pass 1: walk Betfair statement → check for orphans + p&l drift.
  for (const [refId, agg] of byRefId) {
    totalBetfairNetAmount += agg.totalAmount;
    const local = localByBetfairBetId.get(refId);

    if (!local) {
      // Orphan: Betfair has it, we don't.
      orphans++;
      await createAlert({
        severity: "critical",
        category: "anomaly",
        code: `LIVE_STATEMENT_ORPHAN_${refId}`,
        title: "Betfair statement entry has no local bet",
        message:
          `Betfair statement refId=${refId} (£${agg.totalAmount.toFixed(2)}, ` +
          `${agg.itemCount} entries, ${agg.legacyMarketName ?? "unknown market"} / ` +
          `${agg.legacySelectionName ?? "unknown selection"}) has no matching ` +
          `paper_bets row by betfair_bet_id. Either the bet was placed outside ` +
          `the agent or our betfair_bet_id mapping is wrong.`,
        metadata: {
          refId,
          totalAmount: agg.totalAmount,
          itemCount: agg.itemCount,
          firstItemDate: agg.firstItemDate,
          lastItemDate: agg.lastItemDate,
          eventId: agg.legacyEventId,
          marketName: agg.legacyMarketName,
          selectionName: agg.legacySelectionName,
        },
      });
      logger.warn({ refId, amount: agg.totalAmount }, "Live statement orphan: Betfair entry without local bet");
      continue;
    }

    const localNetPnl = Number(local.netPnl ?? 0);
    totalLocalNetPnl += localNetPnl;
    const drift = agg.totalAmount - localNetPnl;
    if (Math.abs(drift) > PNL_DRIFT_TOLERANCE_GBP) {
      pnlDrifts++;
      await createAlert({
        severity: "warning",
        category: "anomaly",
        code: `LIVE_STATEMENT_PNL_DRIFT_${local.id}`,
        title: `P&L drift on bet #${local.id}: £${drift.toFixed(2)}`,
        message:
          `Local net_pnl=£${localNetPnl.toFixed(2)} but Betfair statement sum=` +
          `£${agg.totalAmount.toFixed(2)} for refId=${refId} (drift £${drift.toFixed(2)}). ` +
          `Inspect commission/refund handling.`,
        metadata: {
          betId: local.id,
          refId,
          localNetPnl,
          betfairAmount: agg.totalAmount,
          drift,
          itemCount: agg.itemCount,
        },
      });
      logger.warn({ betId: local.id, refId, localNetPnl, betfairAmount: agg.totalAmount, drift }, "Live statement P&L drift");
    }

    // 2026-05-10: write Betfair's authoritative wallet impact to betfair_pnl.
    // Pre-fix, betfair_pnl was set in reconcileSettlements as cleared.profit -
    // cleared.commission (commission almost always 0 at bet level), making it
    // identical to gross_pnl/net_pnl from the same source — liveAutoRevert's
    // drift comparison (local vs betfair_pnl) was effectively comparing a
    // value to itself. agg.totalAmount sums every wallet line for this refId
    // (win credit, commission debit, voids, refunds), so it is the true
    // independent Betfair-of-record value the drift detector needs.
    //
    // 2026-05-11: per Chris — "settlement must trust betfair pnl service".
    // When wallet impact disagrees with our local net_pnl beyond tolerance,
    // OVERWRITE net_pnl (and status, if the sign disagrees) so the local
    // ledger matches Betfair's authoritative record. Catches two failure
    // modes seen in production: (a) status='won' but Betfair returned the
    // full stake as loss (settlement-classification bug from runner-id
    // mismapping), and (b) status='lost' but Betfair voided the bet.
    // Per memory `feedback_settlement_audit_after_logic_changes`: Betfair
    // wins every disagreement; we backfill the local row + log to
    // compliance_logs for audit.
    const newStatusFromBetfair: "won" | "lost" | "void" =
      agg.totalAmount > 0.50 ? "won"
      : agg.totalAmount < -0.50 ? "lost"
      : "void";
    const statusChanged = newStatusFromBetfair !== local.status;
    const pnlChanged = Math.abs(drift) > PNL_DRIFT_TOLERANCE_GBP;

    if (statusChanged || pnlChanged) {
      // 2026-05-11 v2: write ALL P&L columns consistently from Betfair's
      // authoritative wallet amount. Previously only net_pnl + status got
      // overwritten — leaving gross_pnl, commission_amount and
      // settlement_pnl stale. That broke (a) downstream reporting that
      // sums gross − commission and expected it to equal net, and
      // (b) the risk manager which reads settlement_pnl for daily/weekly
      // loss checks.
      //
      // Derivation from net_pnl (= betfair_pnl = wallet impact):
      //   status=won  → gross = net / (1-commRate); commission = gross - net
      //   status=lost → gross = net (full stake loss); commission = 0
      //   status=void → gross = 0; commission = 0; net = 0
      const COMMISSION_RATE = 0.05; // Betfair standard until £25k lifetime profit
      const newNet = agg.totalAmount;
      let newGross: number;
      let newCommission: number;
      let newSettlementPnl: number;
      if (newStatusFromBetfair === "won") {
        newGross = Math.round((newNet / (1 - COMMISSION_RATE)) * 100) / 100;
        newCommission = Math.round((newGross - newNet) * 100) / 100;
        newSettlementPnl = newNet;
      } else if (newStatusFromBetfair === "lost") {
        newGross = newNet;
        newCommission = 0;
        newSettlementPnl = newNet;
      } else {
        newGross = 0;
        newCommission = 0;
        newSettlementPnl = 0;
      }

      const updates: {
        betfairPnl: string;
        netPnl: string;
        grossPnl: string;
        commissionAmount: string;
        settlementPnl: string;
        status?: string;
      } = {
        betfairPnl: newNet.toFixed(2),
        netPnl: newNet.toFixed(2),
        grossPnl: newGross.toFixed(2),
        commissionAmount: newCommission.toFixed(2),
        settlementPnl: newSettlementPnl.toFixed(2),
      };
      if (statusChanged) updates.status = newStatusFromBetfair;
      await db
        .update(paperBetsTable)
        .set(updates)
        .where(eq(paperBetsTable.id, local.id));
      await db.insert(complianceLogsTable).values({
        actionType: "settlement_autocorrected_from_betfair",
        details: {
          betId: local.id,
          refId,
          previousStatus: local.status,
          newStatus: statusChanged ? newStatusFromBetfair : local.status,
          previousNetPnl: localNetPnl,
          newNetPnl: newNet,
          newGrossPnl: newGross,
          newCommission,
          drift,
          itemCount: agg.itemCount,
        },
        timestamp: new Date(),
      });
      logger.warn(
        {
          betId: local.id,
          refId,
          previousStatus: local.status,
          newStatus: statusChanged ? newStatusFromBetfair : local.status,
          previousNetPnl: localNetPnl,
          newNetPnl: newNet,
          newGrossPnl: newGross,
          newCommission,
          drift,
        },
        "Settlement auto-corrected from Betfair authoritative wallet (all P&L columns)",
      );
    } else {
      // Within tolerance — only sync betfair_pnl (drift-detector input).
      await db
        .update(paperBetsTable)
        .set({ betfairPnl: agg.totalAmount.toFixed(2) })
        .where(eq(paperBetsTable.id, local.id));
    }
    betfairPnlBackfilled++;
  }

  // Pass 2: walk local settled bets → check for missing statement entries.
  for (const local of localBets) {
    if (!local.betfairBetId) continue;
    if (byRefId.has(local.betfairBetId)) continue;
    // Bet settled locally but no statement entry found in lookback window.
    // Possible benign cause: bet settled longer ago than the lookback window
    // but settledAt was updated recently (rare). Treat as warning.
    missing++;
    await createAlert({
      severity: "warning",
      category: "anomaly",
      code: `LIVE_STATEMENT_MISSING_${local.id}`,
      title: `Local settled bet #${local.id} has no Betfair statement entry`,
      message:
        `Bet #${local.id} (Betfair ${local.betfairBetId}, status=${local.status}, ` +
        `net_pnl=£${Number(local.netPnl ?? 0).toFixed(2)}) settled at ${local.settledAt?.toISOString()} ` +
        `but no entry in account statement for last ${lookbackHours}h. ` +
        `Check whether the bet was actually settled at Betfair or whether net_pnl was set incorrectly.`,
      metadata: {
        betId: local.id,
        betfairBetId: local.betfairBetId,
        netPnl: Number(local.netPnl ?? 0),
        settledAt: local.settledAt?.toISOString(),
        lookbackHours,
      },
    });
    logger.warn(
      { betId: local.id, betfairBetId: local.betfairBetId },
      "Live statement missing: local settled bet without Betfair entry",
    );
  }

  const result: StatementReconcileResult = {
    itemsScanned: items.length,
    uniqueRefIds: byRefId.size,
    orphans,
    missing,
    pnlDrifts,
    totalLocalNetPnl,
    totalBetfairNetAmount,
    betfairPnlBackfilled,
  };

  await db.insert(complianceLogsTable).values({
    actionType: "live_statement_reconciliation",
    details: { ...result, lookbackHours },
    timestamp: new Date(),
  });

  logger.info(result, "Live account-statement reconciliation complete");
  return result;
}
