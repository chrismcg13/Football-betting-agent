/**
 * Z1+Z3+Z5 (2026-05-07): Autonomous threshold revision.
 *
 * Per Phase 2 brief autonomy envelope: "Internal confidence thresholds
 * for value detection" + "Per-archetype threshold customisation" +
 * "Graduation criteria refinements based on retrospective analysis" —
 * all autonomous.
 *
 * Per Chris's "no manual decisions" directive: model auto-applies all
 * threshold changes (tighter AND looser) for VALUE-DETECTION thresholds.
 * Looser changes for candidate→promoted graduation gates remain user-
 * gated per the brief's hard rule on real-money entry.
 *
 * Z1 — per-scope threshold storage. Stored in agent_config with scope
 *      prefix:
 *        min_opportunity_score:per_league:premier_league = 62
 *        min_opportunity_score:per_market:OVER_UNDER_25  = 55
 *        min_opportunity_score:per_archetype:cup         = 50
 *        min_opportunity_score                           = 50  (global)
 *      Lookup precedence: per_league > per_market > per_archetype > global.
 *      Same `byScope` pattern already used by promotionEngine.ts.
 *
 * Z3 — weekly retrospective threshold revision proposer cron (Sunday
 *      10:00 UTC, after Sun 09:30 Kelly optimiser). For each scope
 *      (league × market) with n≥30 settled bets in last 30 days:
 *      computes realised log-bankroll-growth-rate proxy at the current
 *      threshold; simulates growth at proposed alternative thresholds
 *      (-10%, -5%, +5%, +10%); auto-applies the threshold yielding the
 *      best simulated Kelly-growth (with safety floors). All changes
 *      written to agent_config with scope prefix + audit-logged to
 *      model_decision_audit_log.
 *
 * Z5 — valueDetection.ts:getModelProbability per-scope threshold lookup.
 *      Implemented in valueDetection.ts (separate edit) — reads scoped
 *      thresholds via the helper exported here.
 */

import { db, agentConfigTable, modelDecisionAuditLogTable } from "@workspace/db";
import { eq, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

async function readEnabledFlag(key: string): Promise<boolean> {
  const rows = await db.select({ value: agentConfigTable.value }).from(agentConfigTable).where(eq(agentConfigTable.key, key));
  const v = rows[0]?.value;
  if (v == null) return true;
  return v.toLowerCase() !== "false";
}

// Z1: scope hierarchy + lookup ────────────────────────────────────────────────
export type ThresholdScope =
  | { type: "global" }
  | { type: "per_league"; value: string }
  | { type: "per_market"; value: string }
  | { type: "per_archetype"; value: string };

function scopeKey(base: string, scope: ThresholdScope): string {
  if (scope.type === "global") return base;
  return `${base}:${scope.type}:${scope.value.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

/**
 * Z1+Z5: scoped threshold lookup helper.
 *
 * Reads agent_config in precedence order: per_league > per_market >
 * per_archetype > global. Returns the first non-null value found, or
 * defaultValue if none present.
 *
 * Caller passes per-bet scope identifiers (league, market, archetype).
 * Used by valueDetection.ts:getModelProbability + main detection loop.
 */
export async function lookupScopedThreshold(
  base: string,
  ctx: { league?: string | null; market?: string | null; archetype?: string | null },
  defaultValue: number,
): Promise<number> {
  const candidates: ThresholdScope[] = [];
  if (ctx.league) candidates.push({ type: "per_league", value: ctx.league });
  if (ctx.market) candidates.push({ type: "per_market", value: ctx.market });
  if (ctx.archetype) candidates.push({ type: "per_archetype", value: ctx.archetype });
  candidates.push({ type: "global" });

  const keys = candidates.map((s) => scopeKey(base, s));
  // 2026-05-09 (Bundle 5): switched from raw `WHERE key = ANY(${keys})`
  // (which Drizzle interpolates as a record tuple, same anti-pattern as
  // Bundle 4's oddsPapi.ts:resolveTier2Anchor fix) to query-builder
  // inArray(). lookupScopedThreshold isn't currently called from any active
  // path but is exported, so fixing preventatively before the bug bites
  // a future caller.
  const rows = await db
    .select({ key: agentConfigTable.key, value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(inArray(agentConfigTable.key, keys));
  const lookup = new Map<string, string>();
  for (const r of rows) lookup.set(r.key, r.value);

  for (const k of keys) {
    const v = lookup.get(k);
    if (v != null) {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return defaultValue;
}

// Z3: weekly retrospective threshold revision proposer ──────────────────────

interface ScopeStats {
  scopeType: "per_league" | "per_market";
  scopeValue: string;
  thresholdKey: string;
  currentThreshold: number;
  sampleSize: number;
  realisedGrowth: number;
}

interface SimulatedRevision {
  proposedThreshold: number;
  simulatedGrowth: number;
  retainedSampleFraction: number;
}

const ZS_WINDOW_DAYS = 30;
const ZS_MIN_SAMPLE = 30;
// Candidate threshold deltas (% relative). The simulator picks the best.
const ZS_DELTA_GRID = [-0.20, -0.10, -0.05, 0, +0.05, +0.10, +0.20];

async function readGlobalDefault(key: string, fallback: number): Promise<number> {
  const rows = await db.select().from(agentConfigTable).where(eq(agentConfigTable.key, key)).limit(1);
  const v = rows[0]?.value;
  if (v == null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Compute log-bankroll-growth proxy on a sub-population: settled bets in
 * scope where opportunity_score >= filterThreshold.
 *
 * Returns {growth, n}. growth = mean(LN(1 + clipped_pnl/stake)). Higher
 * is better (positive Kelly-growth).
 */
async function simulateScope(
  scopeType: "per_league" | "per_market",
  scopeValue: string,
  filterThreshold: number,
): Promise<{ growth: number; n: number }> {
  const scopeFilter =
    scopeType === "per_league"
      ? sql`AND LOWER(REPLACE(m.league, '-', ' ')) = ${scopeValue.toLowerCase().replace(/_/g, " ")}`
      : sql`AND pb.market_type = ${scopeValue.toUpperCase()}`;
  const rows = await db.execute(sql`
    SELECT
      AVG(LN(1 + LEAST(GREATEST(pb.settlement_pnl::numeric / NULLIF(GREATEST(pb.stake::numeric, COALESCE(pb.shadow_stake::numeric, 0)), 0), -0.99), 5))) AS growth,
      COUNT(*) AS n
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status IN ('won', 'lost')
      AND pb.placed_at >= NOW() - (${ZS_WINDOW_DAYS}::int * INTERVAL '1 day')
      AND pb.legacy_regime = false
      AND pb.deleted_at IS NULL
      AND COALESCE(pb.opportunity_score, 0) >= ${filterThreshold}
      AND COALESCE(pb.stake::numeric, 0) + COALESCE(pb.shadow_stake::numeric, 0) > 0
      ${scopeFilter}
  `);
  const r = (rows as any).rows?.[0];
  return {
    growth: Number(r?.growth ?? 0),
    n: Number(r?.n ?? 0),
  };
}

export interface ThresholdRevisionResult {
  runId: string;
  scopesEvaluated: number;
  revisionsApplied: number;
  byScopeType: Record<string, number>;
  durationMs: number;
}

/**
 * Z3 — main entry. Evaluates all (league, market) scopes with sufficient
 * sample size; simulates growth at delta-grid thresholds; auto-applies
 * the best one (subject to safety floors).
 */
export async function runThresholdRevisionProposer(): Promise<ThresholdRevisionResult> {
  const startedAt = Date.now();
  const runId = `threshold-rev-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  // Phase 3 Track A kill switch (2026-05-08): Z3 suspended. Autonomous
  // threshold loosening based on the same broken Kelly-growth proxy as Z4
  // creates a feedback loop. Per plan §5.5 v1: re-enable only after metric
  // is rebuilt AND a clean evaluation window confirms behaviour.
  const z3Enabled = await readEnabledFlag("z3_enabled");
  if (!z3Enabled) {
    logger.info({ runId }, "Z3 threshold revision skipped (z3_enabled=false)");
    return {
      runId,
      scopesEvaluated: 0,
      revisionsApplied: 0,
      byScopeType: {},
      durationMs: Date.now() - startedAt,
    };
  }

  const globalScore = await readGlobalDefault("min_opportunity_score", 50);

  // Pull (league, market) scopes with sufficient settled-bet sample
  const scopeRows = await db.execute(sql`
    SELECT
      LOWER(REPLACE(m.league, '-', ' ')) AS league,
      pb.market_type,
      COUNT(*) AS n
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status IN ('won', 'lost')
      AND pb.placed_at >= NOW() - (${ZS_WINDOW_DAYS}::int * INTERVAL '1 day')
      AND pb.legacy_regime = false
      AND pb.deleted_at IS NULL
    GROUP BY 1, 2
    HAVING COUNT(*) >= ${ZS_MIN_SAMPLE}
  `);
  const scopes = (scopeRows as any).rows ?? [];

  let revisionsApplied = 0;
  const byScopeType: Record<string, number> = {};

  // Track per-league + per-market separately so each gets its own override
  for (const sType of ["per_league", "per_market"] as const) {
    const seen = new Set<string>();
    for (const s of scopes) {
      const value = sType === "per_league" ? String(s.league) : String(s.market_type);
      if (seen.has(value)) continue;
      seen.add(value);

      // Current threshold for this scope (falls back to global default)
      const currentKey = scopeKey("min_opportunity_score", { type: sType, value });
      const current = await readGlobalDefault(currentKey, globalScore);

      // Simulate growth at each delta candidate
      const sims: SimulatedRevision[] = [];
      const baseSample = await simulateScope(sType, value, current);
      if (baseSample.n < ZS_MIN_SAMPLE) continue;
      sims.push({
        proposedThreshold: current,
        simulatedGrowth: baseSample.growth,
        retainedSampleFraction: 1.0,
      });
      for (const d of ZS_DELTA_GRID) {
        if (d === 0) continue;
        const proposed = Math.max(0, Math.min(100, current * (1 + d)));
        const sim = await simulateScope(sType, value, proposed);
        if (sim.n < 10) continue; // not enough data after filter — skip
        sims.push({
          proposedThreshold: proposed,
          simulatedGrowth: sim.growth,
          retainedSampleFraction: sim.n / baseSample.n,
        });
      }

      // Pick best simulated growth that retains ≥30% of sample (safety floor)
      const eligible = sims.filter((s) => s.retainedSampleFraction >= 0.3);
      if (eligible.length === 0) continue;
      eligible.sort((a, b) => b.simulatedGrowth - a.simulatedGrowth);
      const best = eligible[0];
      if (Math.abs(best.proposedThreshold - current) < 0.5) continue; // no meaningful change

      // Auto-apply (per Chris's no-manual directive — the model is
      // autonomous over value-detection thresholds per the brief)
      const newValue = best.proposedThreshold.toFixed(2);
      await db.execute(sql`
        INSERT INTO agent_config (key, value, updated_at)
        VALUES (${currentKey}, ${newValue}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `);

      await db.insert(modelDecisionAuditLogTable).values({
        decisionType: "threshold_revision_autonomous",
        subject: `${currentKey}`,
        priorState: { value: current.toFixed(2) } as any,
        newState: { value: newValue } as any,
        reasoning: `Z3 autonomous threshold revision: scope=${sType}:${value}, base_growth=${baseSample.growth.toFixed(4)}/bet on n=${baseSample.n}, proposed=${best.proposedThreshold.toFixed(2)} → simulated_growth=${best.simulatedGrowth.toFixed(4)}/bet retaining ${(best.retainedSampleFraction * 100).toFixed(0)}% of sample. Direction=${best.proposedThreshold > current ? "tighter" : "looser"}.`,
        supportingMetrics: {
          scope_type: sType,
          scope_value: value,
          current: current.toFixed(2),
          proposed: best.proposedThreshold.toFixed(2),
          base_growth: Number(baseSample.growth.toFixed(6)),
          base_sample: baseSample.n,
          simulated_growth: Number(best.simulatedGrowth.toFixed(6)),
          retained_fraction: Number(best.retainedSampleFraction.toFixed(3)),
          direction: best.proposedThreshold > current ? "tighter" : "looser",
          runId,
        } as any,
        expectedImpact: best.simulatedGrowth - baseSample.growth,
        reviewStatus: "automatic",
      });

      revisionsApplied++;
      byScopeType[sType] = (byScopeType[sType] ?? 0) + 1;
    }
  }

  const result: ThresholdRevisionResult = {
    runId,
    scopesEvaluated: scopes.length,
    revisionsApplied,
    byScopeType,
    durationMs: Date.now() - startedAt,
  };

  logger.info(result, "autonomous_threshold_revision_complete");
  return result;
}

// ─── Z3-event-driven (2026-05-07): per-settlement scoped revision ────────────
// On every settled bet, trigger threshold revision for that bet's
// (league, market) scope. Per-scope in-memory dedupe (5-min TTL) prevents
// thrash when many bets settle in same scope. Fire-and-forget from
// paperTrading.ts:settleBets so settlement never waits.
//
// Cost analysis:
//   - 1 scoped revision = 8 SQL queries (1 base + 6 deltas + 1 audit-log
//     INSERT if revision applies)
//   - Dedupe means at most 1 evaluation per scope per 5 min
//   - Even at peak settlement volume of ~500/day, dedupe collapses to
//     ~50 unique scope evaluations / hour = trivial Neon load
//   - Stays well under the 75k/day AF budget (no AF calls at all)

const SCOPE_DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const recentEvalsByScope = new Map<string, number>(); // scopeKey → lastEvalMs

export async function triggerScopedThresholdRevision(
  league: string | null,
  market: string | null,
): Promise<{ skipped: boolean; reason?: string; applied?: boolean }> {
  if (!league || !market) return { skipped: true, reason: "missing scope" };

  const leagueKey = league.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const marketKey = market.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const scopeIdent = `${leagueKey}::${marketKey}`;

  const now = Date.now();
  const lastEval = recentEvalsByScope.get(scopeIdent);
  if (lastEval != null && now - lastEval < SCOPE_DEDUPE_TTL_MS) {
    return { skipped: true, reason: "dedupe_window" };
  }
  recentEvalsByScope.set(scopeIdent, now);

  // Garbage-collect stale dedupe entries every ~1000 evaluations
  if (recentEvalsByScope.size > 1000) {
    const cutoff = now - SCOPE_DEDUPE_TTL_MS;
    for (const [k, v] of recentEvalsByScope) {
      if (v < cutoff) recentEvalsByScope.delete(k);
    }
  }

  const globalScore = await readGlobalDefault("min_opportunity_score", 50);
  const currentKey = scopeKey("min_opportunity_score", { type: "per_league", value: leagueKey });
  const current = await readGlobalDefault(currentKey, globalScore);

  const baseSample = await simulateScope("per_league", leagueKey, current);
  if (baseSample.n < ZS_MIN_SAMPLE) {
    return { skipped: true, reason: `insufficient_sample:n=${baseSample.n}` };
  }

  const sims: SimulatedRevision[] = [
    { proposedThreshold: current, simulatedGrowth: baseSample.growth, retainedSampleFraction: 1.0 },
  ];
  for (const d of ZS_DELTA_GRID) {
    if (d === 0) continue;
    const proposed = Math.max(0, Math.min(100, current * (1 + d)));
    const sim = await simulateScope("per_league", leagueKey, proposed);
    if (sim.n < 10) continue;
    sims.push({
      proposedThreshold: proposed,
      simulatedGrowth: sim.growth,
      retainedSampleFraction: sim.n / baseSample.n,
    });
  }

  const eligible = sims.filter((s) => s.retainedSampleFraction >= 0.3);
  if (eligible.length === 0) return { skipped: true, reason: "no_eligible_proposal" };
  eligible.sort((a, b) => b.simulatedGrowth - a.simulatedGrowth);
  const best = eligible[0];
  if (Math.abs(best.proposedThreshold - current) < 0.5) return { skipped: true, reason: "no_meaningful_change" };

  const newValue = best.proposedThreshold.toFixed(2);
  await db.execute(sql`
    INSERT INTO agent_config (key, value, updated_at)
    VALUES (${currentKey}, ${newValue}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);

  await db.insert(modelDecisionAuditLogTable).values({
    decisionType: "threshold_revision_event_driven",
    subject: currentKey,
    priorState: { value: current.toFixed(2) } as any,
    newState: { value: newValue } as any,
    reasoning: `Z3 event-driven (per-settlement) threshold revision: scope=per_league:${leagueKey} (triggered by settlement in market=${marketKey}), base_growth=${baseSample.growth.toFixed(4)}/bet on n=${baseSample.n}, proposed=${best.proposedThreshold.toFixed(2)} → simulated_growth=${best.simulatedGrowth.toFixed(4)}/bet retaining ${(best.retainedSampleFraction * 100).toFixed(0)}% of sample. Direction=${best.proposedThreshold > current ? "tighter" : "looser"}.`,
    supportingMetrics: {
      scope_type: "per_league",
      scope_value: leagueKey,
      trigger_market: marketKey,
      current: current.toFixed(2),
      proposed: best.proposedThreshold.toFixed(2),
      base_growth: Number(baseSample.growth.toFixed(6)),
      base_sample: baseSample.n,
      simulated_growth: Number(best.simulatedGrowth.toFixed(6)),
      retained_fraction: Number(best.retainedSampleFraction.toFixed(3)),
      direction: best.proposedThreshold > current ? "tighter" : "looser",
      trigger: "settlement",
    } as any,
    expectedImpact: best.simulatedGrowth - baseSample.growth,
    reviewStatus: "automatic",
  });

  return { skipped: false, applied: true };
}
