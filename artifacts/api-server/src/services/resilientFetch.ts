import { logger } from "../lib/logger";

interface CircuitBreakerState {
  failures: number;
  firstFailureAt: number;
  openUntil: number | null;
  halfOpenAttemptInProgress: boolean;
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

const CB_FAILURE_THRESHOLD = 5;
const CB_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const CB_OPEN_DURATION_MS = 15 * 60 * 1000;

function getCircuitBreaker(service: string): CircuitBreakerState {
  if (!circuitBreakers.has(service)) {
    circuitBreakers.set(service, {
      failures: 0,
      firstFailureAt: 0,
      openUntil: null,
      halfOpenAttemptInProgress: false,
    });
  }
  return circuitBreakers.get(service)!;
}

function recordSuccess(service: string): void {
  const cb = getCircuitBreaker(service);
  cb.failures = 0;
  cb.firstFailureAt = 0;
  cb.openUntil = null;
  cb.halfOpenAttemptInProgress = false;
}

function recordFailure(service: string): void {
  const cb = getCircuitBreaker(service);
  const now = Date.now();

  if (cb.halfOpenAttemptInProgress) {
    cb.openUntil = now + CB_OPEN_DURATION_MS;
    cb.halfOpenAttemptInProgress = false;
    logger.error({ service, reopenUntil: new Date(cb.openUntil).toISOString() },
      `Circuit breaker RE-OPENED for ${service} — half-open probe failed`);
    return;
  }

  if (cb.firstFailureAt === 0 || now - cb.firstFailureAt > CB_FAILURE_WINDOW_MS) {
    cb.failures = 1;
    cb.firstFailureAt = now;
  } else {
    cb.failures++;
  }

  if (cb.failures >= CB_FAILURE_THRESHOLD) {
    cb.openUntil = now + CB_OPEN_DURATION_MS;
    logger.error(
      { service, failures: cb.failures, openUntil: new Date(cb.openUntil).toISOString() },
      `Circuit breaker OPENED for ${service} — ${cb.failures} failures in ${CB_FAILURE_WINDOW_MS / 60000} min`,
    );
  }
}

export function isCircuitOpen(service: string): boolean {
  const cb = getCircuitBreaker(service);
  if (cb.openUntil == null) return false;

  const now = Date.now();
  if (now >= cb.openUntil) {
    if (!cb.halfOpenAttemptInProgress) {
      cb.halfOpenAttemptInProgress = true;
      logger.info({ service }, `Circuit breaker HALF-OPEN for ${service} — allowing one probe request`);
      return false;
    }
    return true;
  }
  return true;
}

export function getCircuitStatus(service: string): {
  state: "closed" | "open" | "half-open";
  failures: number;
  openUntil: string | null;
} {
  const cb = getCircuitBreaker(service);
  const now = Date.now();

  if (cb.openUntil == null || cb.failures < CB_FAILURE_THRESHOLD) {
    return { state: "closed", failures: cb.failures, openUntil: null };
  }
  if (now >= cb.openUntil) {
    return { state: "half-open", failures: cb.failures, openUntil: new Date(cb.openUntil).toISOString() };
  }
  return { state: "open", failures: cb.failures, openUntil: new Date(cb.openUntil).toISOString() };
}

export interface ResilientFetchOptions {
  service: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  headers?: Record<string, string>;
}

export async function resilientFetch<T = unknown>(
  url: string,
  opts: ResilientFetchOptions,
): Promise<T | null> {
  const {
    service,
    timeoutMs = 30_000,
    maxRetries = 3,
    backoffBaseMs = 1000,
    headers,
  } = opts;

  if (isCircuitOpen(service)) {
    const cb = getCircuitBreaker(service);
    if (!cb.halfOpenAttemptInProgress) {
      logger.warn({ service, url }, `Circuit breaker OPEN — skipping ${service} call`);
      return null;
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const statusText = `${res.status} ${res.statusText}`;
        if (attempt === maxRetries) {
          logger.warn({ service, url, status: res.status, attempt }, `${service} HTTP error after ${maxRetries} attempts: ${statusText}`);
          recordFailure(service);
          return null;
        }
        const backoff = backoffBaseMs * Math.pow(2, attempt - 1);
        logger.warn({ service, url, status: res.status, attempt, backoffMs: backoff }, `${service} HTTP error — retrying`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      const json = await res.json();
      recordSuccess(service);
      return json as T;
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      const errMsg = isTimeout ? "Request timed out" : (err instanceof Error ? err.message : String(err));

      if (attempt === maxRetries) {
        logger.error({ service, url, err: errMsg, attempt }, `${service} fetch failed after ${maxRetries} attempts`);
        recordFailure(service);
        return null;
      }

      const backoff = backoffBaseMs * Math.pow(2, attempt - 1);
      logger.warn({ service, url, err: errMsg, attempt, backoffMs: backoff }, `${service} fetch failed — retrying`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  return null;
}
