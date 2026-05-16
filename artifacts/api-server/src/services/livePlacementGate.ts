import { db, complianceLogsTable } from "@workspace/db";
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
let cachedDisabledMarkets: { set: Set<string>; fetchedAt: number } | null = null;
// Bundle 1L FIX 1 + FIX 2 (2026-05-16): per-league demote + 24h window cap.
let cachedDisabledLeagues: { set: Set<string>; fetchedAt: number } | null = null;
let cachedMaxHoursToKickoff: { value: number; fetchedAt: number } | null = null;
// Bundle 1L FIX 1b (2026-05-16, Pinnacle-aware timing): MINIMUM hours to
// kickoff. Pinnacle's closing-line surge concentrates in the final 30-60
// minutes; Betfair Exchange liquidity dries up over the same window.
// Bets placed inside this window face (a) tighter Pinnacle = our edge
// shrinks, (b) thin Betfair book = price moves against us between
// placement decision and matched fill. Default floor 1.0h.
let cachedMinHoursToKickoff: { value: number; fetchedAt: number } | null = null;
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

// 2026-05-15 — per-market-type live-placement kill switch. CSV in
// agent_config.live_placement_disabled_market_types. Used to halt live
// flow on specific markets (e.g. when a data-layer bug fabricates edge
// signal for that market). Re-uses the same 30s cache + invalidation
// pattern as isLivePlacementEnabled. Operator flips via
// /api/admin/set-config; the next placement attempt within 30s respects
// the new value.
async function getDisabledMarkets(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedDisabledMarkets && now - cachedDisabledMarkets.fetchedAt < FLAG_CACHE_TTL_MS) {
    return cachedDisabledMarkets.set;
  }
  const rows = (await db.execute(sql`
    SELECT value FROM agent_config WHERE key = 'live_placement_disabled_market_types' LIMIT 1
  `)) as unknown as { rows: Array<{ value: string }> };
  const raw = rows.rows[0]?.value ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  cachedDisabledMarkets = { set, fetchedAt: now };
  return set;
}

// Bundle 1L FIX 2 (2026-05-16): per-league live-placement demote list.
// CSV in agent_config.live_placement_disabled_leagues. League names are
// lowercase-trimmed on read; operator stores in CSV at any case. Used to
// shadow-only specific scopes whose live ROI Wilson lo95 came back
// confirmed-negative in the shadow→live divergence audit.
async function getDisabledLeagues(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedDisabledLeagues && now - cachedDisabledLeagues.fetchedAt < FLAG_CACHE_TTL_MS) {
    return cachedDisabledLeagues.set;
  }
  const rows = (await db.execute(sql`
    SELECT value FROM agent_config WHERE key = 'live_placement_disabled_leagues' LIMIT 1
  `)) as unknown as { rows: Array<{ value: string }> };
  const raw = rows.rows[0]?.value ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  cachedDisabledLeagues = { set, fetchedAt: now };
  return set;
}

// Bundle 1L FIX 1 (2026-05-16): live-placement window cap. The Bundle 1L
// timing-bucket audit showed bets placed within 24h of kickoff realise
// +41% ROI; bets placed 24-48h out realise -8%; 48h+ progressively worse
// (-19% to -24%). Default 24h cap; operator-overridable via
// agent_config.live_placement_max_hours_to_kickoff.
async function getMaxHoursToKickoff(): Promise<number> {
  const now = Date.now();
  if (cachedMaxHoursToKickoff && now - cachedMaxHoursToKickoff.fetchedAt < FLAG_CACHE_TTL_MS) {
    return cachedMaxHoursToKickoff.value;
  }
  const rows = (await db.execute(sql`
    SELECT value FROM agent_config WHERE key = 'live_placement_max_hours_to_kickoff' LIMIT 1
  `)) as unknown as { rows: Array<{ value: string }> };
  const parsed = Number(rows.rows[0]?.value ?? "24");
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  cachedMaxHoursToKickoff = { value, fetchedAt: now };
  return value;
}

// Bundle 1L FIX 1b (2026-05-16): minimum hours to kickoff. Default 1.0h
// avoids Pinnacle's closing-line surge + Betfair Exchange liquidity dry-up
// in the final hour. Theory-grounded (placing inside the surge faces
// Pinnacle at its most informationally efficient, which compresses our
// edge AND increases the risk of price moving between our placement
// decision and the matched fill). Operator-overridable via
// agent_config.live_placement_min_hours_to_kickoff.
async function getMinHoursToKickoff(): Promise<number> {
  const now = Date.now();
  if (cachedMinHoursToKickoff && now - cachedMinHoursToKickoff.fetchedAt < FLAG_CACHE_TTL_MS) {
    return cachedMinHoursToKickoff.value;
  }
  const rows = (await db.execute(sql`
    SELECT value FROM agent_config WHERE key = 'live_placement_min_hours_to_kickoff' LIMIT 1
  `)) as unknown as { rows: Array<{ value: string }> };
  const parsed = Number(rows.rows[0]?.value ?? "1");
  const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
  cachedMinHoursToKickoff = { value, fetchedAt: now };
  return value;
}

export function invalidateLivePlacementFlagCache(): void {
  cachedFlag = null;
  cachedDisabledMarkets = null;
  cachedDisabledLeagues = null;
  cachedMaxHoursToKickoff = null;
  cachedMinHoursToKickoff = null;
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
  // Bundle 1L FIX 1 (2026-05-16): caller passes match kickoffTime so the
  // 24h cap can fire. If null/undefined the cap is bypassed (fail-safe to
  // proceed with other gates) and a warning is logged — caller should
  // always pass it now that the SELECT includes kickoffTime.
  kickoffTime?: Date | null;
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

  // Per-market-type kill switch — see getDisabledMarkets() above.
  const disabled = await getDisabledMarkets();
  if (disabled.has(args.marketType.toUpperCase())) {
    if (args.betId) {
      logger.info(
        { betId: args.betId, marketType: args.marketType, league: args.league },
        "Live placement gate: market_type in live_placement_disabled_market_types — shadow rail",
      );
    }
    return {
      allowed: false,
      reason: `market_type ${args.marketType} in live_placement_disabled_market_types`,
      path: null,
      kellyFractionOverride: null,
    };
  }

  // Bundle 1L FIX 2 (2026-05-16): per-league demote list. CSV in
  // agent_config.live_placement_disabled_leagues. Belt-and-braces alongside
  // FIX 1 (most demoted-league bets are 24h+ out and would be filtered by
  // FIX 1 anyway, but the explicit list catches a <24h bet on these scopes).
  const disabledLeagues = await getDisabledLeagues();
  if (args.league && disabledLeagues.has(args.league.toLowerCase())) {
    if (args.betId) {
      logger.info(
        { betId: args.betId, marketType: args.marketType, league: args.league },
        "Live placement gate: league in live_placement_disabled_leagues — shadow rail",
      );
      void db.insert(complianceLogsTable).values({
        actionType: "live_placement_skip",
        details: {
          reason: "league_disabled",
          betId: args.betId,
          marketType: args.marketType,
          league: args.league,
        },
      });
    }
    return {
      allowed: false,
      reason: `league ${args.league} in live_placement_disabled_leagues`,
      path: null,
      kellyFractionOverride: null,
    };
  }

  // Bundle 1L FIX 1 (2026-05-16): 24h pre-kickoff cap. Timing-bucket audit
  // showed the cliff: <24h ROI +41% (n=54); 24-48h ROI -8% (n=116); 48-72h
  // -23% (n=61); >120h -24% (n=40). Cap at 24h shadow-routes the bets
  // beyond the cliff — they continue to flow into shadow track for
  // learning, just don't get real money.
  if (args.kickoffTime) {
    const maxHours = await getMaxHoursToKickoff();
    const minHours = await getMinHoursToKickoff();
    const hoursToKickoff = (args.kickoffTime.getTime() - Date.now()) / (1000 * 60 * 60);

    // Bundle 1L FIX 1b (2026-05-16): Pinnacle-aware lower bound. Default
    // 1.0h — placement inside the closing-line surge faces Pinnacle at its
    // most informationally efficient AND thin Betfair Exchange book.
    if (hoursToKickoff < minHours) {
      if (args.betId) {
        logger.info(
          {
            betId: args.betId,
            marketType: args.marketType,
            league: args.league,
            hoursToKickoff: Math.round(hoursToKickoff * 100) / 100,
            minHours,
          },
          "Live placement gate: inside_min_window — shadow rail (Pinnacle surge avoidance)",
        );
        void db.insert(complianceLogsTable).values({
          actionType: "live_placement_skip",
          details: {
            reason: "inside_min_window",
            betId: args.betId,
            marketType: args.marketType,
            league: args.league,
            hoursToKickoff: Math.round(hoursToKickoff * 100) / 100,
            minHours,
          },
        });
      }
      return {
        allowed: false,
        reason: `inside live placement min window (${Math.round(hoursToKickoff * 100) / 100}h to kickoff < ${minHours}h min)`,
        path: null,
        kellyFractionOverride: null,
      };
    }

    if (hoursToKickoff > maxHours) {
      if (args.betId) {
        logger.info(
          {
            betId: args.betId,
            marketType: args.marketType,
            league: args.league,
            hoursToKickoff: Math.round(hoursToKickoff * 10) / 10,
            maxHours,
          },
          "Live placement gate: outside_24h_window — shadow rail",
        );
        void db.insert(complianceLogsTable).values({
          actionType: "live_placement_skip",
          details: {
            reason: "outside_24h_window",
            betId: args.betId,
            marketType: args.marketType,
            league: args.league,
            hoursToKickoff: Math.round(hoursToKickoff * 10) / 10,
            maxHours,
          },
        });
      }
      return {
        allowed: false,
        reason: `outside live placement window (${Math.round(hoursToKickoff * 10) / 10}h to kickoff > ${maxHours}h max)`,
        path: null,
        kellyFractionOverride: null,
      };
    }
  } else if (args.betId) {
    logger.warn(
      { betId: args.betId, marketType: args.marketType, league: args.league },
      "Live placement gate: kickoffTime missing — 24h window cap bypassed (caller should pass kickoffTime)",
    );
  }

  return {
    allowed: true,
    reason: "kill switch on (whitelist deprecated post-cutover)",
    path: null,
    kellyFractionOverride: null,
  };
}
