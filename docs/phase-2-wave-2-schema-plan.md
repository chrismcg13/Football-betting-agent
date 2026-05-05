# Wave 2 #1 — Decision-audit + threshold-revisions schema

**Status:** PLAN-MODE. Schema commit awaits explicit user approval. **No code change in this document.**

**Authored:** 2026-05-05.
**Predecessor:** Wave 1 closed (firehose ON, first shadow bet placed at 17:15:48 UTC).
**Source:** strategic brief — "THE DECISION AUDIT REQUIREMENT" section + sub-phase 6 description.
**Two-commit discipline:** schema first → behaviour second (per `feedback_race_conditions.md`). This commit is schema-only; the autonomous-decision-write code paths land later in sub-phase 6.

---

## 1. Why these tables

The brief mandates every autonomous decision the model makes ships with a row in `model_decision_audit_log`. Looser threshold proposals queue in `pending_threshold_revisions` for user approval. Both tables MUST exist before sub-phase 6 (autonomous threshold management) ships any code that writes to them.

Net pre-Wave-2 state: neither table exists. Sub-phase 6 cannot land. Decision-audit promise from the brief cannot be honoured. Wave 2 #1 unblocks all this.

---

## 2. `model_decision_audit_log` — DDL (LOCKED)

```sql
CREATE TABLE IF NOT EXISTS model_decision_audit_log (
  id                 SERIAL PRIMARY KEY,
  decision_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decision_type      TEXT NOT NULL,                     -- e.g., 'market_disable', 'league_demote', 'threshold_adjust'
  subject            TEXT NOT NULL,                     -- e.g., 'market:OVER_UNDER_25', 'league:Premier League'
  prior_state        JSONB,                             -- snapshot of relevant fields before the decision
  new_state          JSONB,                             -- snapshot of relevant fields after the decision
  reasoning          TEXT NOT NULL,                     -- free-form explanation
  supporting_metrics JSONB,                             -- numeric backing: sample sizes, ROIs, p-values
  expected_impact    NUMERIC(10,6),                     -- predicted Δ Kelly-growth-rate
  review_status      TEXT NOT NULL DEFAULT 'automatic'  -- 'automatic' | 'user_reviewed' | 'user_overridden'
);

ALTER TABLE model_decision_audit_log
  ADD CONSTRAINT model_decision_audit_log_review_status_check
  CHECK (review_status IN ('automatic','user_reviewed','user_overridden'));

CREATE INDEX IF NOT EXISTS model_decision_audit_log_decided_idx
  ON model_decision_audit_log(decision_at DESC);

CREATE INDEX IF NOT EXISTS model_decision_audit_log_subject_idx
  ON model_decision_audit_log(decision_type, subject);

CREATE INDEX IF NOT EXISTS model_decision_audit_log_review_idx
  ON model_decision_audit_log(review_status)
  WHERE review_status != 'automatic';
```

**Decisions pinned (no deferred-to-scoping):**
- `id` is `SERIAL` not `TEXT` — sequential numeric, simpler than UUID, sufficient for a single-instance audit log.
- `decision_at` not `created_at` — explicit semantic about WHEN the decision was made, distinct from when the row was inserted.
- `prior_state` and `new_state` are `JSONB` — the shape varies per decision_type, e.g., `{"universe_tier": "B"}` for league demotion vs `{"min_edge_threshold": 0.03}` for threshold adjustment.
- `decision_type` is unconstrained TEXT — no CHECK enum because new decision types will be added without schema migration.
- `subject` is unconstrained TEXT — same rationale.
- `review_status` IS CHECK-constrained — only 3 values per the brief; user override depends on this being well-typed.
- `expected_impact` is NUMERIC(10,6) — Kelly-growth-rate is a small fraction (basis points or smaller); 6 decimal precision suffices.
- Three indexes:
  - `decision_at DESC` — for "show me the last N decisions" queries (weekly review).
  - `(decision_type, subject)` — for "all decisions about market X" queries.
  - Partial on `review_status != 'automatic'` — fast lookup for user-reviewed/overridden subset, which is small.

---

## 3. `pending_threshold_revisions` — DDL (LOCKED)

```sql
CREATE TABLE IF NOT EXISTS pending_threshold_revisions (
  id                 SERIAL PRIMARY KEY,
  proposed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  threshold_name     TEXT NOT NULL,                     -- e.g., 'min_edge_threshold', 'roi_floor', 'sample_size_min'
  scope              TEXT NOT NULL DEFAULT 'global',    -- 'global' | 'per_archetype:women' | 'per_league:Premier League'
  current_value      JSONB NOT NULL,                    -- current threshold value (numeric or compound)
  proposed_value     JSONB NOT NULL,                    -- proposed threshold value
  direction          TEXT NOT NULL,                     -- 'tighter' | 'looser' (looser requires user approval)
  reasoning          TEXT NOT NULL,                     -- free-form explanation
  supporting_metrics JSONB,                             -- backing data
  expected_impact    NUMERIC(10,6),                     -- predicted Δ Kelly-growth-rate
  status             TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected' | 'expired'
  reviewed_at        TIMESTAMPTZ,
  reviewed_by        TEXT,                              -- user identifier; NULL if pending or auto-expired
  review_note        TEXT
);

ALTER TABLE pending_threshold_revisions
  ADD CONSTRAINT pending_threshold_revisions_direction_check
  CHECK (direction IN ('tighter','looser'));

ALTER TABLE pending_threshold_revisions
  ADD CONSTRAINT pending_threshold_revisions_status_check
  CHECK (status IN ('pending','approved','rejected','expired'));

CREATE INDEX IF NOT EXISTS pending_threshold_revisions_status_idx
  ON pending_threshold_revisions(status, proposed_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pending_threshold_revisions_scope_idx
  ON pending_threshold_revisions(threshold_name, scope);
```

**Decisions pinned:**
- `direction` CHECK to `'tighter' | 'looser'` — the brief mandates that **tighter is autonomous, looser requires user approval**. The CHECK encodes this invariant; sub-phase 6 logic will route based on this.
- `scope` defaults `'global'` but can be `per_archetype:X` or `per_league:Y` — supports the brief's per-archetype threshold customisation.
- `current_value` and `proposed_value` are JSONB — handles compound thresholds (e.g., `{"min_edge": 0.03, "min_sample_size": 25}`).
- Partial index on `status = 'pending'` — fast lookup for the user's "pending decisions to review" UI.
- `reviewed_by` is TEXT — accepts any identifier ('user', 'admin', 'auto-expire-cron', etc.). No FK to a users table because there isn't one; this is a single-operator system.

---

## 4. Drizzle schema files (NEW — both)

`lib/db/src/schema/modelDecisionAuditLog.ts`:

```ts
import { pgTable, serial, timestamp, text, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const modelDecisionAuditLogTable = pgTable("model_decision_audit_log", {
  id: serial("id").primaryKey(),
  decisionAt: timestamp("decision_at", { withTimezone: true }).notNull().defaultNow(),
  decisionType: text("decision_type").notNull(),
  subject: text("subject").notNull(),
  priorState: jsonb("prior_state"),
  newState: jsonb("new_state"),
  reasoning: text("reasoning").notNull(),
  supportingMetrics: jsonb("supporting_metrics"),
  expectedImpact: numeric("expected_impact", { precision: 10, scale: 6 }),
  reviewStatus: text("review_status").notNull().default("automatic"),
});

export const insertModelDecisionAuditLogSchema = createInsertSchema(modelDecisionAuditLogTable).omit({ id: true });
export type InsertModelDecisionAuditLog = z.infer<typeof insertModelDecisionAuditLogSchema>;
export type ModelDecisionAuditLog = typeof modelDecisionAuditLogTable.$inferSelect;
```

`lib/db/src/schema/pendingThresholdRevisions.ts`:

```ts
import { pgTable, serial, timestamp, text, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pendingThresholdRevisionsTable = pgTable("pending_threshold_revisions", {
  id: serial("id").primaryKey(),
  proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
  thresholdName: text("threshold_name").notNull(),
  scope: text("scope").notNull().default("global"),
  currentValue: jsonb("current_value").notNull(),
  proposedValue: jsonb("proposed_value").notNull(),
  direction: text("direction").notNull(),
  reasoning: text("reasoning").notNull(),
  supportingMetrics: jsonb("supporting_metrics"),
  expectedImpact: numeric("expected_impact", { precision: 10, scale: 6 }),
  status: text("status").notNull().default("pending"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: text("reviewed_by"),
  reviewNote: text("review_note"),
});

export const insertPendingThresholdRevisionsSchema = createInsertSchema(pendingThresholdRevisionsTable).omit({ id: true });
export type InsertPendingThresholdRevision = z.infer<typeof insertPendingThresholdRevisionsSchema>;
export type PendingThresholdRevision = typeof pendingThresholdRevisionsTable.$inferSelect;
```

Re-export both from `lib/db/src/schema/index.ts`.

---

## 5. `migrate.ts` block (idempotent)

Insert at the end of `runMigrations()`, after the existing `paper_bets_current` view block. The view-rebuild block must remain LAST per the comment at line 1051-1055 — these new CREATE TABLE statements don't touch `paper_bets`, so they're safe before the view block.

**Sequence:** the new tables go BEFORE the view rebuild (`migrate.ts:1056-1066`) so that schema is consistent on first deploy.

---

## 6. Risk register

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Schema migration fails on prod | High | Very low | All statements are `CREATE TABLE IF NOT EXISTS` + DO blocks for CHECKs. Idempotent. Re-runnable. |
| R2 | Column name collision with existing tables | None | None | New table names, no overlap |
| R3 | Indexes slow inserts | Low | Low | Both tables expected low-volume (a few hundred rows/week). Indexes negligible cost. |
| R4 | JSONB columns bloat | Low | Low | JSONB compresses well in Postgres; `prior_state`/`new_state` are typically <1KB |
| R5 | CHECK constraint blocks legitimate inserts | Medium | Low | CHECKs only on small enum sets that the brief explicitly defines; new values would require schema migration anyway |

**Net risk: LOW.** Empty tables on first deploy. No interaction with existing data. Quick-revert: `DROP TABLE` (only if absolutely necessary; no data loss risk while empty).

---

## 7. Wall-clock + sequencing

- Drizzle schema files: 5 min
- Append to `migrate.ts`: 5 min
- Re-export from `index.ts`: 1 min
- Build + commit + push: 5 min
- VPS pull + build + restart: 5 min
- Verification SQL (tables exist + are queryable): 1 min

**Total: ~20 min active work.** Single tight commit.

---

## 8. Verification SQL (post-deploy)

```sql
-- T1: confirm tables exist + are queryable
SELECT table_name, column_count
FROM (
  SELECT table_name, COUNT(*) AS column_count
  FROM information_schema.columns
  WHERE table_name IN ('model_decision_audit_log', 'pending_threshold_revisions')
  GROUP BY table_name
) sub;
-- Expected:
--   model_decision_audit_log         | 10
--   pending_threshold_revisions      | 13

-- T2: confirm CHECK constraints exist
SELECT conname, conrelid::regclass AS table_name
FROM pg_constraint
WHERE conname LIKE 'model_decision_audit_log_%'
   OR conname LIKE 'pending_threshold_revisions_%';
-- Expected:
--   model_decision_audit_log_review_status_check
--   pending_threshold_revisions_direction_check
--   pending_threshold_revisions_status_check

-- T3: confirm indexes exist
SELECT indexname, tablename
FROM pg_indexes
WHERE tablename IN ('model_decision_audit_log', 'pending_threshold_revisions')
ORDER BY tablename, indexname;
-- Expected: 5 indexes (3 + 2)

-- T4: confirm tables are empty (first deploy)
SELECT 'model_decision_audit_log' AS table_name, COUNT(*) AS rows FROM model_decision_audit_log
UNION ALL
SELECT 'pending_threshold_revisions', COUNT(*) FROM pending_threshold_revisions;
-- Expected: both 0
```

---

## 9. What this commit does NOT do

- **Does not write any rows** to either table. That's sub-phase 6's job.
- **Does not modify any existing table.** Strict additive.
- **Does not change behaviour.** Empty tables are unread.
- **Does not migrate data.** No INSERT, no UPDATE, no DELETE.

---

## 10. Sign-off — STOP

Schema commits are user-approval-gated per the strategic brief. Approve any/all:

- [ ] §2 `model_decision_audit_log` DDL OK?
- [ ] §3 `pending_threshold_revisions` DDL OK?
- [ ] §4 Drizzle schema files (column naming + types) OK?
- [ ] §5 migrate.ts insertion sequencing OK?
- [ ] §6 risk register accepted?

If approved: I write the Drizzle schemas, append to migrate.ts, re-export from index.ts, commit, push, hand you the deploy + verification SQL.

Stopping. Awaiting Wave 2 #1 schema approval.
