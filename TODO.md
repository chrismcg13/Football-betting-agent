# TODO — separate-session items

Things deliberately deferred. Each entry: what / why deferred / when urgent.

## 1. Migration model — technical debt

**What:** Migration mechanism is `CREATE TABLE IF NOT EXISTS` blocks in `artifacts/api-server/src/lib/migrate.ts` run on every api-server startup. No journal of which migrations have been applied — each block relies on its own idempotency.

**Why deferred:** Phase-2 reliability schema is purely additive (10 new tables, no ALTER on existing tables). Idempotent CREATE-IF-NOT-EXISTS is safe under that constraint. Solving the broader migration model would have stalled the reliability work.

**When it becomes urgent:** Before the next non-additive schema change. Specifically:
- ALTER TABLE on existing tables that already have data
- Adding NOT NULL columns to existing tables (without DEFAULT, requires backfill)
- Renaming columns or tables
- Dropping columns or tables
- Type changes
- Foreign-key additions to existing tables

**What "fixed" looks like (rough sketch):**
- A `schema_migrations` ledger table tracking which migration IDs have been applied
- Each migration is a discrete file with an explicit ID, up + down (or at least up + provenance)
- Migrations apply in order, exactly once
- Drizzle-kit could be the source — but the project chose hand-written SQL for a reason; understand that reason before changing the path
- Coupling with #4 below: the runbook that survives this transition

**Cross-references:** noted in `migrate.ts` reliability block comment, in this file, and in #3 below.

---

## 2. `paper_bets` table rename

**What:** The bets-of-record table is named `paper_bets` for historical reasons (legacy from pre-2026-05-09 paper-trading era). Post-cutover, paper-bet emission is permanently disabled — every bet in that table is now live. The name is a database artifact, not an architectural concept.

**Why deferred:** A rename is a non-additive schema change (it requires either ALTER TABLE RENAME with downstream coordinated cutover, or dual-write + read migration). It must wait for the migration model in #1 to be sorted, otherwise we'd be doing a high-risk rename on a fragile mechanism.

**When it becomes urgent:** When new contributors start tripping over the naming, or when the pre-cutover legacy is so distant it's actively misleading. Today: comments in code/doc clarify the situation, which is good enough.

**What "fixed" looks like:** ALTER TABLE paper_bets RENAME TO bets, plus updated Drizzle schema, plus all references in code (~150 sites in `paperTrading.ts` alone). Done as a single coordinated PR after #1 lands.

---

## 3. No separate dev environment

**What:** This project has only one Neon database — prod. There's no dev/staging/test isolation in the data layer. Migrations therefore have to choose between two patterns:

- **Surgical-direct-to-prod (additive only):** for purely-additive changes (new tables, new indexes), apply DDL directly via psql or Neon SQL editor without an api-server restart. The trading loop continues unaffected because operational tables aren't touched. Phase 2 used this pattern.
- **Neon branch-and-throwaway (destructive changes):** for ALTER / DROP / NOT NULL-additions / type changes, create a Neon branch from prod, apply on the branch, soak, validate, then merge or re-apply to prod. Branch is throwaway after migration completes.

**Why deferred:** standing up a permanent dev DB is a real cost, and Neon branching gives the same isolation per-migration. The branch-and-throwaway pattern is the long-term answer; we just haven't formalised it.

**When it becomes urgent:** First time someone does a destructive migration without using a branch and corrupts prod. Pre-empt that by writing the runbook (#4 below).

**Coupling:** depends on #1 (migration model). Once we have a journal + ordered migrations, branch testing becomes much cleaner — apply N migrations to branch, verify, apply same N to prod.

---

## 4. Surgical migration runbook

**What:** Write up the surgical-direct-to-prod migration procedure (paste SQL, verify connection, run, verify, monitor) as a reusable pattern. We just established this on Phase 2 — capture it before the muscle memory fades.

**Why deferred:** We were doing the work, not documenting the procedure. Now that it works, documenting it is cheap and high-value.

**When it becomes urgent:** Before the next migration. If we hit another additive change without the runbook, we'll be reinventing the steps from memory.

**What "fixed" looks like:** `docs/MIGRATIONS.md` containing:
- Decision tree: additive → surgical-direct; destructive → Neon branch (until #1 is fixed, then versioned)
- Surgical-direct procedure: extract SQL inline → confirm connection target → verify hitting prod → run → verify post-conditions → monitor trading loop continuity
- Neon-branch procedure (sketch — fully designed when needed)
- Failure recovery: what to do if DDL errors mid-script

**Source material:** the protocol Chris dictated for Phase 2 application is the first draft.

---

(Add new items below as they come up. Format: ## title, then What / Why deferred / When urgent.)
