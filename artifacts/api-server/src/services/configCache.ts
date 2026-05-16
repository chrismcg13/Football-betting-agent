import { db, agentConfigTable } from "@workspace/db";
import { logger } from "../lib/logger";

// Bundle N.1 / N.3 (2026-05-16): read-through 60s cache for agent_config.
// CLAUDE.md §11 claimed a cache existed; pg_stat_user_tables disagrees:
// 3.3M sequential scans across 137 rows in lifetime = ~100% cache miss.
// This module is the cache. Every hot-path config read in the codebase
// MUST route through getAgentConfigCached() instead of doing
//   db.select().from(agentConfigTable)
// which is a banned pattern.
//
// Cost basis: per-cycle config full-scan was ~10 KB egress × 288 cycles/day
// × ~5 readers = ~14 MB/day. After this cache: a single full scan every 60s
// = ~1 MB/day. ~93% reduction on agent_config egress.

interface CacheEntry {
  cfg: Record<string, string>;
  loadedAt: number;
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;
let inflight: Promise<Record<string, string>> | null = null;
let hits = 0;
let misses = 0;
let loads = 0;

async function loadFromDb(): Promise<Record<string, string>> {
  loads++;
  const rows = await db
    .select({ key: agentConfigTable.key, value: agentConfigTable.value })
    .from(agentConfigTable);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getAgentConfigCached(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    hits++;
    return cache.cfg;
  }
  // Coalesce concurrent misses so a thundering herd produces 1 query, not N.
  if (inflight) {
    misses++;
    return inflight;
  }
  misses++;
  inflight = (async () => {
    try {
      const cfg = await loadFromDb();
      cache = { cfg, loadedAt: Date.now() };
      return cfg;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getAgentConfigValue(key: string): Promise<string | undefined> {
  const cfg = await getAgentConfigCached();
  return cfg[key];
}

// Force a refresh on next read. Call after admin set-config writes so the
// cached value is invalidated immediately rather than waiting TTL.
export function invalidateAgentConfigCache(): void {
  cache = null;
  inflight = null;
}

export function getAgentConfigCacheStats(): {
  hits: number;
  misses: number;
  loads: number;
  hitRatePct: number;
  cachedAt: number | null;
} {
  const total = hits + misses;
  return {
    hits,
    misses,
    loads,
    hitRatePct: total === 0 ? 0 : Math.round((hits / total) * 1000) / 10,
    cachedAt: cache ? cache.loadedAt : null,
  };
}

// Periodic stats log so we can confirm the cache is actually being hit
// (CLAUDE.md §11 cache claim went undetected for months — this writes proof).
let lastStatsLogAt = 0;
const STATS_LOG_INTERVAL_MS = 10 * 60_000;
export function maybeLogCacheStats(): void {
  const now = Date.now();
  if (now - lastStatsLogAt < STATS_LOG_INTERVAL_MS) return;
  lastStatsLogAt = now;
  logger.info({ cache: getAgentConfigCacheStats() }, "agent_config cache stats");
}
