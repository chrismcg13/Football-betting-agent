import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Live-placement gating — kill-switch only (post-2026-05-09 cutover).
 *
 * Path P / Path S graduation, the `switchover_whitelist` view, and the
 * `live_whitelist` table were validation-phase scaffolding. Paper has
 * been validated; the cutover rule is paper-bet eligibility = live-bet
 * eligibility. The scope-whitelist filter and the qualifiesForTier1
 * post-filter (in paperTrading.ts) are removed.
 *
 * What remains: the kill switch in agent_config.live_placement_enabled.
 * That is the operator's emergency off-button and the auto-revert hook.
 *
 * `isScopeWhitelisted` and the `live_whitelist` table stay as read-only
 * audit artefacts — no longer in the placement hot path.
 */

let cachedFlag: { value: boolean; fetchedAt: number } | null = null;
const FLAG_CACHE_TTL_MS = 30_000; // 30s — short enough to react to operator flip, long enough to amortise lookups

export async function isLivePlacementEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedFlag && now - cachedFlag.fetchedAt < FLAG_CACHE_TTL_MS) {
    return cachedFlag.value;
  }

  const rows = (await db.execute(sql`
    SELECT value FROM agent_config WHERE key = 'live_placement_enabled' LIMIT 1
  `)) as unknown as { rows: Array<{ value: string }> };
  const raw = rows.rows[0]?.value?.toLowerCase()?.trim() ?? "false";
  const value = raw === "true" || raw === "1";
  cachedFlag = { value, fetchedAt: now };
  return value;
}

export function invalidateLivePlacementFlagCache(): void {
  cachedFlag = null;
}

export interface ScopeWhitelistResult {
  whitelisted: boolean;
  path: "P" | "S" | null;
  kellyFractionOverride: number | null;
  reason: string;
}

/**
 * Look up live_whitelist for (market_type, league). League is matched
 * exactly; the flip-to-live CLI normalises both at insert time so
 * casing should already align. If multiple paths cover the same scope
 * (P preferred), P wins.
 */
export async function isScopeWhitelisted(
  marketType: string,
  league: string,
): Promise<ScopeWhitelistResult> {
  if (!league) {
    return { whitelisted: false, path: null, kellyFractionOverride: null, reason: "league missing" };
  }

  const rows = (await db.execute(sql`
    SELECT path, kelly_fraction_override::float8 AS k
    FROM live_whitelist
    WHERE active = true
      AND market_type = ${marketType}
      AND league = ${league}
    ORDER BY path ASC, snapshotted_at DESC
    LIMIT 1
  `)) as unknown as { rows: Array<{ path: "P" | "S"; k: number }> };

  const row = rows.rows[0];
  if (!row) {
    return {
      whitelisted: false,
      path: null,
      kellyFractionOverride: null,
      reason: `no active live_whitelist row for ${marketType} × ${league}`,
    };
  }
  return {
    whitelisted: true,
    path: row.path,
    kellyFractionOverride: row.k,
    reason: `whitelisted via path ${row.path} with kelly_fraction_override=${row.k}`,
  };
}

export interface LivePlacementCheck {
  allowed: boolean;
  reason: string;
  path: "P" | "S" | null;
  kellyFractionOverride: number | null;
}

/**
 * Kill-switch only (post-2026-05-09 cutover). Returns allowed=true whenever
 * agent_config.live_placement_enabled='true'. Scope whitelist and
 * qualifiesForTier1 filters are deprecated — paper-eligibility = live-
 * eligibility.
 *
 * `path` and `kellyFractionOverride` are always null — preserved in the
 * return shape for caller-API compatibility. The caller in paperTrading.ts
 * asserts override === null and throws on any non-null value (fail-loud
 * guard against future re-introduction of override behaviour).
 */
export async function checkLivePlacementGates(args: {
  marketType: string;
  league: string;
  betId?: number;
}): Promise<LivePlacementCheck> {
  const enabled = await isLivePlacementEnabled();
  if (!enabled) {
    if (args.betId) {
      logger.info(
        { betId: args.betId, marketType: args.marketType, league: args.league },
        "Live placement gate: kill switch off (live_placement_enabled=false) — shadow rail",
      );
    }
    return {
      allowed: false,
      reason: "live_placement_enabled=false (operator kill switch)",
      path: null,
      kellyFractionOverride: null,
    };
  }

  return {
    allowed: true,
    reason: "kill switch on (whitelist deprecated post-cutover)",
    path: null,
    kellyFractionOverride: null,
  };
}
