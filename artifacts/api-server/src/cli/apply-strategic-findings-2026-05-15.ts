/**
 * One-shot: apply three strategic findings to experiment_learning_journal.
 *
 * Idempotent via experiment_tag check. Re-runs are no-ops.
 *
 * Findings logged:
 *   1. clv_anchor_mismatch_2026_05_15 — closing_pinnacle_odds column holds
 *      non-Pinnacle anchors silently. CLV gate becomes conditional on
 *      Pinnacle availability per scope.
 *   2. dc_rho_underpowered_2026_05_15 — DC operational on ~11% of active
 *      scopes (5 of 47 with n≥100). Decorative on the rest.
 *   3. opponent_blind_lambdas_2026_05_15 — predictAH + predictTT use
 *      marginal team-scoring rates. Prerequisite for DC to deliver lift.
 *
 * Usage (from repo root, .env sourced):
 *   pnpm dlx tsx artifacts/api-server/src/cli/apply-strategic-findings-2026-05-15.ts
 */
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

interface Finding {
  experiment_tag: string;
  analysis_type: string;
  findings: unknown;
  recommendations: unknown;
  actions_taken: unknown;
}

const FINDINGS: Finding[] = [
  {
    experiment_tag: "clv_anchor_mismatch_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "closing_pinnacle_odds column holds non-Pinnacle anchors when Pinnacle coverage is missing. BTTS is 0% Pinnacle-anchored; AH is 42%; MO is 97%. Write path at oddsPapi.ts:3486-3514 falls through to resolveTier2Anchor and writes the tier-2 anchor (e.g. betfair_exchange) into the column named closing_pinnacle_odds with clv_source set honestly to the tier-2 source.",
      bug_class: "column_naming + silent_tier2_fallback",
      distinct_from:
        "AH parser bug (data layer mislabel) — this is anchor-binding misnaming",
      discovered_via:
        "CLV anchor verification audit while investigating AH parser bug fallout (2026-05-15)",
      institutional_lesson:
        "Monitoring assumed Pinnacle anchoring was universal. The write path silently substituted Tier-2 sources for markets with no Pinnacle coverage. Any 'Pinnacle CLV' claim in strategic planning needs a footnote until resolved.",
      revised_principle:
        "Pinnacle availability is not a precondition for graduation; the statistical gate is. Markets without Pinnacle coverage qualify on stricter Wilson + bootstrap signals. CLV is one of three gates, not mandatory when Pinnacle is structurally absent.",
    },
    recommendations: {
      short_term:
        "All 'Pinnacle CLV' claims footnoted in strategic doc revisions until conditional CLV gate ships",
      medium_term:
        "Bundle 2 decision: rename closing_pinnacle_odds → closing_anchor_odds. clv_source + clv_source_tier remain the truth columns. Conditional CLV gate in eligibility view: scope-level Pinnacle coverage ≥30% → CLV t-stat > 1.96 required; otherwise stricter Wilson floor (≥0.55, empirically derived) compensates for missing CLV signal.",
      permanent:
        "Daily 02:00 UTC CLV anchor verification check writes data_quality_alerts when binding drifts. Same pattern as the calibration-sanity gate.",
    },
    actions_taken: {
      status: "pending_power_analysis_before_code",
      blockers: [
        "Per-market Tier-1 coverage distribution",
        "Empirically-derived Wilson floor for Pinnacle-unavailable branch",
        "Sample-size power analysis per market_type with calendar projection",
      ],
      tasks: ["#54 trace complete; rename + conditional logic pending"],
    },
  },
  {
    experiment_tag: "dc_rho_underpowered_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "scoreline_correlation has 47 dixon_coles + 2 sarmanov scopes fitted. Only 5 of 47 have n_matches >= 100; zero have >= 500. DC operational on ~11% of active scopes — decorative on the remaining 89%.",
      context:
        "Avg rho -0.063 (men's) / -0.001 (women's) consistent with Michels et al. 2023. Infrastructure alive, fits weekly via runCalibrationFitter cron. Issue is data density per scope, not code.",
      interaction_with_other_findings:
        "Compound with predictAH/predictTT opponent-blindness: even at perfect rho, the lambdas DC operates on are marginal-only. Phase 1 strategic plan needs reframing — the unlock isn't 'ship DC', it's 'ship opponent-aware lambdas AND fit rho on enough scopes'.",
      open_question:
        "Is under-coverage a training/data problem (3-year retention cuts history) or a code problem (fitter rejecting low-n scopes)? Requires design pass before further DC code work.",
    },
    recommendations: {
      short_term:
        "Annotate Phase 1 strategic plan with DC operational state (5 of 47 scopes effective)",
      design_pass_required:
        "Characterise why 42 of 47 scopes have n < 100. Likely combination of (a) scope cardinality (women's leagues with thin history), (b) 3-year retention cutoff per project_ingest_only_predictive_data, (c) hierarchical Bayes shrinkage pulling low-n scopes to group mean — which may be the correct behaviour and not a bug.",
      revised_plan:
        "Phase 1 (Dixon-Coles) becomes Phase 1A (opponent-aware lambdas) + Phase 1B (DC over those lambdas). 1B is paint on rust without 1A.",
    },
    actions_taken: {
      status: "design_pass_queued",
      depends_on: ["#49 opponent-aware lambdas brief"],
    },
  },
  {
    experiment_tag: "opponent_blind_lambdas_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "predictAsianHandicap and predictTeamTotalGoals use home_goals_scored_avg / away_goals_scored_avg as lambdas. These are historical team-marginal scoring rates that do NOT condition on the specific opponent. The score-matrix is then built as λ_h × λ_a (with optional DC ρ correction) without opponent-aware adjustment.",
      impact:
        "Systematic edge bias on mismatched matches. predictTT explicitly comments 'Independent of opposition.' For TEAM_TOTAL_AWAY_15 the model treats Brazil vs minnow as identical to Brazil vs Germany.",
      prerequisite_for:
        "Dixon-Coles to deliver theoretical lift. DC corrects corner-cell joint mass; the lambdas it operates on must themselves be opponent-aware for the correction to compound correctly.",
      not_a_parser_bug:
        "This is a modelling simplification, not the AH parser bug class. Edge magnitudes are biased systematically (predictable direction); fabricated edge from the AH bug was outright untrue.",
    },
    recommendations: {
      options: [
        {
          id: "A",
          name: "Inverse-Poisson projection from LR-fitted probabilities",
          pros: "Cheaper, reuses existing trained classifiers (predictOutcome, predictOverUnder, predictBtts)",
          cons: "Extra inversion step, may not converge cleanly for all probability shapes",
        },
        {
          id: "B",
          name: "Bivariate-Poisson fit with attack/defense features per team",
          pros: "Standard Dixon-Coles approach, aligns with existing ρ-fit infrastructure",
          cons: "Requires training pipeline + more features per team, higher upfront cost",
        },
      ],
      decision_required:
        "Operator approval after empirical impact brief built on clean post-fix shadow data.",
    },
    actions_taken: {
      status: "design_pending",
      tasks: ["#49"],
      gate_conditions: [
        "At least 3 mature scopes (n>=30 each) accumulated on a Pinnacle-unavailable market like BTTS",
        "AH aggregate path re-qualified post parser-fix",
      ],
      gate_principle:
        "The conditions trigger the brief, not the calendar. Brief is authored when these conditions are met — may be sooner or later than any calendar estimate.",
    },
  },
  {
    experiment_tag: "commercial_assumptions_on_unproven_edge_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "The £5k bankroll target, salary timeline, and subscription-service concept were built on edge signal that is now known to be partly fabricated (AH parser bug) or empirically falsified at n large enough to be definitive (MO, BTTS, TEAM_TOTAL_*, OVER_UNDER_*). Until clean post-fix data demonstrates real edge on at least one market, the financial model is a hypothesis, not a plan.",
      what_changed_2026_05_15:
        "AH parser bug discovery + Tier-1 coverage audit + power analysis on full bet population (live + shadow + paper). The 57 qualifying AH scopes, +55.6 pct ROI, +15.6 pct CLV that the strategic plan rested on are corrupt-input metrics. Aggregate (Path 2) analysis on clean markets at large n shows: MATCH_ODDS Wilson lo95=0.237 (model loses more than it wins, gate unreachable on current architecture) + CLV t-stat +2.15 (model identifies value Pinnacle agrees with) — a calibration anomaly. BTTS n=581 CLV t=-1.24 (no edge). TEAM_TOTAL_AWAY_05 n=197 Wilson 0.489 + CLV t=-2.57 (Wilson close but CLV strongly negative). TEAM_TOTAL_HOME_15 n=245 Wilson 0.396 + CLV t=-1.19. TEAM_TOTAL_AWAY_15 n=190 Wilson 0.298 + CLV t=-0.58. OVER_UNDER_25 n=69 CLV t=-0.72.",
      what_is_falsified:
        "On 4 of 5 measurable clean markets at definitive n, the eligibility gate correctly rejects. This isn't insufficient data — it's empirical evidence the current model has no measurable edge on these markets. Re-eligibility for these markets depends on task #49 (opponent-aware lambdas) for AH/TT-class, or task #61 (MO LR calibration) for MO. Pre-2026-05-15 ROI projections, time-to-bankroll-doubling estimates, salary timeline, subscription concept — all hypotheses contingent on those design passes delivering measurable lift.",
      what_is_still_true:
        "The infrastructure (eligibility view, adaptive Kelly, two-path gate, exclusion rules, kill switch, settlement reconciliation, risk guardrails) is sound. The unknown is whether real edge exists in the underlying model on any market once corrupted inputs are removed AND the modelling gaps (#49, #61) are addressed.",
    },
    recommendations: {
      capital_decision_rule:
        "Do not size capital, salary, or subscription commitments based on pre-2026-05-15 edge numbers. Re-anchor only on clean post-fix data once at least one market_type clears the eligibility gate.",
      messaging_principle:
        "External communication about edge, ROI, or returns must footnote 'subject to clean-data verification post parser fix AND model-architecture remediation' until at least one market clears the gate.",
      ah_specific:
        "AH is the only unfalsified market — its real edge (if any) is unknown until post-parser-fix shadow data accumulates. If AH clean-data fails the gate too, the financial model is falsified across every market the system currently bets.",
    },
    actions_taken: {
      status: "permanent_strategic_constraint",
      next_review_trigger:
        "At least one market_type clears the eligibility gate on data placed AFTER parser-fix-deploy timestamp.",
      gate_conditions_for_capital_commitment: [
        "AH aggregate path qualifies on post-parser-fix shadow data only",
        "OR task #49 design pass demonstrates measurable Wilson + CLV lift on at least one TT/AH-class market",
        "OR task #61 design pass identifies and fixes MO LR calibration anomaly with measurable Wilson lift",
      ],
    },
  },
  {
    experiment_tag: "emission_concentration_structural_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "AH emission concentration in the historical dataset is structural, not a bug. Per-match emission rate roughly equals the number of candidate selections passing edge threshold. AH has ~32 candidate selections per match (handicap lines -2 to +2 in 0.25 steps × 2 sides), giving 10.31 emissions/match. MO has 3 selections (1.05/match), BTTS has 2 (1.02/match), most TEAM_TOTAL/OVER_UNDER have 2 (~1.0/match). The 14k AH bets/week observed is inflation from selection cardinality, not from a throttle on other markets.",
      retrospective_consequence:
        "Any historical performance assessment that aggregated across markets without normalising per-market was implicitly weighted toward AH by emission cardinality. The 'composite ROI' figures used in strategic planning were ~80%+ AH-weighted. Now that AH edge is known to be partly fabricated, those composite figures are not reliable summaries of model performance.",
      not_a_bug_to_fix:
        "Selection cardinality is a property of how each market is structured on Betfair. AH is offered at many lines; BTTS is binary. Equalising emission would either suppress AH down to BTTS-volume (losing legitimate signal on real AH edge if it exists post-fix) or inflate BTTS to AH-volume (artificially — there are only 2 selections to bet). The correct stance is to evaluate each market on its own per-market data, never composite.",
    },
    recommendations: {
      analytics_principle:
        "All strategic performance assessments segment per-market_type. Cross-market composites are inadmissible.",
      audit_trail:
        "Bundle B's analysis_signal_strength already segments per-(market_type, bet_track). The view layer (v_live_eligibility_*) already segments. The risk is in ad-hoc reports and human summaries — flag any composite-ROI claim in strategic docs as a violation.",
    },
    actions_taken: {
      status: "permanent_analytics_constraint",
      enforcement:
        "Per-market segmentation is now required in every retrospective. Add to CLAUDE.md as analytics principle when next revised.",
    },
  },
  {
    experiment_tag: "mo_calibration_compounded_ah_signal_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "MO LR is 59 pp over-confident at high model_p (>=0.70 model bucket: predicts 87.3 pct win, realised 28.7 pct). This miscalibration likely AMPLIFIED the pre-parser-fix AH 'edge' signal beyond what the parser bug alone produced. Two compounding bugs, not one: AH parser corrupted (selection, price) binding AND LR over-confidence inflated stake sizes on bets the model was wildly wrong about.",
      mechanism:
        "AH stake sizing used Kelly fraction at model_p. If model_p was 70-90 pct on bets that actually win 28 pct of the time, Kelly stakes were 3-10x larger than the true-probability Kelly would have sized. Parser bug provided the synthetic edge signal; LR over-confidence provided the stake inflation. Each looks defensible in isolation; together they compound.",
      implication_for_option_b:
        "Option B (bivariate-Poisson fit with attack/defense parameters) addresses LR over-confidence at root by replacing LR-derived joint probabilities with directly-fitted calibrated parameters. This strengthens the case for B as the strategic play, not merely the cleaner play. Option A (inverse-Poisson projection from LR outputs) inherits the LR over-confidence and is operational continuity, not a permanent fix.",
      pattern_to_watch:
        "Individually-defensible code surfaces combining into actively-harmful behaviour. Worth considering whether there's a systematic way to catch compounding bugs that no single audit would surface — possibly via cross-component property tests on the end-to-end probability → stake → outcome chain.",
    },
    recommendations: {
      strategic:
        "Option B ships regardless of Option A's evaluation outcome. The only condition under which B does not ship: Option A produces zero or negative lift on ALL evaluated markets AND post-parser-fix AH retains no edge. Anything short of that — directional positive on even one market, or AH edge surviving — confirms B is the play.",
      immediate_mitigation:
        "#61 remediation (Path 1: loosen Block B AND-condition to just-Wilson; Path 4: disable per-league isotonic when n<100) shipped 2026-05-15. These shrink over-confident model_p toward implied_p, reducing the magnitude of stake inflation while Option B is built.",
    },
    actions_taken: {
      status: "permanent_strategic_finding",
      tasks: ["#61 shipped", "#49 Option A shipped (operational continuity)", "Option B design doc pending"],
    },
  },
  {
    experiment_tag: "clv_anchor_timing_drift_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "Structural audit (closing_odds_timing) shows median anchor capture time for AH is T-48 min pre-kickoff vs the T-30 min threshold. CLV t-stats system-wide are computed against late-but-not-closing snapshots. Effect size unknown but consistent across markets — meaning every CLV t-stat in the system is a biased estimate of true CLV-vs-close.",
      magnitude_unknown:
        "Unknown whether the T-48 vs T-30 gap materially shifts CLV values. Late-market movement in the final 30 min before kickoff captures sharp money; missing it understates CLV. Direction of bias: unclear without comparing T-48 vs T-0 snapshots head-to-head on the same matches.",
      not_a_money_guardrail_issue:
        "CLV is used as a confidence signal for the eligibility gate, not for stake sizing directly. Biased CLV t-stats affect which scopes qualify, not which stakes apply once qualified. Bounded analytical risk.",
    },
    recommendations: {
      short_term:
        "Tighten the snap window in fetchAndStoreClosingLineForPendingBets once results-ingestion (#62) and AH parser fix (#step 6) are clean. Target: median T-delta <10 min, p95 <30 min.",
      medium_term:
        "Re-evaluate every Bundle B CLV t-stat once snap timing is tight. Scopes currently borderline-qualifying on CLV may shift either way; rebaseline.",
    },
    actions_taken: {
      status: "logged_for_future_remediation",
      next_review_trigger: "After #62 + step 6 ship clean; before Option B design doc work.",
    },
  },
  {
    experiment_tag: "mo_calibration_anomaly_2026_05_15",
    analysis_type: "strategic_finding",
    findings: {
      summary:
        "MATCH_ODDS aggregate at n=1109 shows Wilson lo95=0.237 (model wins ~26 pct of bets — far below 50 pct break-even) BUT CLV t-stat=+2.15 with mean CLV=+1.93 pct (Pinnacle moves toward our side after we place). The model identifies value the sharpest market agrees with, but the outcomes systematically don't follow our probability assignments. This is a probability calibration error, not a feature gap.",
      distinct_from_opponent_blindness:
        "predictOutcome uses the trained outcomeModel LR (predictionEngine.ts:715-734) which has the full FEATURE_NAMES vector including opponent-derived xG proxies, Elo on both sides, head-to-head, etc. The LR is opponent-aware. The failure is at the LR's probability calibration, not at the feature engineering layer.",
      hypothesised_mechanisms: [
        "Edge-filter selection bias — probabilities well-calibrated overall, but the eligibility funnel selects bets where (model_prob - implied_prob) is largest, biasing the emitted subset toward over-confidence",
        "Isotonic / Platt calibration drift on calibration_buckets for MO specifically",
        "Training-test feature distribution shift — features at training time differ from features at predict time",
        "Class imbalance in 3-way training data (home wins > away > draws historically) producing under-calibrated tails",
      ],
      relation_to_other_findings:
        "Same observational symptom as the AH parser bug (positive CLV with bad realized outcomes) but DIFFERENT root cause. AH was a data-layer mislabel; MO is an LR-layer calibration issue. Separate diagnostic pass required.",
    },
    recommendations: {
      diagnostic_pass:
        "Open task #61 — read-only audit of MO predictions: training-time vs predict-time feature distribution; isotonic calibrator residuals on MO bins; edge-filter selection-bias quantification (compare LR probabilities on emitted vs all-fixture distributions); class balance in training.",
      do_not_treat_as_part_of_49:
        "Mixing MO calibration into #49 (opponent-aware lambdas) over-scopes the brief. Solutions are different — #49 changes the lambda inputs to the score-matrix; #61 likely retrains or re-calibrates the LR or fixes the emission filter. Keep them parallel.",
    },
    actions_taken: {
      status: "new_diagnostic_pass_opened",
      tasks: ["#61"],
    },
  },
  {
    experiment_tag: "statistical_gate_not_temporal_2026_05_15",
    analysis_type: "operating_principle",
    findings: {
      summary:
        "Every project milestone is expressed as 'condition met when X' — not 'expected in N days.' Calendar projections are useful for fixture-rate planning but are never commitments. The data decides when a market becomes eligible; the system waits for statistical sufficiency, not calendar time.",
      origin:
        "This session repeatedly drifted into calendar-based language ('30 days clean data', '7-10 days to re-qualify', '5-6 weeks to MO clearance'). All such estimates are projections-on-current-fixture-rate, not commitments. The user (Chris) called out the drift three times before this principle was codified.",
      principle_text:
        "A scope re-qualifies when n is sufficient at the empirical p̂ to clear the gate, regardless of whether that takes 10 days or 60. Capital commitments built on pre-fix or pre-clean-data edge numbers are hypotheses, not plans. World Cup, season-end, fixture density — all change accumulation rates but none change the gate.",
    },
    recommendations: {
      enforcement: [
        "Added to CLAUDE.md §2 as Principle #7 alongside Principle #6 (every metric has a periodic verification check)",
        "Future planning documents must phrase milestones as 'condition met when X' — agent should flag any 'expected in N days' phrasing in its own output as a violation of this principle",
        "Calendar estimates allowed as parenthetical projections with explicit caveat (e.g. 'at current 50 bets/day this would reach n=30 in ~3 days, contingent on fixture availability')",
      ],
    },
    actions_taken: {
      status: "permanent_operating_principle",
      codified_in: "CLAUDE.md §2 Principle #7",
    },
  },
];

async function main(): Promise<void> {
  for (const f of FINDINGS) {
    const existing = await db.execute(sql`
      SELECT id FROM experiment_learning_journal
      WHERE experiment_tag = ${f.experiment_tag}
      LIMIT 1
    `);
    const rows = (((existing as unknown) as { rows?: Array<{ id: string }> }).rows ?? []);

    if (rows.length > 0) {
      console.log(`SKIP   tag=${f.experiment_tag} already exists id=${rows[0]!.id}`);
      continue;
    }

    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO experiment_learning_journal
        (id, analysis_date, experiment_tag, analysis_type, findings, recommendations, actions_taken)
      VALUES
        (${id}, NOW(), ${f.experiment_tag}, ${f.analysis_type},
         ${JSON.stringify(f.findings)}::jsonb,
         ${JSON.stringify(f.recommendations)}::jsonb,
         ${JSON.stringify(f.actions_taken)}::jsonb)
    `);
    console.log(`OK     tag=${f.experiment_tag} inserted id=${id}`);
  }
  console.log("\nStrategic findings applied.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
