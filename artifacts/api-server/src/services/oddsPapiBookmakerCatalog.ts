import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * OddsPapi bookmaker catalog (2026-05-08 maximisation bundle).
 *
 * OddsPapi returns multi-bookmaker responses keyed by slug (pinnacle,
 * betfair, smarkets, matchbook, bet365, ...). We've historically only
 * extracted Pinnacle. Every other bookmaker slug we receive is silently
 * discarded. This catalog persists what we've seen so we can:
 *
 *   1. Discover which bookmakers OddsPapi covers for our leagues.
 *   2. Identify API-integratable execution venues for future bet-spreading
 *      (Smarkets 1-2% commission, Matchbook 1-1.5%, vs Betfair 5%). When
 *      Chris exceeds Betfair-only capacity at scale, OR when Smarkets/
 *      Matchbook offer better prices on a specific selection, the
 *      bestPriceFinder + a future placement bridge route bets to the
 *      cheapest accessible venue.
 *   3. Audit market-coverage by bookmaker — different books offer
 *      different markets, and we want to know which book covers BTTS,
 *      Asian totals, FH markets, etc.
 *
 * The catalog is populated incrementally — every OddsPapi prefetch /
 * closing-line / sharp-move call seeds rows here. The weekly cron runs
 * a backfill pass on recent matches to ensure freshness.
 */

interface CatalogResult {
  evaluatedAt: string;
  bookmakersDiscovered: number;
  newRows: number;
  updatedRows: number;
}

/**
 * Record observations from a single OddsPapi response. Called from
 * existing fetch paths (prefetch, closing-line, sharp-move). Idempotent —
 * uses INSERT ... ON CONFLICT to bump last_seen_at + sample_count.
 */
export async function recordBookmakerObservations(args: {
  matchId: number;
  marketType: string;
  bookmakerSlugs: string[];
}): Promise<void> {
  if (!args.bookmakerSlugs.length) return;
  const slugs = Array.from(new Set(args.bookmakerSlugs.map((s) => s.toLowerCase().trim()))).filter(Boolean);
  if (!slugs.length) return;

  for (const slug of slugs) {
    await db.execute(sql`
      INSERT INTO oddspapi_bookmaker_catalog (slug, display_name, first_seen_at, last_seen_at, sample_count, markets_seen)
      VALUES (${slug}, ${slug.charAt(0).toUpperCase() + slug.slice(1)}, NOW(), NOW(), 1, ARRAY[${args.marketType}]::TEXT[])
      ON CONFLICT (slug) DO UPDATE
        SET last_seen_at = NOW(),
            sample_count = oddspapi_bookmaker_catalog.sample_count + 1,
            markets_seen = (
              SELECT ARRAY(SELECT DISTINCT unnest(oddspapi_bookmaker_catalog.markets_seen || ARRAY[${args.marketType}]::TEXT[]))
            )
    `);
  }
}

/**
 * Manual trigger / cron entry-point. Returns headline numbers + the
 * list of API-integratable bookmakers actually seen in our data.
 */
export async function summariseBookmakerCatalog(): Promise<{
  totalBookmakers: number;
  apiIntegratableSeen: Array<{
    slug: string;
    display_name: string;
    sample_count: number;
    commission_rate: number | null;
    last_seen_at: string;
    api_doc_url: string | null;
  }>;
  topBookmakersBySamples: Array<{ slug: string; sample_count: number; markets: number }>;
  freshness: { totalSeenLast24h: number; apiIntegratableSeenLast24h: number };
}> {
  const total = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM oddspapi_bookmaker_catalog
  `)) as unknown as { rows: Array<{ n: number }> };

  const apiIntegratable = (await db.execute(sql`
    SELECT slug, display_name, sample_count, commission_rate, last_seen_at::text AS last_seen_at, api_doc_url
    FROM oddspapi_bookmaker_catalog
    WHERE api_integratable = true
    ORDER BY sample_count DESC
  `)) as unknown as {
    rows: Array<{
      slug: string;
      display_name: string;
      sample_count: number;
      commission_rate: number | null;
      last_seen_at: string;
      api_doc_url: string | null;
    }>;
  };

  const topBookmakers = (await db.execute(sql`
    SELECT slug, sample_count, COALESCE(array_length(markets_seen, 1), 0) AS markets
    FROM oddspapi_bookmaker_catalog
    ORDER BY sample_count DESC LIMIT 15
  `)) as unknown as { rows: Array<{ slug: string; sample_count: number; markets: number }> };

  const freshness = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '24 hours')::int AS total_24h,
      COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '24 hours' AND api_integratable = true)::int AS apii_24h
    FROM oddspapi_bookmaker_catalog
  `)) as unknown as { rows: Array<{ total_24h: number; apii_24h: number }> };

  return {
    totalBookmakers: total.rows[0]?.n ?? 0,
    apiIntegratableSeen: apiIntegratable.rows,
    topBookmakersBySamples: topBookmakers.rows,
    freshness: {
      totalSeenLast24h: freshness.rows[0]?.total_24h ?? 0,
      apiIntegratableSeenLast24h: freshness.rows[0]?.apii_24h ?? 0,
    },
  };
}

/**
 * Quick health log entry — surfaces which API-integratable venues
 * actually appeared in our data window vs are seeded but unseen.
 */
export async function logCatalogHealth(): Promise<void> {
  const summary = await summariseBookmakerCatalog();
  logger.info(
    {
      totalBookmakers: summary.totalBookmakers,
      apiIntegratable: summary.apiIntegratableSeen.map((r) => ({
        slug: r.slug, samples: r.sample_count, commission: r.commission_rate, lastSeen: r.last_seen_at,
      })),
      top10: summary.topBookmakersBySamples.slice(0, 10),
    },
    "OddsPapi bookmaker catalog summary",
  );
}
