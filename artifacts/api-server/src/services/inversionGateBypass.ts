/**
 * Bundle 7.C — track-aware bypass helper (2026-05-17)
 *
 * Centralises the rule that the eight Phase-1 upstream gates should
 * STOP firing once `agent_config.inversion_pipeline_enabled = 'true'`
 * for sharp-anchored candidates. Model-only candidates (no sharp
 * anchor) RETAIN the gates — they're the learning rail and the model
 * is the only signal there.
 *
 * Two helpers:
 *
 *   shouldBypassUpstreamGate({ pinnacleImplied })
 *     — Per-candidate. Bypass IFF (a) inversion flag is on AND
 *       (b) Pinnacle has priced this selection (pinnacleImplied
 *       non-null AND > 0). Used in valueDetection.ts and
 *       livePlacementGate.ts where the candidate's anchor status is
 *       known.
 *
 *   shouldBypassCronCap()
 *     — Cron-level (no per-candidate context). Bypasses the
 *       max_bets_per_cycle / per_league / per_market caps wholesale
 *       when the flag is on. The prioritiser (Bundle 7.D) replaces
 *       these caps with the exposure-cap allocator.
 *
 * R1-preserving: bypass cannot occur unless the operator explicitly
 * sets the flag. Pre-flip behaviour is identical to today.
 */

import { isInversionPipelineEnabled } from "./inversionPipeline";

export interface BypassDecisionInput {
  /** Pinnacle implied probability if known at the call site. */
  pinnacleImplied: number | null | undefined;
}

export async function shouldBypassUpstreamGate(input: BypassDecisionInput): Promise<boolean> {
  if (!(await isInversionPipelineEnabled())) return false;
  const pi = input.pinnacleImplied;
  return pi != null && pi > 0;
}

/**
 * Cron-level caps (max_bets_per_cycle, max_bets_per_league,
 * max_bets_per_market) bypass when the inversion flag is on
 * regardless of per-candidate anchor presence — the prioritiser
 * in Bundle 7.D replaces them with capital-driven allocation.
 */
export async function shouldBypassCronCap(): Promise<boolean> {
  return await isInversionPipelineEnabled();
}
