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
