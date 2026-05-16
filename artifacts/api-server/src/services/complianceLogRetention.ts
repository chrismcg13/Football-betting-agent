import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// Bundle N.7 (2026-05-16): targeted retention sweep on compliance_logs.
// 414 MB table; 228 MB of historical action_types are operational debug
// rows that nobody queries past their first 7-30 days. This cron prunes
// them on a daily schedule so storage + sequential-scan cost stay bounded.
//
// Retention policy by actionType:
//   shadow_gate_exemption           — DELETE ALL (last written 2026-05-15, suspected retired)
//   lazy_promote_placement_failed   — 7-day rolling
//   correlation_detection           — 30-day rolling (still actively written)
//   emission_diagnostic             — 30-day rolling (Bundle 0 diagnostic)
//   value_detection_evaluation      — 30-day rolling (last written 2026-04-18 — also stale)
//   value_detection_odds_source     — 30-day rolling (last written 2026-04-18 — also stale)
//
// Audit-critical actionTypes (bet_placed, live_bet_placement_collapse_guard,
// settlement_*, agent_control, bankroll_updated, etc.) are NEVER pruned by
// this job — they feed the per-scope Kelly audit and stay forever.

interface RetentionRule {
  actionType: string;
  retainDays: number | null; // null = delete all (table retired)
}

const RETENTION_RULES: RetentionRule[] = [
  { actionType: "shadow_gate_exemption", retainDays: null },
  { actionType: "lazy_promote_placement_failed", retainDays: 7 },
  { actionType: "correlation_detection", retainDays: 30 },
  { actionType: "emission_diagnostic", retainDays: 30 },
  { actionType: "value_detection_evaluation", retainDays: 30 },
  { actionType: "value_detection_odds_source", retainDays: 30 },
];

export interface ComplianceLogRetentionResult {
  perActionType: Array<{ actionType: string; deleted: number }>;
  totalDeleted: number;
  durationMs: number;
}

export async function runComplianceLogRetention(): Promise<ComplianceLogRetentionResult> {
  const start = Date.now();
  const perActionType: Array<{ actionType: string; deleted: number }> = [];
  let totalDeleted = 0;
  for (const rule of RETENTION_RULES) {
    try {
      const result = rule.retainDays == null
        ? await db.execute(sql`
            DELETE FROM compliance_logs
            WHERE action_type = ${rule.actionType}
          `)
        : await db.execute(sql`
            DELETE FROM compliance_logs
            WHERE action_type = ${rule.actionType}
              AND timestamp < NOW() - (${rule.retainDays}::int * INTERVAL '1 day')
          `);
      const deleted = (result as { rowCount?: number }).rowCount ?? 0;
      perActionType.push({ actionType: rule.actionType, deleted });
      totalDeleted += deleted;
    } catch (err) {
      logger.warn({ err, actionType: rule.actionType }, "compliance_logs retention sweep failed for actionType");
      perActionType.push({ actionType: rule.actionType, deleted: 0 });
    }
  }
  const durationMs = Date.now() - start;
  logger.info({ totalDeleted, perActionType, durationMs }, "compliance_logs retention sweep complete");
  return { perActionType, totalDeleted, durationMs };
}
