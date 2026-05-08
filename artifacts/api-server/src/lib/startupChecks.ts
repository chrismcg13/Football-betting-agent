const KNOWN_LOCAL_DEV_HOSTS = ["helium", "localhost", "127.0.0.1"];

/**
 * Decision matrix:
 *
 * | ENVIRONMENT | Hostname pattern               | allowDevOnProd | Result          |
 * |-------------|--------------------------------|----------------|-----------------|
 * | development | rough-flower (prod Neon)       | false (default)| FATAL — refuse  |
 * | development | rough-flower (prod Neon)       | true           | WARN — allow    |
 * | development | billowing-lab (dev Neon)       | any            | INFO — pass     |
 * | development | other                          | any            | WARN — pass     |
 * | production  | helium / localhost / 127.0.0.1 | any            | FATAL — refuse  |
 * | production  | billowing-lab (dev Neon)       | any            | FATAL — refuse  |
 * | production  | rough-flower (prod Neon)       | any            | INFO — pass     |
 * | production  | other                          | any            | WARN — pass     |
 *
 * The `allowDevOnProd` flag is the explicit opt-in for paper-trading-on-prod
 * (Phase 6 amended in migration-plan-v2.md): ENVIRONMENT=development +
 * DATABASE_URL=prod Neon, so paper bets land in the canonical DB without a
 * dev branch. The flag only affects the dev+prod-host branch — it does NOT
 * relax any production-side check. The companion verifyTradingModeForEnvironment
 * still refuses dev+LIVE, so this override cannot be combined with live betting.
 */
export function verifyDbHostForEnvironment(
  environment: string,
  dbUrl: string,
  allowDevOnProd: boolean = false,
): { fatal: boolean; level: "info" | "warn" | "error"; message: string } {
  let hostname: string;
  try {
    hostname = new URL(dbUrl).hostname;
  } catch {
    return {
      fatal: false,
      level: "warn",
      message: `Could not parse DATABASE_URL hostname — skipping host verification`,
    };
  }

  if (environment === "development") {
    if (hostname.includes("rough-flower")) {
      if (allowDevOnProd) {
        return { fatal: false, level: "warn",
          message: `ALLOW_DEV_ON_PROD=true — dev workspace explicitly running against prod DB (paper-on-prod mode). This bypasses the dev/prod isolation rail.` };
      }
      return { fatal: true, level: "error",
        message: `Dev workspace is pointed at prod DB — refusing to start` };
    }
    if (hostname.includes("billowing-lab")) {
      return { fatal: false, level: "info",
        message: `Startup safety check PASSED — ENVIRONMENT=development, DB host contains billowing-lab` };
    }
    return { fatal: false, level: "warn",
      message: `Unknown DB host for dev environment — ${hostname}` };
  }

  if (environment === "production") {
    if (KNOWN_LOCAL_DEV_HOSTS.some((h) => hostname.includes(h))) {
      return { fatal: true, level: "error",
        message: `Prod workspace is pointed at a known local dev host (${hostname}) — refusing to start` };
    }
    if (hostname.includes("billowing-lab")) {
      return { fatal: true, level: "error",
        message: `Prod workspace is pointed at dev DB — refusing to start` };
    }
    if (hostname.includes("rough-flower")) {
      return { fatal: false, level: "info",
        message: `Startup safety check PASSED — ENVIRONMENT=production, DB host contains rough-flower` };
    }
    return { fatal: false, level: "warn",
      message: `Unknown DB host for production environment — ${hostname}` };
  }

  return { fatal: false, level: "warn",
    message: `Unknown ENVIRONMENT value "${environment}" — skipping DB host check` };
}

/**
 * 2026-05-08 (§4.3 of root-cause-analysis): market-type registry coverage
 * invariant. At startup, fetch the distinct market_types ever appearing
 * in paper_bets and assert every one has a registry entry. Drift detected
 * at boot rather than 13 hours into a settlement outage.
 *
 * Result is logged at startup; does not refuse to start (some legacy
 * market types may be intentionally retired). Operator query for ongoing
 * monitoring:
 *   SELECT DISTINCT market_type FROM paper_bets
 *   WHERE legacy_regime=false AND deleted_at IS NULL;
 *   compare against listRegisteredMarketTypes().
 */
export async function verifyMarketTypeRegistryCoverage(): Promise<{
  level: "info" | "warn";
  message: string;
  missing: string[];
}> {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const { listRegisteredMarketTypes } = await import("./marketTypes");

  const rows = await db.execute(sql`
    SELECT DISTINCT market_type FROM paper_bets
    WHERE deleted_at IS NULL AND legacy_regime = false
  `);
  const dbTypes = (((rows as any).rows ?? []) as Array<{ market_type: string }>)
    .map((r) => r.market_type);
  const registered = new Set(listRegisteredMarketTypes());
  const missing = dbTypes.filter((t) => !registered.has(t));

  if (missing.length === 0) {
    return {
      level: "info",
      message: `Market-type registry coverage PASSED — ${dbTypes.length}/${dbTypes.length} types registered`,
      missing: [],
    };
  }
  return {
    level: "warn",
    message: `Market-type registry coverage GAP — ${missing.length} types in paper_bets but not in registry: ${missing.join(", ")}`,
    missing,
  };
}

export function verifyTradingModeForEnvironment(
  environment: string,
  tradingMode: string | undefined,
): { fatal: boolean; level: "info" | "warn" | "error"; message: string } {
  const mode = (tradingMode ?? "PAPER").toUpperCase();

  if (environment === "development" && mode === "LIVE") {
    return {
      fatal: true,
      level: "error",
      message: `Dev workspace has TRADING_MODE=LIVE — refusing to start (dev must be PAPER)`,
    };
  }

  if (environment === "production" && mode === "LIVE") {
    return {
      fatal: false,
      level: "info",
      message: `Startup safety check PASSED — ENVIRONMENT=production, TRADING_MODE=LIVE`,
    };
  }

  return {
    fatal: false,
    level: "info",
    message: `Startup safety check PASSED — ENVIRONMENT=${environment}, TRADING_MODE=${mode}`,
  };
}
