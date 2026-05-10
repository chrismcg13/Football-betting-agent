# TODO — separate-session items

Things deliberately deferred. Each entry must include: what, why deferred, when it becomes urgent.

## Migration model — technical debt

**What:** Today's migration model is `CREATE TABLE IF NOT EXISTS` blocks in `artifacts/api-server/src/lib/migrate.ts` run on every startup. There's no journal of which migrations have been applied — each block just relies on its idempotency.

**Why deferred:** The current Phase-2 reliability schema is purely additive (new tables only, no ALTER). Idempotent CREATE-IF-NOT-EXISTS is safe under that constraint. Solving the broader migration model would have stalled the reliability work.

**When it becomes urgent:** As soon as we need to do any of these, we MUST address the migration model first:
- ALTER TABLE on existing tables that already have data
- Adding NOT NULL columns to existing tables (without DEFAULT, requires backfill)
- Renaming columns or tables
- Dropping columns or tables
- Type changes
- Foreign key additions to existing tables

**What "fixed" looks like (rough sketch — to be designed properly when we revisit):**
- A `schema_migrations` ledger table tracking which migration IDs have been applied
- Each migration is a TS file with up + down (or at least up + provenance)
- Migrations apply in order, exactly once
- Drizzle-kit generate could be the source — but the project chose hand-written SQL for a reason; understand that reason before changing the path

**Related:** the project has `drizzle-kit push` configured but doesn't use it. Whatever the new path is, decide whether it integrates with drizzle-kit or replaces it entirely.

**Tracked:** noted in `migrate.ts` reliability block comment ("…see TODO.md 'Migration model technical debt'"), and here.

---

(Add new items below as they come up. Format: ## title, then What/Why deferred/When urgent.)
