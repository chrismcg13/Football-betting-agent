/**
 * Task 23 — order-book depth + slippage guard (Phase 6a).
 *
 * Pre-placement check: fetch the current best-back ladder via the
 * existing VPS relay, sum the size available at or better than the
 * intended placement price, and reduce the stake if the queue is
 * too thin to absorb us.
 *
 * Rule: depth_at_top ≥ 3 × intended_stake → proceed at full size.
 *       depth_at_top <  3 × intended_stake → reduce to depth_at_top / 3.
 *       New stake < £2 → return zero so the caller demotes to shadow.
 *
 * The 3× cushion is the operator-tunable safety margin
 * (agent_config.slippage_depth_cushion) — covers the gap between
 * fetching the book and the order actually arriving on Betfair (where
 * other matched bettors may have consumed some of the offered size).
 *
 * Split-order logic for stakes > £25 with thin depth is deferred to
 * Phase 6a.2 — first ship just reduces the stake.
 *
 * Pairs with Task 24 (TAKE_BEST_BACK):
 *   1. TAKE_BEST_BACK resolves the placement PRICE
 *   2. slippageGuard checks DEPTH at that price → adjusts STAKE
 *   3. placeOrders fires with the adjusted (price, stake) tuple
 */

import { db, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { relayGetLiquidity, isRelayConfigured } from "./vpsRelay";

const DEFAULT_DEPTH_CUSHION = 3;
const BETFAIR_MIN_STAKE = 2;

interface SlippageCheckCfg {
  depthCushion: number;
}

let cachedCfg: { value: SlippageCheckCfg; fetchedAt: number } | null = null;
const CFG_TTL_MS = 60 * 1000;

async function loadCfg(): Promise<SlippageCheckCfg> {
  const now = Date.now();
  if (cachedCfg && now - cachedCfg.fetchedAt < CFG_TTL_MS) return cachedCfg.value;
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, "slippage_depth_cushion"));
  const raw = rows[0]?.value;
  const cushion = raw != null ? Number(raw) : DEFAULT_DEPTH_CUSHION;
  const value: SlippageCheckCfg = {
    depthCushion: Number.isFinite(cushion) && cushion >= 1 ? cushion : DEFAULT_DEPTH_CUSHION,
  };
  cachedCfg = { value, fetchedAt: now };
  return value;
}

export interface SlippageCheckResult {
  /** Stake adjusted for depth. May equal input (full proceed) or 0 (demote). */
  adjustedStake: number;
  /** Total size available at the top-of-book back price queue. */
  depthAtPrice: number;
  /** True if we cut the stake from input. */
  wasReduced: boolean;
  /** Set when adjustedStake === 0. Drives the caller's demote-to-shadow path. */
  reason: "ok" | "depth_too_thin" | "no_liquidity" | "below_minimum_after_reduction" | "relay_unavailable";
}

/**
 * Check the order book and return the safe stake to place.
 *
 * If the relay is not configured (test environment etc.) we return
 * the input stake unchanged with reason='relay_unavailable' so the
 * caller can still proceed — this is a defensive guard, not a hard
 * dependency.
 */
export async function checkOrderBookDepth(args: {
  marketId: string;
  selectionId: number;
  intendedStake: number;
  intendedPrice: number;
}): Promise<SlippageCheckResult> {
  const { marketId, selectionId, intendedStake, intendedPrice } = args;

  if (!isRelayConfigured()) {
    return {
      adjustedStake: intendedStake,
      depthAtPrice: 0,
      wasReduced: false,
      reason: "relay_unavailable",
    };
  }

  let liquidity;
  try {
    liquidity = await relayGetLiquidity(marketId);
  } catch (err) {
    logger.warn({ err, marketId }, "Slippage guard: liquidity fetch failed — proceeding at intended stake");
    return {
      adjustedStake: intendedStake,
      depthAtPrice: 0,
      wasReduced: false,
      reason: "relay_unavailable",
    };
  }

  const runner = liquidity?.runners?.find((r) => r.selectionId === selectionId);
  if (!runner) {
    return {
      adjustedStake: 0,
      depthAtPrice: 0,
      wasReduced: true,
      reason: "no_liquidity",
    };
  }

  // Sum size at our intended price or BETTER (i.e. higher back odds — Betfair
  // matches our limit order at any back price >= our stated price).
  const backPrices = runner.backPrices ?? [];
  let depth = 0;
  for (const lvl of backPrices) {
    if (lvl.price >= intendedPrice && lvl.size > 0) {
      depth += lvl.size;
    }
  }

  if (depth <= 0) {
    return {
      adjustedStake: 0,
      depthAtPrice: 0,
      wasReduced: true,
      reason: "no_liquidity",
    };
  }

  const { depthCushion } = await loadCfg();
  const maxSafeStake = depth / depthCushion;

  if (intendedStake <= maxSafeStake) {
    return {
      adjustedStake: intendedStake,
      depthAtPrice: depth,
      wasReduced: false,
      reason: "ok",
    };
  }

  // Reduce stake. Round down to nearest penny.
  const reduced = Math.floor(maxSafeStake * 100) / 100;
  if (reduced < BETFAIR_MIN_STAKE) {
    logger.info(
      { marketId, selectionId, intendedStake, depth, depthCushion, reduced },
      "Slippage guard: reduced stake below £2 — demoting to shadow",
    );
    return {
      adjustedStake: 0,
      depthAtPrice: depth,
      wasReduced: true,
      reason: "below_minimum_after_reduction",
    };
  }
  logger.info(
    { marketId, selectionId, intendedStake, adjustedStake: reduced, depth, depthCushion },
    "Slippage guard: stake reduced to fit available depth",
  );
  return {
    adjustedStake: reduced,
    depthAtPrice: depth,
    wasReduced: true,
    reason: "depth_too_thin",
  };
}
