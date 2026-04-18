import { db, matchesTable } from "@workspace/db";
import { and, gte, lte, isNull, or, sql, eq, like, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { listCompetitions, listEvents } from "./betfair";
import { resolveAlias, teamSimilarity } from "./oddsPapi";

interface MapStats {
  competitionsFetched: number;
  eventsFetched: number;
  fixturesScanned: number;
  fixturesMatched: number;
  fixturesUpdated: number;
  fixturesAlreadyMapped: number;
  fixturesUnmatched: number;
  durationMs: number;
}

function parseEventTeams(eventName: string): { home: string; away: string } | null {
  const sep = eventName.includes(" v ") ? " v " : eventName.includes(" vs ") ? " vs " : null;
  if (!sep) return null;
  const parts = eventName.split(sep);
  if (parts.length !== 2) return null;
  return { home: parts[0]!.trim(), away: parts[1]!.trim() };
}

interface FixtureRow {
  id: number;
  homeTeam: string;
  awayTeam: string;
  league: string | null;
  kickoffTime: Date;
  betfairEventId: string | null;
}

interface BetfairEventLite {
  id: string;
  home: string;
  away: string;
  openDate: Date;
}

function findBestFixtureMatch(
  ev: BetfairEventLite,
  fixtures: FixtureRow[],
): { fixture: FixtureRow; score: number } | null {
  let best: { fixture: FixtureRow; score: number } | null = null;
  const evTime = ev.openDate.getTime();
  for (const f of fixtures) {
    const dtHours = Math.abs(evTime - f.kickoffTime.getTime()) / 3_600_000;
    if (dtHours > 24) continue;
    const sHome = teamSimilarity(ev.home, f.homeTeam);
    const sAway = teamSimilarity(ev.away, f.awayTeam);
    if (sHome < 0.7 || sAway < 0.7) continue;
    const timePenalty = Math.max(0, 1 - dtHours / 24) * 0.05;
    const score = (sHome + sAway) / 2 + timePenalty;
    if (!best || score > best.score) best = { fixture: f, score };
  }
  return best;
}

export async function mapBetfairEventsToFixtures(
  hoursAhead = 72,
): Promise<MapStats> {
  const startedAt = Date.now();
  const stats: MapStats = {
    competitionsFetched: 0,
    eventsFetched: 0,
    fixturesScanned: 0,
    fixturesMatched: 0,
    fixturesUpdated: 0,
    fixturesAlreadyMapped: 0,
    fixturesUnmatched: 0,
    durationMs: 0,
  };

  const now = new Date();
  const horizon = new Date(now.getTime() + hoursAhead * 3_600_000);

  const fixtures = await db
    .select({
      id: matchesTable.id,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      league: matchesTable.league,
      kickoffTime: matchesTable.kickoffTime,
      betfairEventId: matchesTable.betfairEventId,
    })
    .from(matchesTable)
    .where(
      and(
        gte(matchesTable.kickoffTime, now),
        lte(matchesTable.kickoffTime, horizon),
      ),
    );

  stats.fixturesScanned = fixtures.length;
  stats.fixturesAlreadyMapped = fixtures.filter(
    (f) => f.betfairEventId && !f.betfairEventId.startsWith("af_"),
  ).length;

  if (fixtures.length === 0) {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  let competitions: Awaited<ReturnType<typeof listCompetitions>> = [];
  try {
    competitions = await listCompetitions("1");
  } catch (err) {
    logger.error({ err }, "Betfair listCompetitions failed");
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }
  stats.competitionsFetched = competitions.length;
  if (competitions.length === 0) {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  const competitionIds = competitions.map((c) => c.competition.id);
  const CHUNK = 50;
  const events: BetfairEventLite[] = [];
  for (let i = 0; i < competitionIds.length; i += CHUNK) {
    const chunk = competitionIds.slice(i, i + CHUNK);
    try {
      const batch = await listEvents(chunk, now, horizon);
      for (const e of batch) {
        if (!e.event?.openDate) continue;
        const parsed = parseEventTeams(e.event.name);
        if (!parsed) continue;
        events.push({
          id: e.event.id,
          home: parsed.home,
          away: parsed.away,
          openDate: new Date(e.event.openDate),
        });
      }
    } catch (err) {
      logger.warn({ err, chunkStart: i }, "Betfair listEvents chunk failed");
    }
  }
  stats.eventsFetched = events.length;

  const updates: Array<{ matchId: number; eventId: string; score: number }> = [];
  const usedFixtureIds = new Set<number>();

  const eventsSorted = [...events];
  for (const ev of eventsSorted) {
    const candidates = fixtures.filter((f) => !usedFixtureIds.has(f.id));
    if (candidates.length === 0) break;
    const match = findBestFixtureMatch(ev, candidates);
    if (!match) continue;
    stats.fixturesMatched++;
    const existing = match.fixture.betfairEventId;
    if (existing && !existing.startsWith("af_") && existing === ev.id) {
      usedFixtureIds.add(match.fixture.id);
      continue;
    }
    updates.push({ matchId: match.fixture.id, eventId: ev.id, score: match.score });
    usedFixtureIds.add(match.fixture.id);
  }

  if (updates.length > 0) {
    for (const u of updates) {
      try {
        await db
          .update(matchesTable)
          .set({ betfairEventId: u.eventId })
          .where(eq(matchesTable.id, u.matchId));
        stats.fixturesUpdated++;
      } catch (err) {
        logger.warn({ err, matchId: u.matchId }, "Failed to update betfair_event_id");
      }
    }
  }

  stats.fixturesUnmatched = stats.fixturesScanned - stats.fixturesMatched - stats.fixturesAlreadyMapped;
  stats.durationMs = Date.now() - startedAt;
  logger.info(stats, "Betfair event mapping complete");
  return stats;
}

export interface PaperOnlyAnalysis {
  paperOnlyTotal: number;
  fixturesScanned: number;
  fixturesWithBetfairEvent: number;
  fixturesWithoutBetfairEvent: number;
  betsRecoverableByMapping: number;
  betsStructurallyUnlisted: number;
}

export async function analysePaperOnlyCoverage(): Promise<PaperOnlyAnalysis> {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS paper_only_total,
      COUNT(DISTINCT m.id)::int AS fixtures_scanned,
      COUNT(DISTINCT m.id) FILTER (
        WHERE m.betfair_event_id IS NOT NULL AND m.betfair_event_id NOT LIKE 'af_%'
      )::int AS fixtures_with_event,
      COUNT(DISTINCT m.id) FILTER (
        WHERE m.betfair_event_id IS NULL OR m.betfair_event_id LIKE 'af_%'
      )::int AS fixtures_without_event,
      COUNT(*) FILTER (
        WHERE m.betfair_event_id IS NOT NULL AND m.betfair_event_id NOT LIKE 'af_%'
      )::int AS bets_recoverable,
      COUNT(*) FILTER (
        WHERE m.betfair_event_id IS NULL OR m.betfair_event_id LIKE 'af_%'
      )::int AS bets_structural
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status = 'pending'
      AND m.kickoff_time > now()
      AND pb.betfair_bet_id IS NULL
      AND pb.deleted_at IS NULL
  `);
  const r = (rows as any).rows?.[0] ?? (rows as any)[0] ?? {};
  return {
    paperOnlyTotal: Number(r.paper_only_total ?? 0),
    fixturesScanned: Number(r.fixtures_scanned ?? 0),
    fixturesWithBetfairEvent: Number(r.fixtures_with_event ?? 0),
    fixturesWithoutBetfairEvent: Number(r.fixtures_without_event ?? 0),
    betsRecoverableByMapping: Number(r.bets_recoverable ?? 0),
    betsStructurallyUnlisted: Number(r.bets_structural ?? 0),
  };
}

export interface MarketAvailabilityRow {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  league: string | null;
  betfairEventId: string;
  triedMarket: string;
  availableMarkets: string[];
  hasAnyMarket: boolean;
  hasAlternativeListed: boolean;
}

export interface MarketAvailabilityReport {
  fixturesChecked: number;
  fixturesWithAnyMarket: number;
  fixturesWithoutAnyMarket: number;
  fixturesWithAlternativeListed: number;
  alternativeMarketCounts: Record<string, number>;
  rows: MarketAvailabilityRow[];
}

export async function analyseMarketAvailability(
  limit = 100,
): Promise<MarketAvailabilityReport> {
  const { listMarketsByEventId, MARKET_TYPE_MAP } = await import("./betfairLive");

  const fixtures = await db.execute(sql`
    SELECT DISTINCT
      m.id AS match_id,
      m.home_team,
      m.away_team,
      m.league,
      m.betfair_event_id,
      pb.market_type AS tried_market
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status = 'pending'
      AND m.kickoff_time > now()
      AND pb.betfair_bet_id IS NULL
      AND pb.deleted_at IS NULL
      AND m.betfair_event_id IS NOT NULL
      AND m.betfair_event_id NOT LIKE 'af_%'
    LIMIT ${limit}
  `);

  const rows = ((fixtures as any).rows ?? (fixtures as any) ?? []) as Array<{
    match_id: number;
    home_team: string;
    away_team: string;
    league: string | null;
    betfair_event_id: string;
    tried_market: string;
  }>;

  const out: MarketAvailabilityRow[] = [];
  const altCounts: Record<string, number> = {};
  let withAny = 0;
  let withAlternative = 0;
  for (const r of rows) {
    let availableTypes: string[] = [];
    try {
      const markets = await listMarketsByEventId(r.betfair_event_id);
      const seen = new Set<string>();
      for (const m of markets) {
        const t = m.description?.marketType;
        if (t) seen.add(t);
      }
      availableTypes = [...seen];
    } catch (err) {
      logger.warn({ err, eventId: r.betfair_event_id }, "listMarketsByEventId failed");
    }
    const triedBf = MARKET_TYPE_MAP[r.tried_market] ?? r.tried_market;
    const hasAny = availableTypes.length > 0;
    const hasAlt = hasAny && !availableTypes.includes(triedBf);
    if (hasAny) withAny++;
    if (hasAlt) {
      withAlternative++;
      for (const t of availableTypes) altCounts[t] = (altCounts[t] ?? 0) + 1;
    }
    out.push({
      matchId: r.match_id,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      league: r.league,
      betfairEventId: r.betfair_event_id,
      triedMarket: r.tried_market,
      availableMarkets: availableTypes,
      hasAnyMarket: hasAny,
      hasAlternativeListed: hasAlt,
    });
  }

  return {
    fixturesChecked: out.length,
    fixturesWithAnyMarket: withAny,
    fixturesWithoutAnyMarket: out.length - withAny,
    fixturesWithAlternativeListed: withAlternative,
    alternativeMarketCounts: altCounts,
    rows: out,
  };
}
