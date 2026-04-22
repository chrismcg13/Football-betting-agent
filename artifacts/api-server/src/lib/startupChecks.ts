const KNOWN_LOCAL_DEV_HOSTS = ["helium", "localhost", "127.0.0.1"];

export function verifyDbHostForEnvironment(
  environment: string,
  dbUrl: string,
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
