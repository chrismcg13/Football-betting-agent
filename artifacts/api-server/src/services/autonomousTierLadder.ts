/**
 * Z4 (2026-05-07): Autonomous bidirectional universe_tier ladder.
 *
 * Daily 03:45 UTC cron. For each (league, archetype) scope, computes
 * realised Kelly-growth-rate on shadow + production data over rolling
 * window and autonomously promotes/demotes the league between
 * universe_tier values.
 *
 * Per Phase 2 brief autonomy envelope:
 * - "Demotion of underperforming leagues from any tier" → autonomous
 * - "Promotion of experiment-graduated leagues to candidate tier" → autonomous
 *
 * The model continuously rebalances the universe based on what's actually
 * driving Kelly-growth-ROI. Tier A entry remains via the existing
 * experiment→candidate→promoted graduation gates (which fire automatically
 * on threshold cross). Tier A exit (demotion to B) is autonomous here.
 *
 * Transition matrix (driven by realised log-bankroll growth-rate proxy):
 *
 *   A → B    if growth ≤ -0.005/bet over n≥30 bets in last 30d
 *   B → C    if growth ≤ -0.005/bet over n≥30
 *   C → D    if growth ≤ -0.005/bet over n≥30
 *   D → E    if growth ≤ -0.010/bet over n≥50  (deeper threshold for total exclusion)
 *
 *   E → C    if growth >  +0.005/bet over n≥50 (re-activate)
 *   D → C    if growth >  +0.005/bet over n≥30
 *   C → B    if growth >  +0.005/bet over n≥75 (sustained shadow signal)
 *   B → (graduation gate) — the existing experiment→candidate path handles
 *                            promotion to Tier A real-money rail. This
 *                            module never directly writes Tier A.
 *
 * All transitions write to model_decision_audit_log with full reasoning
 * + supporting metrics. User reviews weekly per "autonomy with audit"
 * pattern.
 */

import { db, competitionConfigTable, paperBetsTable, matchesTable, modelDecisionAuditLogTable, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface ScopeMetrics {
  league: string;
  country: string | null;
  ccId: number;
  currentTier: string;
  sampleSize: number;
  kellyGrowthPerBet: number; // proxy: mean(LN(1 + pnl/stake)) per settled bet
  windowDays: number;
}

const PROMOTION_THRESHOLD = 0.005;   // +0.5% log-bankroll-growth per bet
const DEMOTION_THRESHOLD = -0.005;   // -0.5%
const DEEPER_DEMOTE = -0.010;        // -1.0% for D → E
const WINDOW_DAYS = 30;

interface TierTransition {
  ccId: number;
  league: string;
  country: string | null;
  fromTier: string;
  toTier: string;
  reason: string;
  metrics: ScopeMetrics;
}

function nextTierUp(current: string, n: number, growth: number): string | null {
  if (current === "E" && n >= 50 && growth > PROMOTION_THRESHOLD) return "C";
  if (current === "D" && n >= 30 && growth > PROMOTION_THRESHOLD) return "C";
  if (current === "C" && n >= 75 && growth > PROMOTION_THRESHOLD) return "B";
  // B → A handled by existing experiment→candidate→promoted graduation gates
  return null;
}

function nextTierDown(current: string, n: number, growth: number): string | null {
  if (current === "A" && n >= 30 && growth <= DEMOTION_THRESHOLD) return "B";
  if (current === "B" && n >= 30 && growth <= DEMOTION_THRESHOLD) return "C";
  if (current === "C" && n >= 30 && growth <= DEMOTION_THRESHOLD) return "D";
  if (current === "D" && n >= 50 && growth <= DEEPER_DEMOTE) return "E";
  return null;
}

export interface TierLadderResult {
  runId: string;
  scopesEvaluated: number;
  promotions: number;
  demotions: number;
  byTransition: Record<string, number>;
  durationMs: number;
}

export async function runAutonomousTierLadder(): Promise<TierLadderResult> {
  const startedAt = Date.now();
  const runId = `tier-ladder-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  // Phase 3 Track A kill switch (2026-05-08): Z4 suspended pending Kelly-growth
  // metric replacement. The proxy LN(1+pnl/stake) is unit-stake-of-bankroll
  // arithmetic with thresholds calibrated to true bankroll-fraction Kelly —
  // off by ~3 orders of magnitude. Caused 4 wrongful demotions on 2026-05-08
  // including 3 profitable scopes. Re-enable only after metric is rebuilt on
  // bankroll_snapshots and re-validated. See docs/phase-3-paper-to-live-
  // switchover-plan-v2.md §1.4.
  const z4Enabled = await readEnabledFlag("z4_enabled");
  if (!z4Enabled) {
    logger.info({ runId }, "Z4 autonomous tier-ladder skipped (z4_enabled=false)");
    return {
      runId,
      scopesEvaluated: 0,
      promotions: 0,
      demotions: 0,
      byTransition: {},
      durationMs: Date.now() - startedAt,
    };
  }

  // Compute per-(league, country) realised log-bankroll-growth-rate proxy
  // over last WINDOW_DAYS. Kelly-growth proper requires bankroll_snapshots
  // (F1 not yet shipped) — using LN(1 + pnl/stake) per bet as the proxy
  // until F1 lands. Same proxy used by modelSelfAudit so behaviour is
  // consistent.
  const rows = await db.execute(sql`
    SELECT
      m.league,
      m.country,
      cc.id AS cc_id,
      cc.universe_tier AS current_tier,
      COUNT(*) AS sample_size,
      AVG(LN(1 + LEAST(GREATEST(pb.settlement_pnl::numeric / NULLIF(GREATEST(pb.stake::numeric, COALESCE(pb.shadow_stake::numeric, 0)), 0), -0.99), 5))) AS growth_per_bet
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    JOIN competition_config cc ON LOWER(REPLACE(cc.name, '-', ' ')) = LOWER(REPLACE(m.league, '-', ' '))
       AND (cc.country IS NULL OR m.country IS NULL OR LOWER(REPLACE(cc.country, '-', ' ')) = LOWER(REPLACE(m.country, '-', ' ')))
    WHERE pb.status IN ('won', 'lost')
      AND pb.placed_at >= NOW() - (${WINDOW_DAYS}::int * INTERVAL '1 day')
      AND pb.legacy_regime = false
      AND pb.deleted_at IS NULL
      AND COALESCE(pb.stake::numeric, 0) + COALESCE(pb.shadow_stake::numeric, 0) > 0
      AND cc.universe_tier IS NOT NULL
    GROUP BY m.league, m.country, cc.id, cc.universe_tier
    HAVING COUNT(*) >= 10
  `);

  const scopes: ScopeMetrics[] = ((rows as any).rows ?? []).map((r: any) => ({
    league: r.league,
    country: r.country ?? null,
    ccId: Number(r.cc_id),
    currentTier: String(r.current_tier),
    sampleSize: Number(r.sample_size),
    kellyGrowthPerBet: Number(r.growth_per_bet ?? 0),
    windowDays: WINDOW_DAYS,
  }));

  const transitions: TierTransition[] = [];
  for (const scope of scopes) {
    const up = nextTierUp(scope.currentTier, scope.sampleSize, scope.kellyGrowthPerBet);
    const down = nextTierDown(scope.currentTier, scope.sampleSize, scope.kellyGrowthPerBet);
    const target = up ?? down;
    if (!target) continue;

    transitions.push({
      ccId: scope.ccId,
      league: scope.league,
      country: scope.country,
      fromTier: scope.currentTier,
      toTier: target,
      reason: up
        ? `Autonomous promotion: log-growth=${scope.kellyGrowthPerBet.toFixed(4)}/bet > ${PROMOTION_THRESHOLD} threshold over n=${scope.sampleSize} settled bets in last ${WINDOW_DAYS}d`
        : `Autonomous demotion: log-growth=${scope.kellyGrowthPerBet.toFixed(4)}/bet ≤ ${DEMOTION_THRESHOLD} threshold over n=${scope.sampleSize} settled bets in last ${WINDOW_DAYS}d`,
      metrics: scope,
    });
  }

  // Apply transitions
  let promotions = 0;
  let demotions = 0;
  const byTransition: Record<string, number> = {};

  for (const t of transitions) {
    const isPromotion = "ABCDE".indexOf(t.toTier) < "ABCDE".indexOf(t.fromTier);

    await db
      .update(competitionConfigTable)
      .set({
        universeTier: t.toTier,
        universeTierDecidedAt: new Date(),
        isActive: t.toTier === "A" || t.toTier === "B" || t.toTier === "C",
      })
      .where(eq(competitionConfigTable.id, t.ccId));

    await db.insert(modelDecisionAuditLogTable).values({
      decisionType: isPromotion ? "tier_promoted_autonomous" : "tier_demoted_autonomous",
      subject: `competition:${t.ccId}:${t.league}/${t.country ?? "unknown"}`,
      priorState: { universe_tier: t.fromTier } as any,
      newState: { universe_tier: t.toTier } as any,
      reasoning: t.reason,
      supportingMetrics: {
        sample_size: t.metrics.sampleSize,
        kelly_growth_per_bet: Number(t.metrics.kellyGrowthPerBet.toFixed(6)),
        window_days: t.metrics.windowDays,
        runId,
      } as any,
      expectedImpact: t.metrics.kellyGrowthPerBet,
      reviewStatus: "automatic",
    });

    if (isPromotion) promotions++;
    else demotions++;
    const key = `${t.fromTier}_to_${t.toTier}`;
    byTransition[key] = (byTransition[key] ?? 0) + 1;
  }

  const result: TierLadderResult = {
    runId,
    scopesEvaluated: scopes.length,
    promotions,
    demotions,
    byTransition,
    durationMs: Date.now() - startedAt,
  };

  logger.info(result, "autonomous_tier_ladder_complete");
  return result;
}

async function readEnabledFlag(key: string): Promise<boolean> {
  const rows = await db.select({ value: agentConfigTable.value }).from(agentConfigTable).where(eq(agentConfigTable.key, key));
  const v = rows[0]?.value;
  if (v == null) return true; // default-on if flag absent
  return v.toLowerCase() !== "false";
}
