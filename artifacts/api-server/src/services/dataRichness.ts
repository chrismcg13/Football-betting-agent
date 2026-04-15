import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface RichnessResult {
  league: string;
  country: string;
  marketType: string;
  pinnacleCoveragePct: number;
  apiFootballDepth: number;
  hasStatistics: boolean;
  hasLineups: boolean;
  hasEvents: boolean;
  fixtureFrequency: number;
  overallScore: number;
  tier1Eligible: boolean;
}

export async function calculateDataRichnessForLeagueMarket(
  league: string,
  country: string,
  marketType: string,
): Promise<RichnessResult> {
  const ccRows = await db.execute(sql`
    SELECT has_pinnacle_odds, has_statistics, has_lineups, has_events, fixture_count
    FROM competition_config
    WHERE LOWER(name) = LOWER(${league}) AND LOWER(country) = LOWER(${country})
    LIMIT 1
  `);
  const cc = (ccRows as any).rows?.[0] ?? (ccRows as any)[0];

  const hasPinnacle = cc?.has_pinnacle_odds === true;
  const hasStats = cc?.has_statistics === true;
  const hasLineups = cc?.has_lineups === true;
  const hasEvents = cc?.has_events === true;
  const ccFixtureCount = Number(cc?.fixture_count ?? 0);

  const depthRows = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM matches
    WHERE LOWER(league) = LOWER(${league}) AND LOWER(country) = LOWER(${country})
  `);
  const depthRow = (depthRows as any).rows?.[0] ?? (depthRows as any)[0];
  const apiFootballDepth = Number(depthRow?.cnt ?? 0);

  const recentRows = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM matches
    WHERE LOWER(league) = LOWER(${league}) AND LOWER(country) = LOWER(${country})
      AND kickoff_time >= NOW() - INTERVAL '30 days'
  `);
  const recentRow = (recentRows as any).rows?.[0] ?? (recentRows as any)[0];
  const fixturesLast30 = Number(recentRow?.cnt ?? 0);
  const fixtureFrequency = fixturesLast30 / 4;

  const pinnacleRows = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE pb.pinnacle_odds IS NOT NULL) as with_pinnacle
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE LOWER(m.league) = LOWER(${league})
      AND LOWER(m.country) = LOWER(${country})
      AND pb.market_type = ${marketType}
      AND pb.placed_at >= NOW() - INTERVAL '30 days'
  `);
  const pinnRow = (pinnacleRows as any).rows?.[0] ?? (pinnacleRows as any)[0];
  const totalBets = Number(pinnRow?.total ?? 0);
  const withPinnacle = Number(pinnRow?.with_pinnacle ?? 0);
  const pinnCoveragePct = totalBets > 0 ? (withPinnacle / totalBets) * 100 : (hasPinnacle ? 50 : 0);

  let score = 0;
  if (hasPinnacle) score += 30;
  else score += Math.min(pinnCoveragePct * 0.3, 30);

  if (hasStats) score += 20;
  if (hasLineups) score += 10;
  if (hasEvents) score += 10;

  const depthScore = Math.min(apiFootballDepth / 50, 1) * 15;
  score += depthScore;

  const freqScore = Math.min(fixtureFrequency / 5, 1) * 15;
  score += freqScore;

  score = Math.round(score * 100) / 100;
  const tier1Eligible = score >= 70;

  return {
    league,
    country,
    marketType,
    pinnacleCoveragePct: Math.round(pinnCoveragePct * 100) / 100,
    apiFootballDepth,
    hasStatistics: hasStats,
    hasLineups,
    hasEvents,
    fixtureFrequency: Math.round(fixtureFrequency * 100) / 100,
    overallScore: score,
    tier1Eligible,
  };
}

export async function recalculateAllDataRichness(): Promise<{ calculated: number; tier1Count: number }> {
  const leagueMarkets = await db.execute(sql`
    SELECT DISTINCT m.league, m.country, pb.market_type
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.placed_at >= NOW() - INTERVAL '90 days'
  `);

  const rows = (leagueMarkets as any).rows ?? leagueMarkets;
  let calculated = 0;
  let tier1Count = 0;

  for (const row of rows) {
    try {
      const result = await calculateDataRichnessForLeagueMarket(
        row.league,
        row.country,
        row.market_type,
      );

      await db.execute(sql`
        INSERT INTO data_richness_cache (league, country, market_type, pinnacle_coverage_pct, api_football_depth, has_statistics, has_lineups, has_events, fixture_frequency, overall_score, tier1_eligible, calculated_at)
        VALUES (${result.league}, ${result.country}, ${result.marketType}, ${result.pinnacleCoveragePct}, ${result.apiFootballDepth}, ${result.hasStatistics}, ${result.hasLineups}, ${result.hasEvents}, ${result.fixtureFrequency}, ${result.overallScore}, ${result.tier1Eligible}, NOW())
        ON CONFLICT (league, country, market_type)
        DO UPDATE SET
          pinnacle_coverage_pct = EXCLUDED.pinnacle_coverage_pct,
          api_football_depth = EXCLUDED.api_football_depth,
          has_statistics = EXCLUDED.has_statistics,
          has_lineups = EXCLUDED.has_lineups,
          has_events = EXCLUDED.has_events,
          fixture_frequency = EXCLUDED.fixture_frequency,
          overall_score = EXCLUDED.overall_score,
          tier1_eligible = EXCLUDED.tier1_eligible,
          calculated_at = NOW()
      `);

      calculated++;
      if (result.tier1Eligible) tier1Count++;
    } catch (err) {
      logger.warn({ err, league: row.league, country: row.country, marketType: row.market_type }, "Data richness calc failed for league-market");
    }
  }

  logger.info({ calculated, tier1Count }, "Data richness recalculation complete");
  return { calculated, tier1Count };
}

export async function isLeagueMarketTier1Eligible(
  league: string,
  country: string,
  marketType: string,
): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT tier1_eligible FROM data_richness_cache
    WHERE LOWER(league) = LOWER(${league})
      AND LOWER(country) = LOWER(${country})
      AND market_type = ${marketType}
    LIMIT 1
  `);
  const row = (rows as any).rows?.[0] ?? (rows as any)[0];
  return row?.tier1_eligible === true;
}

export async function getDataRichnessSummary(): Promise<{
  total: number;
  tier1Eligible: number;
  avgScore: number;
  topLeagues: Array<{ league: string; country: string; score: number }>;
}> {
  const statsRows = await db.execute(sql`
    SELECT
      COUNT(DISTINCT (league, country)) as total,
      COUNT(DISTINCT (league, country)) FILTER (WHERE tier1_eligible) as tier1,
      ROUND(AVG(overall_score)::numeric, 1) as avg_score
    FROM data_richness_cache
  `);
  const stats = (statsRows as any).rows?.[0] ?? (statsRows as any)[0];

  const topRows = await db.execute(sql`
    SELECT league, country, MAX(overall_score) as score
    FROM data_richness_cache
    WHERE tier1_eligible = true
    GROUP BY league, country
    ORDER BY score DESC
    LIMIT 15
  `);
  const topLeagues = ((topRows as any).rows ?? topRows).map((r: any) => ({
    league: r.league,
    country: r.country,
    score: Number(r.score),
  }));

  return {
    total: Number(stats?.total ?? 0),
    tier1Eligible: Number(stats?.tier1 ?? 0),
    avgScore: Number(stats?.avg_score ?? 0),
    topLeagues,
  };
}
