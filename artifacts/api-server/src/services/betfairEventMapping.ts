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
  opts?: { minSimilarity?: number; maxKickoffHours?: number },
): { fixture: FixtureRow; score: number } | null {
  const minSim = opts?.minSimilarity ?? 0.7;
  const maxHours = opts?.maxKickoffHours ?? 24;
  let best: { fixture: FixtureRow; score: number } | null = null;
  const evTime = ev.openDate.getTime();
  for (const f of fixtures) {
    const dtHours = Math.abs(evTime - f.kickoffTime.getTime()) / 3_600_000;
    if (dtHours > maxHours) continue;
    const sHome = teamSimilarity(ev.home, f.homeTeam);
    const sAway = teamSimilarity(ev.away, f.awayTeam);
    if (sHome < minSim || sAway < minSim) continue;
    // Permissive-pass safety: when minSim is below 0.7, require at least one
    // side to be ≥0.8 so we don't match two simultaneously-weak similarities.
    if (minSim < 0.7 && Math.max(sHome, sAway) < 0.8) continue;
    const timePenalty = Math.max(0, 1 - dtHours / maxHours) * 0.05;
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

  const updates: Array<{ matchId: number; eventId: string; score: number; permissive: boolean }> = [];
  const usedFixtureIds = new Set<number>();

  // Pass 1: strict (min sim 0.7, ±24h). Existing behaviour — won't regress.
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
    updates.push({ matchId: match.fixture.id, eventId: ev.id, score: match.score, permissive: false });
    usedFixtureIds.add(match.fixture.id);
  }

  // Pass 2 (2026-05-08): permissive recovery for af_-placeholder matches in
  // known-tradeable leagues. Lower min-similarity to 0.6 BUT require at
  // least one side ≥0.8 (handled inside findBestFixtureMatch), and tighten
  // kickoff window to 6h so we don't cross-day-match. Restricted to
  // fixtures whose league has has_betfair_exchange=TRUE (high-confidence
  // target — we know the league trades on Betfair, so the af_ placeholder
  // is a fuzzy-match miss, not a genuinely-unlisted event).
  // Bundle F2.B.AUDIT-FIX-4 (2026-05-19): the column was renamed to
  // has_betfair_coverage in Bundle I (2026-05-19). The old name
  // 'has_betfair_exchange' doesn't exist — query returned empty Set →
  // Pass 2 permissive recovery silently no-op'd → 502 matches at 72-168h
  // stayed AF-only with no Betfair mapping. Found by audit 2026-05-19.
  const tradeableRows = await db.execute(sql`
    SELECT name FROM competition_config
    GROUP BY name HAVING BOOL_OR(has_betfair_coverage = TRUE)
  `);
  const tradeableLeagues = new Set<string>(
    (((tradeableRows as any).rows ?? (tradeableRows as any) ?? []) as Array<{ name: string }>)
      .map((r) => r.name),
  );
  const remainingAfFixtures = fixtures.filter((f) =>
    !usedFixtureIds.has(f.id) &&
    f.betfairEventId?.startsWith("af_") &&
    f.league &&
    tradeableLeagues.has(f.league),
  );
  let permissiveMatched = 0;
  if (remainingAfFixtures.length > 0) {
    for (const ev of eventsSorted) {
      const candidates = remainingAfFixtures.filter((f) => !usedFixtureIds.has(f.id));
      if (candidates.length === 0) break;
      // 2026-05-10: loosened Pass 2 thresholds to recover more af_* fixtures.
      // Previous (sim 0.6, ±6h) matched only ~0.9% of af_* candidates against
      // the 116 events Pass 1 didn't bind. Loosened to (sim 0.45, ±18h) —
      // still requires meaningful team-name overlap, but tolerates the
      // larger kickoff drift seen between API-Football and Betfair on
      // far-horizon (day+3-7) fixtures. False-positive risk bounded by the
      // tradeable-league filter above (only fixtures in leagues with
      // has_betfair_exchange=TRUE are eligible).
      const match = findBestFixtureMatch(ev, candidates, { minSimilarity: 0.45, maxKickoffHours: 18 });
      if (!match) continue;
      const existing = match.fixture.betfairEventId;
      if (existing && !existing.startsWith("af_") && existing === ev.id) {
        usedFixtureIds.add(match.fixture.id);
        continue;
      }
      updates.push({ matchId: match.fixture.id, eventId: ev.id, score: match.score, permissive: true });
      usedFixtureIds.add(match.fixture.id);
      permissiveMatched++;
      stats.fixturesMatched++;
    }
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
  logger.info(
    { ...stats, permissiveMatched, tradeableLeagueCount: tradeableLeagues.size },
    "Betfair event mapping complete",
  );
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
