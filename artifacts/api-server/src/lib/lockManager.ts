/**
 * 2026-05-08 (§4.5 of root-cause-analysis): generic in-process lock with
 * stale-detection auto-release.
 *
 * Background: today's trading cycle hung deterministically on a vps-relay
 * HTTP call that never resolved, holding tradingCycleRunning=true and
 * blocking every subsequent */5min cron tick. The hot-patched fix put
 * stale-detection inside that one function. This module generalises it:
 * any in-process mutex registered here gets the same treatment.
 *
 * Use:
 *   const tradingLock = registerLock("trading_cycle", { staleAfterMs: 5 * 60_000 });
 *   const result = await tradingLock.withLock(async () => {
 *     return runActualCycle();
 *   });
 *   if (result.skipped) { ... } else { ... result.value ... }
 *
 * Semantics:
 * - If the lock is free → acquire, run fn, release in finally.
 * - If held and held < staleAfterMs → skip (return { skipped: true, reason: "in_progress", heldMs }).
 * - If held and held >= staleAfterMs → log warning, force-release, acquire,
 *   run fn. The stale holder's eventual finally will be a no-op when it
 *   finally returns (it'll see acquiredAt mismatch).
 *
 * This pattern protects against await-never-resolves bugs (HTTP timeouts,
 * file I/O hangs, undocumented driver issues) without requiring perfect
 * timeout coverage at every await site.
 */

import { logger } from "./logger";

interface LockState {
  name: string;
  staleAfterMs: number;
  held: boolean;
  acquiredAt: number | null;
  acquireToken: number; // monotonic — detects stale-finally-after-force-release
}

const locks = new Map<string, LockState>();

export interface LockResult<T> {
  skipped: boolean;
  reason?: "in_progress" | "stale_force_released_then_taken_by_other";
  heldMs?: number;
  value?: T;
}

export interface RegisteredLock {
  name: string;
  withLock<T>(fn: () => Promise<T>): Promise<LockResult<T>>;
  isHeld(): boolean;
  forceRelease(): { wasHeld: boolean; heldMs: number | null };
}

export function registerLock(
  name: string,
  opts: { staleAfterMs: number },
): RegisteredLock {
  if (locks.has(name)) {
    return wrap(name, locks.get(name)!);
  }
  const state: LockState = {
    name,
    staleAfterMs: opts.staleAfterMs,
    held: false,
    acquiredAt: null,
    acquireToken: 0,
  };
  locks.set(name, state);
  return wrap(name, state);
}

function wrap(name: string, state: LockState): RegisteredLock {
  return {
    name,
    isHeld: () => state.held,
    forceRelease: () => {
      const wasHeld = state.held;
      const heldMs = state.acquiredAt != null ? Date.now() - state.acquiredAt : null;
      state.held = false;
      state.acquiredAt = null;
      state.acquireToken += 1;
      return { wasHeld, heldMs };
    },
    withLock: async <T>(fn: () => Promise<T>): Promise<LockResult<T>> => {
      // Stale-detection branch
      if (state.held) {
        const heldMs = state.acquiredAt != null ? Date.now() - state.acquiredAt : 0;
        if (heldMs > state.staleAfterMs) {
          logger.warn(
            { lock: name, heldMs, staleAfterMs: state.staleAfterMs },
            "Lock held beyond stale threshold — force-releasing and proceeding",
          );
          state.held = false;
          state.acquiredAt = null;
          state.acquireToken += 1;
        } else {
          return { skipped: true, reason: "in_progress", heldMs };
        }
      }
      // Acquire
      state.held = true;
      state.acquiredAt = Date.now();
      const myToken = ++state.acquireToken;
      try {
        const value = await fn();
        return { skipped: false, value };
      } finally {
        // Only release if WE still own the lock (token matches). If a stale
        // detector force-released us mid-flight, leave the new holder alone.
        if (state.acquireToken === myToken && state.held) {
          state.held = false;
          state.acquiredAt = null;
        }
      }
    },
  };
}

export function getAllLockStatus(): Array<{ name: string; held: boolean; heldMs: number | null }> {
  return Array.from(locks.values()).map((s) => ({
    name: s.name,
    held: s.held,
    heldMs: s.acquiredAt != null ? Date.now() - s.acquiredAt : null,
  }));
}
