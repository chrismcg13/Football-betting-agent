/**
 * Phase 1a (2026-05-14) — Dixon-Coles / Sarmanov correlation lookup
 * with 60s in-memory cache.
 *
 * scoreline_correlation holds the per-(api_football_id, market_type) ρ
 * estimate (posterior mean from the hierarchical-Bayes fit landing in
 * Phase 1b).  model_layer_enabled is the per-(market_type, gender, layer)
 * on/off decision the Phase 1c backtest writes.
 *
 * Both tables are empty on landing → the runtime falls back to ρ=0 and
 * enabled=false, so predictAsianHandicap behaves identically to the
 * pre-Phase-1 independent-Poisson baseline. As the tables get populated
 * the runtime starts applying the correction automatically per
 * (market_type, gender) cell.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface DcMatchContext {
  rho: number;
  copulaKind: "dixon_coles" | "sarmanov";
  gender: "male" | "female";
  // Per-(market_type, gender, layer) on/off. Default false (safe) until
  // the Phase 1c backtest writes a row.
  enabledByMarketType: Map<string, boolean>;
}

const CACHE_TTL_MS = 60_000;
interface CacheEntry { ctx: DcMatchContext; expiresAt: number; }
const matchCtxCache = new Map<number, CacheEntry>();

const layerEnabledCache = {
  data: null as Map<string, boolean> | null,
  expiresAt: 0,
};

async function loadLayerEnabledMap(): Promise<Map<string, boolean>> {
  const now = Date.now();
  if (layerEnabledCache.data && now < layerEnabledCache.expiresAt) {
    return layerEnabledCache.data;
  }
  const map = new Map<string, boolean>();
  try {
    const rows = (await db.execute(sql`
      SELECT market_type, gender, layer, enabled
      FROM model_layer_enabled
    `)) as unknown as {
      rows: Array<{ market_type: string; gender: string; layer: string; enabled: boolean }>;
    };
    for (const r of rows.rows ?? []) {
      map.set(`${r.market_type}|${r.gender}|${r.layer}`, r.enabled === true);
    }
  } catch (err) {
    logger.warn({ err }, "model_layer_enabled load failed — defaulting all layers off");
  }
  layerEnabledCache.data = map;
  layerEnabledCache.expiresAt = now + CACHE_TTL_MS;
  return map;
}

/**
 * Load DC context for a match. Joins matches → competition_config by
 * normalised league name (the same `LOWER(REPLACE(name, '-', ' '))`
 * pattern used in autonomousTierLadder and apiFootball).
 *
 * Returns rho=0 + enabled=false when no scoreline_correlation row or
 * no model_layer_enabled row exists for the bet's (market_type, gender,
 * 'dixon_coles') cell — i.e. the runtime is a no-op until Phase 1b/c
 * populate the tables.
 */
export async function loadDixonColesContext(matchId: number): Promise<DcMatchContext> {
  const now = Date.now();
  const cached = matchCtxCache.get(matchId);
  if (cached && now < cached.expiresAt) return cached.ctx;

  const rows = (await db.execute(sql`
    SELECT cc.api_football_id, cc.gender
    FROM matches m
    LEFT JOIN competition_config cc
      ON LOWER(REPLACE(cc.name, '-', ' ')) = LOWER(REPLACE(m.league, '-', ' '))
    WHERE m.id = ${matchId}
    LIMIT 1
  `)) as unknown as { rows: Array<{ api_football_id: number | null; gender: string | null }> };
  const cc = rows.rows?.[0] ?? null;
  const gender: "male" | "female" = (cc?.gender === "female" ? "female" : "male");

  // Load per-scope ρ for the AH market type (the only DC-using market on
  // the placement path today). Extending to other scoreline-derived
  // markets is a Phase 1b follow-up.
  let rho = 0;
  let copulaKind: "dixon_coles" | "sarmanov" = gender === "female" ? "sarmanov" : "dixon_coles";
  if (cc?.api_football_id != null) {
    const scopeRows = (await db.execute(sql`
      SELECT rho, copula_kind
      FROM scoreline_correlation
      WHERE api_football_id = ${cc.api_football_id}
        AND market_type = 'ASIAN_HANDICAP'
      LIMIT 1
    `)) as unknown as { rows: Array<{ rho: string; copula_kind: string }> };
    const sr = scopeRows.rows?.[0];
    if (sr) {
      const parsed = Number(sr.rho);
      if (Number.isFinite(parsed)) rho = Math.max(-0.2, Math.min(0.2, parsed));
      if (sr.copula_kind === "sarmanov") copulaKind = "sarmanov";
      else if (sr.copula_kind === "dixon_coles") copulaKind = "dixon_coles";
    }
  }

  const layerMap = await loadLayerEnabledMap();
  const enabledByMarketType = new Map<string, boolean>();
  for (const mt of ["ASIAN_HANDICAP", "OVER_UNDER_15"]) {
    enabledByMarketType.set(
      mt,
      layerMap.get(`${mt}|${gender}|${copulaKind}`) === true,
    );
  }

  const ctx: DcMatchContext = { rho, copulaKind, gender, enabledByMarketType };
  matchCtxCache.set(matchId, { ctx, expiresAt: now + CACHE_TTL_MS });
  return ctx;
}

/** Per-market-type runtime opts to hand to predictAsianHandicap. */
export function dcOptsForMarket(
  ctx: DcMatchContext,
  marketType: string,
): { rho: number; copulaKind: "dixon_coles" | "sarmanov" } | undefined {
  const enabled = ctx.enabledByMarketType.get(marketType) === true;
  if (!enabled) return undefined;
  if (ctx.rho === 0) return undefined;
  return { rho: ctx.rho, copulaKind: ctx.copulaKind };
}
