/**
 * One-shot: UPDATE the commercial_assumptions_on_unproven_edge_2026_05_15
 * record with the refreshed post-power-analysis content.
 *
 * The original apply-strategic-findings CLI skips on experiment_tag conflict
 * — correct for new records, wrong when content needs refreshing. This script
 * explicitly UPDATES the record for finding 4 with the post-power-analysis
 * falsification data (MO Wilson 0.237, BTTS CLV -1.25, TT_AWAY_05 CLV -2.57,
 * etc.) and the gate_conditions_for_capital_commitment array.
 *
 * Idempotent — UPDATE is naturally idempotent. Re-runs overwrite with the
 * same content.
 *
 * Usage (.env sourced from repo root):
 *   pnpm dlx tsx artifacts/api-server/src/cli/refresh-finding-4-2026-05-15.ts
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const TAG = "commercial_assumptions_on_unproven_edge_2026_05_15";

const FINDINGS = {
  summary:
    "The £5k bankroll target, salary timeline, and subscription-service concept were built on edge signal that is now known to be partly fabricated (AH parser bug) or empirically falsified at n large enough to be definitive (MO, BTTS, TEAM_TOTAL_*, OVER_UNDER_*). Until clean post-fix data demonstrates real edge on at least one market, the financial model is a hypothesis, not a plan.",
  what_changed_2026_05_15:
    "AH parser bug discovery + Tier-1 coverage audit + power analysis on full bet population (live + shadow + paper). The 57 qualifying AH scopes, +55.6 pct ROI, +15.6 pct CLV that the strategic plan rested on are corrupt-input metrics. Aggregate (Path 2) analysis on clean markets at large n shows: MATCH_ODDS Wilson lo95=0.237 (model loses more than it wins, gate unreachable on current architecture) + CLV t-stat +2.15 (model identifies value Pinnacle agrees with) — a calibration anomaly. BTTS n=581 CLV t=-1.24 (no edge). TEAM_TOTAL_AWAY_05 n=197 Wilson 0.489 + CLV t=-2.57 (Wilson close but CLV strongly negative). TEAM_TOTAL_HOME_15 n=245 Wilson 0.396 + CLV t=-1.19. TEAM_TOTAL_AWAY_15 n=190 Wilson 0.298 + CLV t=-0.58. OVER_UNDER_25 n=69 CLV t=-0.72.",
  what_is_falsified:
    "On 4 of 5 measurable clean markets at definitive n, the eligibility gate correctly rejects. This isn't insufficient data — it's empirical evidence the current model has no measurable edge on these markets. Re-eligibility for these markets depends on task #49 (opponent-aware lambdas) for AH/TT-class, or task #61 (MO LR calibration) for MO. Pre-2026-05-15 ROI projections, time-to-bankroll-doubling estimates, salary timeline, subscription concept — all hypotheses contingent on those design passes delivering measurable lift.",
  what_is_still_true:
    "The infrastructure (eligibility view, adaptive Kelly, two-path gate, exclusion rules, kill switch, settlement reconciliation, risk guardrails) is sound. The unknown is whether real edge exists in the underlying model on any market once corrupted inputs are removed AND the modelling gaps (#49, #61) are addressed.",
};

const RECOMMENDATIONS = {
  capital_decision_rule:
    "Do not size capital, salary, or subscription commitments based on pre-2026-05-15 edge numbers. Re-anchor only on clean post-fix data once at least one market_type clears the eligibility gate.",
  messaging_principle:
    "External communication about edge, ROI, or returns must footnote 'subject to clean-data verification post parser fix AND model-architecture remediation' until at least one market clears the gate.",
  ah_specific:
    "AH is the only unfalsified market — its real edge (if any) is unknown until post-parser-fix shadow data accumulates. If AH clean-data fails the gate too, the financial model is falsified across every market the system currently bets.",
};

const ACTIONS_TAKEN = {
  status: "permanent_strategic_constraint",
  next_review_trigger:
    "At least one market_type clears the eligibility gate on data placed AFTER parser-fix-deploy timestamp.",
  gate_conditions_for_capital_commitment: [
    "AH aggregate path qualifies on post-parser-fix shadow data only",
    "OR task #49 design pass demonstrates measurable Wilson + CLV lift on at least one TT/AH-class market",
    "OR task #61 design pass identifies and fixes MO LR calibration anomaly with measurable Wilson lift",
  ],
  refresh_history: [
    {
      refreshed_at: new Date().toISOString(),
      reason:
        "Original insert via apply-strategic-findings-2026-05-15.ts contained pre-power-analysis baseline. This UPDATE refreshes with the post-power-analysis empirical falsification data (MO Wilson 0.237, BTTS CLV -1.24, TT_AWAY_05 CLV -2.57, etc.) and the gate_conditions_for_capital_commitment array.",
    },
  ],
};

async function main(): Promise<void> {
  const existing = await db.execute(sql`
    SELECT id FROM experiment_learning_journal
    WHERE experiment_tag = ${TAG}
    LIMIT 1
  `);
  const rows = (((existing as unknown) as { rows?: Array<{ id: string }> }).rows ?? []);
  if (rows.length === 0) {
    console.log(`FAIL   tag=${TAG} does not exist — run apply-strategic-findings-2026-05-15.sh first`);
    process.exit(1);
  }

  await db.execute(sql`
    UPDATE experiment_learning_journal
    SET
      findings        = ${JSON.stringify(FINDINGS)}::jsonb,
      recommendations = ${JSON.stringify(RECOMMENDATIONS)}::jsonb,
      actions_taken   = ${JSON.stringify(ACTIONS_TAKEN)}::jsonb
    WHERE experiment_tag = ${TAG}
  `);
  console.log(`OK     tag=${TAG} refreshed id=${rows[0]!.id}`);
  console.log(`\nFinding 4 now contains post-power-analysis empirical falsification data.`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
