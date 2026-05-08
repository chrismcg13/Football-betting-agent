/**
 * Phase 3 B2 (2026-05-08): bankroll-tiered capital protection caps with
 * upward-only hysteresis. Daily 03:00 UTC cron computes the natural tier
 * for current bankroll and writes the recommended caps to a `pending_caps`
 * table. Pre-flip the recommendation is INSPECTED ONLY — the live
 * agent_config caps stay at their relaxed paper-mode values (99% / 0).
 * The switchover transaction reads pending_caps and applies them at flip.
 *
 * Tier table (per docs/phase-3-paper-to-live-switchover-plan-v2.md §1.2):
 *   < £1,000        : tier_1_growth      daily 25%, weekly 40%, floor £150 abs
 *   £1,000-£5,000   : tier_2_established daily 15%, weekly 30%, floor 10% br
 *   £5,000-£25,000  : tier_3_strict      daily 10%, weekly 20%, floor 5%  br
 *   ≥ £25,000       : tier_4_premium     daily 7%,  weekly 15%, floor 5%  br
 *
 * Hysteresis:
 *   - Downward (bankroll dropped → looser tier): apply IMMEDIATELY.
 *   - Upward (bankroll grew → tighter tier): require 7 consecutive days
 *     above the threshold before applying. Tracked via
 *     agent_config.tier_upgrade_pending_since.
 *
 * Floor below £1k is absolute (£150) because % of small bankroll is
 * meaningless (5% of £500 = £25 ≈ a single stake).
 */

import { db, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface TierDef {
  tier: string;
  maxBankroll: number; // exclusive upper bound; Infinity for top tier
  daily: number;
  weekly: number;
  floorPct: number | null; // null when floor is absolute
  floorAbs: number | null; // absolute floor (only set for tier_1)
}

const TIER_TABLE: TierDef[] = [
  { tier: "tier_1_growth",      maxBankroll: 1000,    daily: 0.25, weekly: 0.40, floorPct: null, floorAbs: 150 },
  { tier: "tier_2_established", maxBankroll: 5000,    daily: 0.15, weekly: 0.30, floorPct: 0.10, floorAbs: null },
  { tier: "tier_3_strict",      maxBankroll: 25000,   daily: 0.10, weekly: 0.20, floorPct: 0.05, floorAbs: null },
  { tier: "tier_4_premium",     maxBankroll: Infinity, daily: 0.07, weekly: 0.15, floorPct: 0.05, floorAbs: null },
];

const HYSTERESIS_DAYS = 7;
const TIER_RANK: Record<string, number> = {
  tier_1_growth: 1, tier_2_established: 2, tier_3_strict: 3, tier_4_premium: 4,
};

function tierForBankroll(bankroll: number): TierDef {
  for (const t of TIER_TABLE) if (bankroll < t.maxBankroll) return t;
  return TIER_TABLE[TIER_TABLE.length - 1]!;
}

function floorValue(t: TierDef, bankroll: number): number {
  if (t.floorAbs != null) return t.floorAbs;
  return Math.round(bankroll * (t.floorPct ?? 0) * 100) / 100;
}

async function getConfig(key: string): Promise<string | null> {
  const rows = await db.select({ value: agentConfigTable.value }).from(agentConfigTable).where(eq(agentConfigTable.key, key));
  return rows[0]?.value ?? null;
}

async function setConfig(key: string, value: string): Promise<void> {
  const existing = await db.select().from(agentConfigTable).where(eq(agentConfigTable.key, key));
  if (existing.length === 0) {
    await db.insert(agentConfigTable).values({ key, value });
  } else {
    await db.update(agentConfigTable).set({ value, updatedAt: new Date() }).where(eq(agentConfigTable.key, key));
  }
}

export interface BankrollTierResult {
  evaluatedAt: string;
  bankroll: number;
  naturalTier: string;
  currentAppliedTier: string | null;
  decision: "no_change" | "downgrade_applied" | "upgrade_pending" | "upgrade_applied";
  pendingSince: string | null;
  caps: { daily: number; weekly: number; floor: number };
}

export async function runBankrollTierCaps(): Promise<BankrollTierResult> {
  const bankrollStr = await getConfig("bankroll");
  const bankroll = bankrollStr != null ? Number(bankrollStr) : 0;
  const natural = tierForBankroll(bankroll);
  const naturalRank = TIER_RANK[natural.tier]!;

  const currentTierStr = await getConfig("current_bankroll_tier");
  const currentRank = currentTierStr != null ? (TIER_RANK[currentTierStr] ?? null) : null;

  let decision: BankrollTierResult["decision"];
  let pendingSinceStr: string | null = await getConfig("tier_upgrade_pending_since");

  if (currentRank == null) {
    // First run — establish current tier without hysteresis.
    decision = "no_change";
    await setConfig("current_bankroll_tier", natural.tier);
  } else if (naturalRank < currentRank) {
    // Loosening (lower rank = looser). Apply immediately.
    decision = "downgrade_applied";
    await setConfig("current_bankroll_tier", natural.tier);
    if (pendingSinceStr != null) {
      await setConfig("tier_upgrade_pending_since", "");
      pendingSinceStr = null;
    }
  } else if (naturalRank > currentRank) {
    // Tightening — apply hysteresis.
    if (!pendingSinceStr) {
      pendingSinceStr = new Date().toISOString();
      await setConfig("tier_upgrade_pending_since", pendingSinceStr);
      decision = "upgrade_pending";
    } else {
      const elapsedMs = Date.now() - new Date(pendingSinceStr).getTime();
      const elapsedDays = elapsedMs / 86400000;
      if (elapsedDays >= HYSTERESIS_DAYS) {
        decision = "upgrade_applied";
        await setConfig("current_bankroll_tier", natural.tier);
        await setConfig("tier_upgrade_pending_since", "");
        pendingSinceStr = null;
      } else {
        decision = "upgrade_pending";
      }
    }
  } else {
    decision = "no_change";
    if (pendingSinceStr != null && pendingSinceStr !== "") {
      // Bankroll stabilised at current tier — clear any pending upgrade.
      await setConfig("tier_upgrade_pending_since", "");
      pendingSinceStr = null;
    }
  }

  // Determine the tier whose caps will be RECOMMENDED in pending_caps.
  // For 'no_change' / 'downgrade_applied' / 'upgrade_applied' that's
  // current_bankroll_tier (now possibly updated). For 'upgrade_pending' it
  // stays at the old tier (caps don't tighten until hysteresis clears).
  const appliedTierStr = (await getConfig("current_bankroll_tier"))!;
  const appliedTier = TIER_TABLE.find((t) => t.tier === appliedTierStr) ?? natural;
  const caps = {
    daily: appliedTier.daily,
    weekly: appliedTier.weekly,
    floor: floorValue(appliedTier, bankroll),
  };

  // Persist recommendation to pending_caps. One row per evaluation; the
  // switchover transaction reads the LATEST row. Pre-flip the live
  // agent_config caps are NOT touched.
  await db.execute(sql`
    INSERT INTO pending_caps (
      evaluated_at, bankroll, natural_tier, applied_tier,
      decision, pending_since,
      daily_loss_limit_pct, weekly_loss_limit_pct, bankroll_floor
    ) VALUES (
      NOW(), ${bankroll}, ${natural.tier}, ${appliedTierStr},
      ${decision}, ${pendingSinceStr ?? null},
      ${caps.daily}, ${caps.weekly}, ${caps.floor}
    )
  `);

  const result: BankrollTierResult = {
    evaluatedAt: new Date().toISOString(),
    bankroll,
    naturalTier: natural.tier,
    currentAppliedTier: appliedTierStr,
    decision,
    pendingSince: pendingSinceStr,
    caps,
  };
  logger.info(result, "bankroll_tier_caps evaluated");
  return result;
}

/**
 * Switchover-transaction helper: reads the latest pending_caps row and
 * writes its values to live agent_config keys (daily_loss_limit_pct,
 * weekly_loss_limit_pct, bankroll_floor). Called from the flip-to-live
 * code path. Idempotent — safe to call multiple times.
 */
export async function applyPendingCapsToLive(): Promise<{
  applied: { daily: number; weekly: number; floor: number };
  source: "pending_caps_latest" | "tier_default";
}> {
  const rows = await db.execute(sql`
    SELECT daily_loss_limit_pct::numeric AS daily,
           weekly_loss_limit_pct::numeric AS weekly,
           bankroll_floor::numeric AS floor,
           applied_tier
    FROM pending_caps
    ORDER BY evaluated_at DESC
    LIMIT 1
  `);
  const r = (((rows as any).rows ?? []) as Array<{
    daily: string | number;
    weekly: string | number;
    floor: string | number;
    applied_tier: string;
  }>)[0];

  let caps: { daily: number; weekly: number; floor: number };
  let source: "pending_caps_latest" | "tier_default";
  if (r) {
    caps = { daily: Number(r.daily), weekly: Number(r.weekly), floor: Number(r.floor) };
    source = "pending_caps_latest";
  } else {
    // Fallback: compute from current bankroll directly. Used if the cron
    // hasn't run yet at flip time.
    const bankrollStr = await getConfig("bankroll");
    const bankroll = bankrollStr != null ? Number(bankrollStr) : 0;
    const t = tierForBankroll(bankroll);
    caps = { daily: t.daily, weekly: t.weekly, floor: floorValue(t, bankroll) };
    source = "tier_default";
  }
  await setConfig("daily_loss_limit_pct", String(caps.daily));
  await setConfig("weekly_loss_limit_pct", String(caps.weekly));
  await setConfig("bankroll_floor", String(caps.floor));
  return { applied: caps, source };
}
