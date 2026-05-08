import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Best-price finder (2026-05-08 maximisation bundle).
 *
 * Read-only helper: given a (matchId, marketType, selectionName), returns
 * the best-priced bookmaker we have a recent quote for, restricted to
 * bookmakers that are EITHER api_integratable (we can place via their
 * public API) OR explicitly opted-in via the override list.
 *
 * Used in two future flows (not wired yet — landing as scaffolding):
 *   1. Pre-placement EV optimisation. When the model decides to bet, the
 *      orderManager / placement bridge calls findBestPrice() and routes
 *      to whichever venue offers the highest odds. Empirically this is
 *      worth 0.5-1.5% EV per bet vs a single-venue strategy.
 *   2. Bet-spreading at scale. As volume grows past Betfair-only capacity,
 *      we route segments to Smarkets (1-2% commission) and Matchbook
 *      (1-1.5%) instead of Betfair (5%) — improves net yield by 3-4
 *      percentage points on the spread portion.
 *
 * Constraints:
 *   - Does NOT account for liquidity — caller should still validate
 *     market depth via Betfair Exchange / Smarkets order books before
 *     placing.
 *   - Does NOT account for stake limits per bookmaker.
 *   - Falls back to Pinnacle reference if no integratable book has a
 *     recent quote — caller decides whether to abort or use Pinnacle
 *     reference for paper-only.
 */

const RECENT_WINDOW_MIN = 30;

export interface BestPriceResult {
  found: boolean;
  bookmakerSlug: string | null;
  apiIntegratable: boolean;
  odds: number | null;
  source: string | null;
  snapshotAt: string | null;
  // For comparison / diagnostics:
  pinnacleReference: number | null;
  pinnacleSource: string | null;
  candidates: Array<{
    bookmakerSlug: string;
    odds: number;
    source: string;
    snapshotAt: string;
    apiIntegratable: boolean;
  }>;
  reason: string;
}

/**
 * Find the best price for a given selection across all OddsPapi-recorded
 * bookmakers. By default restricts to api_integratable=true; pass
 * `restrictToIntegratable: false` to consider every captured bookmaker
 * (useful for diagnostic / shadow-mode comparisons).
 */
export async function findBestPrice(args: {
  matchId: number;
  marketType: string;
  selectionName: string;
  restrictToIntegratable?: boolean;
}): Promise<BestPriceResult> {
  const restrict = args.restrictToIntegratable ?? true;

  // Only OddsPapi records multi-bookmaker rows in odds_snapshots in the
  // shape we need (one row per bookmaker per snapshot). AF is too AF-
  // specific in source naming; we'd need separate handling. Keep this
  // OddsPapi-first.
  const rows = (await db.execute(sql`
    SELECT
      os.source,
      LOWER(REPLACE(os.source, 'oddspapi_', '')) AS slug,
      os.back_odds::float8 AS odds,
      os.snapshot_time::text AS snapshot_at,
      COALESCE(c.api_integratable, false) AS api_integratable
    FROM odds_snapshots os
    LEFT JOIN oddspapi_bookmaker_catalog c
           ON c.slug = LOWER(REPLACE(os.source, 'oddspapi_', ''))
    WHERE os.match_id = ${args.matchId}
      AND os.market_type = ${args.marketType}
      AND os.selection_name = ${args.selectionName}
      AND os.source LIKE 'oddspapi_%'
      AND os.snapshot_time > NOW() - INTERVAL '${sql.raw(String(RECENT_WINDOW_MIN))} minutes'
    ORDER BY os.back_odds DESC
  `)) as unknown as {
    rows: Array<{
      source: string;
      slug: string;
      odds: number;
      snapshot_at: string;
      api_integratable: boolean;
    }>;
  };

  const candidates = rows.rows
    .filter((r) => r.odds && r.odds > 1)
    .map((r) => ({
      bookmakerSlug: r.slug,
      odds: r.odds,
      source: r.source,
      snapshotAt: r.snapshot_at,
      apiIntegratable: r.api_integratable,
    }));

  // Pinnacle reference (for diagnostic / fallback)
  const pinRow = (await db.execute(sql`
    SELECT source, back_odds::float8 AS odds
    FROM odds_snapshots
    WHERE match_id = ${args.matchId}
      AND market_type = ${args.marketType}
      AND selection_name = ${args.selectionName}
      AND source IN ('oddspapi_pinnacle','api_football_real:Pinnacle')
      AND snapshot_time > NOW() - INTERVAL '${sql.raw(String(RECENT_WINDOW_MIN))} minutes'
    ORDER BY snapshot_time DESC LIMIT 1
  `)) as unknown as { rows: Array<{ source: string; odds: number | null }> };
  const pinnacleReference = pinRow.rows[0]?.odds ?? null;
  const pinnacleSource = pinRow.rows[0]?.source ?? null;

  const eligible = restrict ? candidates.filter((c) => c.apiIntegratable) : candidates;
  if (!eligible.length) {
    return {
      found: false,
      bookmakerSlug: null,
      apiIntegratable: false,
      odds: null,
      source: null,
      snapshotAt: null,
      pinnacleReference,
      pinnacleSource,
      candidates,
      reason: restrict
        ? `No api_integratable bookmaker has a recent (${RECENT_WINDOW_MIN}min) quote for this selection. Candidates seen: ${candidates.map((c) => c.bookmakerSlug).join(", ") || "(none)"}`
        : `No bookmaker has a recent (${RECENT_WINDOW_MIN}min) quote for this selection.`,
    };
  }

  const best = eligible[0]!; // ORDER BY back_odds DESC

  return {
    found: true,
    bookmakerSlug: best.bookmakerSlug,
    apiIntegratable: best.apiIntegratable,
    odds: best.odds,
    source: best.source,
    snapshotAt: best.snapshotAt,
    pinnacleReference,
    pinnacleSource,
    candidates,
    reason: `Best of ${eligible.length} integratable books — ${best.bookmakerSlug} @ ${best.odds.toFixed(3)}`
      + (pinnacleReference ? ` (Pinnacle ref ${pinnacleReference.toFixed(3)}, edge ${(((best.odds - pinnacleReference) / pinnacleReference) * 100).toFixed(2)}%)` : ""),
  };
}
