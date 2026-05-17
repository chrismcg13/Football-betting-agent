/**
 * Bundle 6 — canonical rejection-gate enum (2026-05-17)
 *
 * Every code path that rejects (or trims to shadow) a bet writes a
 * compliance_logs row with details.gate set to a value from this enum.
 * SQL can then aggregate "candidates lost per gate" reliably via
 * v_rejected_by_gate_24h or ad-hoc queries.
 *
 * Pre-Bundle-6 the same data lived in an unstructured `details.reason`
 * free-text string, so cardinality scans produced noise. The reason
 * string is retained as a human-readable supplement; the structured gate
 * is the canonical pivot.
 *
 * Adding a new gate: append it to REJECTION_GATES below AND update any
 * call site that emits the rejection. The const-array-as-source pattern
 * means the TypeScript union picks up new gates automatically.
 *
 * Gates are deliberately fine-grained — e.g. duplicate_selection_pending
 * and duplicate_selection_db_race are distinct because the operational
 * response differs (the latter signals a race condition the partial
 * unique index caught; the former is the friendly fast-path rejection).
 */

export const REJECTION_GATES = [
  // ── Hard data-quality gates ──────────────────────────────────────────────
  "banned_market",
  "match_not_found",
  "stats_coverage_missing",

  // ── Scope eligibility / model-confidence gates ────────────────────────────
  "autonomous_scope_pause",
  "dynamic_block_check",
  "api_football_circuit_open",
  "production_quarantine_data_tier",
  "production_quarantine_boosted_score",

  // ── Operational / circuit-breaker gates ──────────────────────────────────
  "agent_not_running",
  "betfair_api_paused",
  "live_circuit_breaker",
  "daily_loss_limit",
  "weekly_loss_limit",

  // ── Duplicate / saturation gates ─────────────────────────────────────────
  "duplicate_selection_pending",
  "duplicate_threshold_category",
  "duplicate_selection_db_race",
  "match_saturated_same_rail",
  "match_saturated_both_rails",

  // ── Sizing / risk gates ──────────────────────────────────────────────────
  "kelly_below_min_stake",
  "slippage_guard",
  "exposure_limit",

  // ── Bundle 5 inversion-gate rejections (only fire when flag active) ──────
  "stage1_model_filtered",
  "stage1_clv_breaker_market_paused",
  "stage2_no_pinnacle_anchor",
  "stage2_veto_catastrophic_disagreement",
  "stage3_below_net_edge_floor",
  "reject_high_edge_integrity",
  "inversion_exposure_cap_trimmed",

  // ── Lazy-promote gates (Bundle 5.G + earlier) ────────────────────────────
  "lazy_promote_edge_evaporated",
  "lazy_promote_betfair_drift",
  "lazy_promote_event_unavailable",
  "lazy_promote_placement_failed",
  "scope_eligible_but_negative_kelly",
  "scope_eligible_but_wilson_lcb_negative",
] as const;

export type RejectionGate = (typeof REJECTION_GATES)[number];

/** Runtime guard — defensive use only; the TS union should catch most issues at compile. */
export function isRejectionGate(s: string): s is RejectionGate {
  return (REJECTION_GATES as readonly string[]).includes(s);
}
