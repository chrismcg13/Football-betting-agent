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
        "Operator approval after empirical impact brief built on clean post-fix shadow data. Wait ~30 days clean post-fix data before authoring brief so impact numbers are honest, not speculative.",
    },
    actions_taken: {
      status: "design_pending",
      tasks: ["#49"],
      gate: "30 days of clean post-fix shadow data accumulated before impact brief",
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
