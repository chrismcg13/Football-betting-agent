/**
 * Sub-phase 4.B (2026-05-08): Betfair Exchange market-type discovery.
 *
 * Daily cron that samples upcoming Tier A/B/C events, queries Betfair
 * listMarketCatalogue with NO marketTypeCodes filter, and logs every
 * unique marketType code returned. The output is the canonical truth
 * about which markets Betfair Exchange offers per fixture/league —
 * supersedes guesses from public docs.
 *
 * Used to:
 *   1. Verify the codes added to MARKET_TYPE_MAP in betfairLive.ts
 *   2. Discover NEW market codes we haven't yet mapped (Betfair adds
 *      new markets occasionally — e.g. 2026 player-props update)
 *   3. Per-fixture frequency telling us which markets are worth
 *      enabling for which league archetypes
 *
 * Writes:
 *   - compliance_logs (action='betfair_market_discovery'): summary per run
 *   - model_decision_audit_log: when a NEW market code is observed,
 *     proposes adding it to MARKET_TYPE_MAP for review
 *
 * No new tables. No new API budget impact (uses existing 5-min catalogue
 * cache where possible; ~50 events × 1 listMarketCatalogue per run = 50
 * API calls/day max).
 */

import { db, matchesTable, complianceLogsTable, modelDecisionAuditLogTable, competitionConfigTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { MARKET_TYPE_MAP, listMarketsByEventId } from "./betfairLive";

const SAMPLE_SIZE = 50;

export interface MarketDiscoveryResult {
  runId: string;
  eventsScanned: number;
  marketTypesObserved: Record<string, number>; // betfair code → count
  unmapped: string[];                          // codes not in MARKET_TYPE_MAP values
  newCodesProposed: number;
  durationMs: number;
}

export async function runBetfairMarketDiscovery(): Promise<MarketDiscoveryResult> {
  const startedAt = Date.now();
  const runId = `bf-market-discovery-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  // Sample: 50 upcoming Tier A/B/C events with non-null betfair_event_id.
  const sampleRows = await db
    .select({
      id: matchesTable.id,
      betfairEventId: matchesTable.betfairEventId,
      league: matchesTable.league,
      kickoffTime: matchesTable.kickoffTime,
    })
    .from(matchesTable)
    .innerJoin(
      competitionConfigTable,
      sql`LOWER(REPLACE(${competitionConfigTable.name}, '-', ' ')) = LOWER(REPLACE(${matchesTable.league}, '-', ' '))
        AND (${competitionConfigTable.country} IS NULL OR ${matchesTable.country} IS NULL
             OR LOWER(REPLACE(${competitionConfigTable.country}, '-', ' '))
              = LOWER(REPLACE(${matchesTable.country}, '-', ' ')))`,
    )
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        sql`${matchesTable.kickoffTime} BETWEEN NOW() AND NOW() + INTERVAL '72 hours'`,
        sql`${matchesTable.betfairEventId} IS NOT NULL`,
        inArray(competitionConfigTable.universeTier, ["A", "B", "C"]),
      ),
    )
    .limit(SAMPLE_SIZE);

  const eligible = sampleRows.filter((r) => r.betfairEventId);
  if (eligible.length === 0) {
    logger.info({ runId }, "Betfair market discovery — no eligible events");
    return {
      runId,
      eventsScanned: 0,
      marketTypesObserved: {},
      unmapped: [],
      newCodesProposed: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const marketTypesObserved = new Map<string, number>();
  let eventsScanned = 0;
  for (const row of eligible) {
    try {
      const catalogue = await listMarketsByEventId(row.betfairEventId!);
      eventsScanned++;
      for (const market of catalogue) {
        const code = market.description?.marketType;
        if (!code) continue;
        marketTypesObserved.set(code, (marketTypesObserved.get(code) ?? 0) + 1);
      }
    } catch (err) {
      logger.warn({ err, matchId: row.id, eventId: row.betfairEventId }, "Discovery: catalogue fetch failed");
    }
  }

  // Compare observed codes vs MARKET_TYPE_MAP values. Anything not in the
  // mapping is a candidate for addition.
  const mappedCodes = new Set(Object.values(MARKET_TYPE_MAP));
  const unmapped: string[] = [];
  let newCodesProposed = 0;

  for (const [code] of marketTypesObserved) {
    if (!mappedCodes.has(code)) {
      unmapped.push(code);
      // Propose addition via audit log
      await db.insert(modelDecisionAuditLogTable).values({
        decisionType: "betfair_unmapped_market_observed",
        subject: `betfair_marketType:${code}`,
        priorState: {} as any,
        newState: { observed_count: marketTypesObserved.get(code) ?? 0 } as any,
        reasoning: `Sub-phase 4.B discovery: Betfair Exchange catalogue returned marketType="${code}" for upcoming Tier A/B/C events but it's not in our MARKET_TYPE_MAP. Candidate for manual addition.`,
        supportingMetrics: {
          marketType_betfair: code,
          observed_in_n_events: marketTypesObserved.get(code) ?? 0,
          run_id: runId,
        } as any,
        expectedImpact: null,
        reviewStatus: "automatic",
      });
      newCodesProposed++;
    }
  }

  // Run summary into compliance_logs
  const summary: Record<string, number> = {};
  for (const [k, v] of marketTypesObserved) summary[k] = v;
  await db.insert(complianceLogsTable).values({
    actionType: "betfair_market_discovery",
    details: {
      run_id: runId,
      events_scanned: eventsScanned,
      unique_market_types: marketTypesObserved.size,
      unmapped_codes_count: unmapped.length,
      observed: summary,
    },
    timestamp: new Date(),
  });

  const result: MarketDiscoveryResult = {
    runId,
    eventsScanned,
    marketTypesObserved: summary,
    unmapped,
    newCodesProposed,
    durationMs: Date.now() - startedAt,
  };

  logger.info(result, "betfair_market_discovery_complete");
  return result;
}

// ── Bundle F2.B.I (2026-05-19): niche-league discovery ─────────────────
//
// Fixture-driven discovery for leagues OUTSIDE the Tier A/B/C sample.
// For each league with an upcoming fixture in the next 7d but NO
// has_betfair_coverage=TRUE yet, picks one fixture and runs
// listMarketsByEventId. If any markets returned, flips
// has_betfair_coverage=TRUE (sticky — coverage doesn't disappear).
// If none, increments discovery_fail_count + sets last_discovery_attempt_at.
//
// Negative-cache: skip leagues with fail_count >= 3 AND
// has_betfair_coverage = FALSE AND last_discovery_attempt_at within 30d.
// Newly-added leagues with intermittent Betfair coverage (Wed/Thu/Fri
// fail, Mon succeeds) stay on the 6h cadence because the success flips
// the boolean and removes them from the skip pool.
//
// Cost: bounded by uncovered-league-with-upcoming-fixture count. Each
// league = 1 catalogue API call. Cron runs every 6h.

const NICHE_DISCOVERY_FAIL_THRESHOLD = 3;
const NICHE_DISCOVERY_FAIL_WINDOW_DAYS = 30;

export interface NicheDiscoveryResult {
  leagues_evaluated: number;
  leagues_skipped_negative_cache: number;
  newly_covered: string[];
  failed_again: string[];
  duration_ms: number;
}

export async function runNicheLeagueDiscovery(): Promise<NicheDiscoveryResult> {
  const startedAt = Date.now();

  // 1. Candidate leagues: have an upcoming fixture in next 7d, no
  //    has_betfair_coverage=TRUE yet, not in negative-cache window.
  const candidatesQ = await db.execute(sql`
    WITH upcoming AS (
      SELECT DISTINCT m.league, m.country
      FROM matches m
      WHERE m.status = 'scheduled'
        AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '7 days'
        AND m.betfair_event_id IS NOT NULL
        AND m.betfair_event_id ~ '^[0-9]+$'
    )
    SELECT cc.id, cc.name AS league, cc.country,
           cc.has_betfair_coverage, cc.discovery_fail_count,
           cc.last_discovery_attempt_at
    FROM competition_config cc
    INNER JOIN upcoming u
      ON LOWER(REPLACE(cc.name, '-', ' ')) = LOWER(REPLACE(u.league, '-', ' '))
     AND (cc.country IS NULL OR u.country IS NULL
          OR LOWER(REPLACE(cc.country, '-', ' ')) = LOWER(REPLACE(u.country, '-', ' ')))
    WHERE cc.has_betfair_coverage = FALSE
      -- Negative cache: skip if 3+ fails in last 30d AND never succeeded
      AND NOT (
        cc.discovery_fail_count >= ${NICHE_DISCOVERY_FAIL_THRESHOLD}
        AND cc.last_discovery_attempt_at IS NOT NULL
        AND cc.last_discovery_attempt_at >= NOW() - INTERVAL '${sql.raw(String(NICHE_DISCOVERY_FAIL_WINDOW_DAYS))} days'
      )
  `);
  const candidates = (((candidatesQ as any).rows ?? []) as Array<{
    id: number; league: string; country: string | null;
    has_betfair_coverage: boolean; discovery_fail_count: number;
    last_discovery_attempt_at: string | null;
  }>);

  const newlyCovered: string[] = [];
  const failedAgain: string[] = [];
  let skippedNegativeCache = 0;

  for (const cand of candidates) {
    // Pick a single fixture for this league — cheapest catalogue call.
    const fxQ = await db.execute(sql`
      SELECT m.betfair_event_id
      FROM matches m
      WHERE LOWER(REPLACE(m.league, '-', ' ')) = LOWER(REPLACE(${cand.league}, '-', ' '))
        AND m.status = 'scheduled'
        AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '7 days'
        AND m.betfair_event_id IS NOT NULL
        AND m.betfair_event_id ~ '^[0-9]+$'
      ORDER BY m.kickoff_time ASC
      LIMIT 1
    `);
    const fxRow = ((fxQ as any).rows?.[0]) as { betfair_event_id: string } | undefined;
    if (!fxRow?.betfair_event_id) continue;

    try {
      const markets = await listMarketsByEventId(fxRow.betfair_event_id);
      if (markets && markets.length > 0) {
        // Coverage confirmed — flip boolean, reset fail count.
        await db.execute(sql`
          UPDATE competition_config
             SET has_betfair_coverage     = TRUE,
                 discovery_fail_count     = 0,
                 last_discovery_attempt_at = NOW()
           WHERE id = ${cand.id}
        `);
        newlyCovered.push(cand.league);
        logger.info({ league: cand.league, markets: markets.length }, "Niche-league discovery: Betfair coverage confirmed");
      } else {
        // No markets — increment fail count + timestamp.
        await db.execute(sql`
          UPDATE competition_config
             SET discovery_fail_count      = discovery_fail_count + 1,
                 last_discovery_attempt_at = NOW()
           WHERE id = ${cand.id}
        `);
        failedAgain.push(cand.league);
      }
    } catch (err) {
      // Network / API error — count as fail but log distinctly.
      logger.warn({ err, league: cand.league }, "Niche-league discovery: catalogue call failed");
      await db.execute(sql`
        UPDATE competition_config
           SET discovery_fail_count      = discovery_fail_count + 1,
               last_discovery_attempt_at = NOW()
         WHERE id = ${cand.id}
      `);
      failedAgain.push(cand.league);
    }
  }

  // Count how many candidates were skipped by negative cache by querying
  // the leagues we excluded above.
  const skippedQ = await db.execute(sql`
    SELECT COUNT(*)::int AS skipped
    FROM competition_config cc
    INNER JOIN (
      SELECT DISTINCT league, country FROM matches
      WHERE status = 'scheduled' AND kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '7 days'
    ) u ON LOWER(REPLACE(cc.name, '-', ' ')) = LOWER(REPLACE(u.league, '-', ' '))
    WHERE cc.has_betfair_coverage = FALSE
      AND cc.discovery_fail_count >= ${NICHE_DISCOVERY_FAIL_THRESHOLD}
      AND cc.last_discovery_attempt_at IS NOT NULL
      AND cc.last_discovery_attempt_at >= NOW() - INTERVAL '${sql.raw(String(NICHE_DISCOVERY_FAIL_WINDOW_DAYS))} days'
  `);
  skippedNegativeCache = (((skippedQ as any).rows?.[0]) as { skipped: number } | undefined)?.skipped ?? 0;

  const result: NicheDiscoveryResult = {
    leagues_evaluated: candidates.length,
    leagues_skipped_negative_cache: skippedNegativeCache,
    newly_covered: newlyCovered,
    failed_again: failedAgain,
    duration_ms: Date.now() - startedAt,
  };
  logger.info(result, "Niche-league Betfair discovery complete");
  return result;
}
