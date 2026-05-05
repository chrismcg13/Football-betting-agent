# R6.1 — In-play CLV contamination fix

**Status:** PLAN — DIFF PROPOSED, AWAITING USER APPROVAL.

**Authored:** 2026-05-05, sub-phase 1 of strategic Phase 2 push.
**Trigger:** diagnostic finding §5.1.A. Every Tier A league shows negative winsorised CLV (Premier League −33%, etc.). The R6 hotfix's `odds_snapshots` Pinnacle-source filter takes the *latest* snapshot, which is post-kickoff in-play for matches that already started — producing strongly-negative CLV on bets that subsequently won.
**Predecessor:** `docs/r6-clv-source-investigation.md` (R6 hotfix shipped 2026-05-05, commit `29e8396`).

---

## 0. The fix in one sentence

**Prefer `paper_bets.closing_pinnacle_odds` (frozen pre-kickoff by Writer A) when non-null; fall back to `odds_snapshots` Pinnacle-source filter only when the column is null.**

`closing_pinnacle_odds` is unambiguous strict-pre-kickoff. The snapshot filter can return in-play data if Pinnacle continues publishing during the match.

---

## 1. Two writers, two diffs

The R6 hotfix patched two writers. R6.1 must patch the same two:

1. **`paperTrading.ts:_settleBetsInner`** — primary paper-mode settlement path.
2. **`betfairLive.ts:reconcileSettlements`** — live-mode reconciliation.

**Sub-finding during diff prep:** the R6 patch in `betfairLive.ts` is **structurally broken** in a way that has not yet manifested. The select projection at `betfairLive.ts:701-707` only includes `id`, `betfairBetId`, `settlementPnl`, `status`, `stake`. The R6 CLV block at lines 854-881 references `bet.matchId`, `bet.marketType`, `bet.selectionName`, `bet.oddsAtPlacement` — none of which are in the projection. At runtime these are `undefined`, so the queries filter on `undefined` and return zero rows; the CLV calc at 881 always reads `Number(undefined ?? 0) = 0` and the `placementOdds > 1` guard fails silently. Net effect: **`betfairLive.ts` reconcileSettlements never writes `clv_pct`, even when it appears to.**

This has had **zero production impact** because `reconcileSettlements` is `isLiveMode()`-gated at `scheduler.ts:1806`, and `paper_mode = true` means `isLiveMode()` returns false and the cron never fires. But the broken code is a latent live-mode footgun. R6.1 fixes both the in-play contamination AND the projection bug in `betfairLive.ts`.

---

## 2. Diff — `paperTrading.ts`

**Location:** `paperTrading.ts:1994-2050`. The R6 block.

**Substantive change:** insert a 9-line "prefer column" block before the existing `latestPinnacle` snapshot lookup; gate the snapshot lookup behind a null check.

**Net line change:** +14 / −2 (=12 net new lines). The substantive logic change is one new check + one fallback gate.

### 2.1 Before

```ts
// Line 2024-2047 (current state)
      const latestPinnacle = await db
        .select({ backOdds: oddsSnapshotsTable.backOdds })
        .from(oddsSnapshotsTable)
        .where(
          and(
            eq(oddsSnapshotsTable.matchId, bet.matchId),
            eq(oddsSnapshotsTable.marketType, bet.marketType),
            eq(oddsSnapshotsTable.selectionName, bet.selectionName),
            inArray(oddsSnapshotsTable.source, ["oddspapi_pinnacle", "api_football_real:Pinnacle"]),
          ),
        )
        .orderBy(desc(oddsSnapshotsTable.snapshotTime))
        .limit(1);
      if (latestPinnacle[0]?.backOdds) {
        const pinnacleClose = Number(latestPinnacle[0].backOdds);
        if (pinnacleClose > 1) {
          clvPct = ((odds - pinnacleClose) / pinnacleClose) * 100;
          clvPct = Math.round(clvPct * 1000) / 1000;
          logger.info(
            { betId: bet.id, placementOdds: odds, pinnacleClose, clvPct },
            "CLV calculated from Pinnacle snapshot (oddspapi_pinnacle | api_football_real:Pinnacle)",
          );
        }
      }
```

### 2.2 After

```ts
      // R6.1 (2026-05-05): prefer paper_bets.closing_pinnacle_odds when non-null.
      // The column is frozen pre-kickoff by Writer A (fetchAndStoreClosingLineForPendingBets,
      // oddsPapi.ts:2596-2731). The fallback odds_snapshots Pinnacle filter takes
      // the LATEST Pinnacle snapshot, which can be POST-kickoff in-play for
      // matches already started — using it as "closing line" produces strongly-
      // negative CLV on bets that subsequently won (in-play prices compress
      // toward 1.0). closing_pinnacle_odds is unambiguous strict-pre-kickoff.
      let pinnacleClose: number | null = null;
      let pinnacleSource: "closing_column" | "snapshot" | null = null;
      if (bet.closingPinnacleOdds != null) {
        const fromColumn = Number(bet.closingPinnacleOdds);
        if (fromColumn > 1) {
          pinnacleClose = fromColumn;
          pinnacleSource = "closing_column";
        }
      }
      if (pinnacleClose == null) {
        const latestPinnacle = await db
          .select({ backOdds: oddsSnapshotsTable.backOdds })
          .from(oddsSnapshotsTable)
          .where(
            and(
              eq(oddsSnapshotsTable.matchId, bet.matchId),
              eq(oddsSnapshotsTable.marketType, bet.marketType),
              eq(oddsSnapshotsTable.selectionName, bet.selectionName),
              inArray(oddsSnapshotsTable.source, ["oddspapi_pinnacle", "api_football_real:Pinnacle"]),
            ),
          )
          .orderBy(desc(oddsSnapshotsTable.snapshotTime))
          .limit(1);
        if (latestPinnacle[0]?.backOdds) {
          const fromSnapshot = Number(latestPinnacle[0].backOdds);
          if (fromSnapshot > 1) {
            pinnacleClose = fromSnapshot;
            pinnacleSource = "snapshot";
          }
        }
      }
      if (pinnacleClose != null) {
        clvPct = ((odds - pinnacleClose) / pinnacleClose) * 100;
        clvPct = Math.round(clvPct * 1000) / 1000;
        logger.info(
          { betId: bet.id, placementOdds: odds, pinnacleClose, pinnacleSource, clvPct },
          "CLV calculated from Pinnacle source",
        );
      }
```

**Why this shape:**
- `bet.closingPinnacleOdds` is on the `paper_bets` row (via `migrate.ts:226`), and the outer `_settleBetsInner` selects via `db.select().from(paperBetsTable)` (no projection), so the field is available.
- The snapshot lookup is preserved as a fallback. For Tier B/C bets where Writer A doesn't fire (no OddsPapi mapping), the snapshot lookup is the only signal — the fallback retains that.
- `pinnacleSource` field in the log distinguishes the two paths so post-deploy verification can quickly confirm the column path is being preferred.

---

## 3. Diff — `betfairLive.ts`

**Location:** `betfairLive.ts:700-714` (select projection) and `betfairLive.ts:837-890` (R6 CLV block).

**Two substantive changes:**
1. Widen select projection to include the fields the CLV block actually reads.
2. Apply the same prefer-column-then-fallback logic as in §2.

### 3.1 Diff #1 — widen projection

**Before** (`betfairLive.ts:700-707`):
```ts
  const betsWithBetfairId = await db
    .select({
      id: paperBetsTable.id,
      betfairBetId: paperBetsTable.betfairBetId,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
    })
```

**After:**
```ts
  const betsWithBetfairId = await db
    .select({
      id: paperBetsTable.id,
      betfairBetId: paperBetsTable.betfairBetId,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      // R6.1 (2026-05-05): added so the CLV block at line ~837 can compute
      // clv_pct correctly. Prior R6 patch referenced these fields without
      // adding them to the projection — the queries silently filtered on
      // undefined and never returned rows. No production impact (this writer
      // is isLiveMode()-gated and live mode is currently off), but a latent
      // bug for the live-mode flip.
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      closingPinnacleOdds: paperBetsTable.closingPinnacleOdds,
    })
```

### 3.2 Diff #2 — apply prefer-column-then-fallback

**Before** (`betfairLive.ts:865-887`):
```ts
      const latestPinnacle = await db
        .select({ backOdds: oddsSnapshotsTable.backOdds })
        .from(oddsSnapshotsTable)
        .where(
          and(
            eq(oddsSnapshotsTable.matchId, bet.matchId),
            eq(oddsSnapshotsTable.marketType, bet.marketType),
            eq(oddsSnapshotsTable.selectionName, bet.selectionName),
            inArray(oddsSnapshotsTable.source, ["oddspapi_pinnacle", "api_football_real:Pinnacle"]),
          ),
        )
        .orderBy(desc(oddsSnapshotsTable.snapshotTime))
        .limit(1);
      if (latestPinnacle[0]?.backOdds) {
        const pinnacleClose = Number(latestPinnacle[0].backOdds);
        if (pinnacleClose > 1) {
          const placementOdds = Number(bet.oddsAtPlacement ?? 0);
          if (placementOdds > 1) {
            clvPct = ((placementOdds - pinnacleClose) / pinnacleClose) * 100;
            clvPct = Math.round(clvPct * 1000) / 1000;
          }
        }
      }
```

**After:**
```ts
      // R6.1 (2026-05-05): prefer paper_bets.closing_pinnacle_odds when non-null.
      // See docs/r6-1-in-play-clv-fix-plan.md §0 for rationale. Mirror of the
      // logic in paperTrading._settleBetsInner.
      let pinnacleClose: number | null = null;
      let pinnacleSource: "closing_column" | "snapshot" | null = null;
      if (bet.closingPinnacleOdds != null) {
        const fromColumn = Number(bet.closingPinnacleOdds);
        if (fromColumn > 1) {
          pinnacleClose = fromColumn;
          pinnacleSource = "closing_column";
        }
      }
      if (pinnacleClose == null) {
        const latestPinnacle = await db
          .select({ backOdds: oddsSnapshotsTable.backOdds })
          .from(oddsSnapshotsTable)
          .where(
            and(
              eq(oddsSnapshotsTable.matchId, bet.matchId),
              eq(oddsSnapshotsTable.marketType, bet.marketType),
              eq(oddsSnapshotsTable.selectionName, bet.selectionName),
              inArray(oddsSnapshotsTable.source, ["oddspapi_pinnacle", "api_football_real:Pinnacle"]),
            ),
          )
          .orderBy(desc(oddsSnapshotsTable.snapshotTime))
          .limit(1);
        if (latestPinnacle[0]?.backOdds) {
          const fromSnapshot = Number(latestPinnacle[0].backOdds);
          if (fromSnapshot > 1) {
            pinnacleClose = fromSnapshot;
            pinnacleSource = "snapshot";
          }
        }
      }
      if (pinnacleClose != null) {
        const placementOdds = Number(bet.oddsAtPlacement ?? 0);
        if (placementOdds > 1) {
          clvPct = ((placementOdds - pinnacleClose) / pinnacleClose) * 100;
          clvPct = Math.round(clvPct * 1000) / 1000;
          logger.info(
            { betId: bet.id, placementOdds, pinnacleClose, pinnacleSource, clvPct },
            "CLV calculated from Pinnacle source (live-mode reconciliation)",
          );
        }
      }
```

---

## 4. What this fix does NOT do

- **No schema change.** `closing_pinnacle_odds` already exists on `paper_bets` (migrate.ts:226).
- **No backfill of historical contaminated rows.** The 35 leagues showing negative CLV in the diagnostic include rows settled before R6.1; they remain as-is. Repair via Migration 5 (`clv_source` historical backfill) is a separate sub-phase deliverable.
- **No change to `closing_odds_proxy` semantics.** The any-source lookup at `paperTrading.ts:2008-2018` and `betfairLive.ts:849-862` is preserved. Diagnostic-only column.
- **No modification to Writer A** (`oddsPapi.ts:fetchAndStoreClosingLineForPendingBets`). Writer A remains the canonical strict-pre-kickoff source.

---

## 5. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | The fix changes settlement-time CLV computation. If `closing_pinnacle_odds` is wrong (Writer A bug), settlement now propagates that error directly rather than masking it with a snapshot. | Low — Writer A has been live since `migrate.ts:226` predates the strategic push; no observed Writer A bugs. | Verify post-deploy: spot-check a Tier A bet where `closing_pinnacle_odds` is non-null and confirm clvPct = `(odds - closingPinnacleOdds)/closingPinnacleOdds * 100`. |
| 2 | The widened projection in `betfairLive.ts` could surface a previously-hidden type error elsewhere. | Low — `paperBetsTable` columns are TypeScript-typed; widening is additive and Drizzle infers the new shape automatically. | Run `pnpm typecheck` after applying. |
| 3 | The fallback to snapshot lookup still has the in-play contamination issue for Tier B/C bets where `closing_pinnacle_odds` is null. | Medium — Tier B/C have no Pinnacle coverage; the snapshot filter rarely returns Pinnacle rows for them, so the fallback usually no-ops. But when it does match, it may match an in-play Pinnacle snapshot from a different league's same market (extremely unlikely given the matchId filter). | Acceptable for v1 of the fix. v2 refinement (defer): scope the snapshot filter to `snapshot_time < kickoff_time + 5_minutes`. Deferred to v3 of the fix because requires fetching kickoff_time per bet. |
| 4 | The post-fix CLV distribution is materially different from current. Sub-phase 5's graduation gate threshold tuning will need re-calibration. | Medium — but this is the goal. The current −33% Premier League CLV is meaningless; replacing it with the correct value enables real calibration. | Sub-phase 5 plan-mode document (next session) accounts for the CLV semantics change. |

---

## 6. Verification procedure

After deploy, run on prod:

```sql
-- Verify the prefer-column path is being taken when closing_pinnacle_odds is populated
SELECT
  pb.id,
  pb.market_type, pb.selection_name,
  pb.odds_at_placement, pb.closing_pinnacle_odds,
  pb.clv_pct,
  ROUND(((pb.odds_at_placement::numeric - pb.closing_pinnacle_odds::numeric) / pb.closing_pinnacle_odds::numeric) * 100, 3) AS expected_clv_from_column
FROM paper_bets pb
WHERE pb.status IN ('won','lost')
  AND pb.deleted_at IS NULL
  AND pb.legacy_regime = false
  AND pb.settled_at >= NOW() - INTERVAL '24 hours'
  AND pb.closing_pinnacle_odds IS NOT NULL
ORDER BY pb.settled_at DESC
LIMIT 20;
```

**Pass criterion:** `clv_pct ≈ expected_clv_from_column` (within 0.01) for every row.

Compare 7-day post-deploy CLV distribution to the Q5.1 retrospective baseline. Premier League winsorised CLV should rise from −33% toward 0% or positive territory (real Pinnacle-line value).

---

## 7. Commit shape

**Single commit, scope-tight.**

```
R6.1: prefer closing_pinnacle_odds over odds_snapshots latest at settlement

The R6 hotfix (commit 29e8396) introduced a Pinnacle-source filter on
odds_snapshots and used the LATEST Pinnacle snapshot as the closing line.
For matches already kicked off, the latest Pinnacle snapshot can be in-
play, producing strongly-negative CLV on bets that subsequently won (in-
play prices compress toward 1.0 once the predicted side leads). All Tier A
leagues showed winsorised CLV between -17% and -50% as a result — see
docs/phase-2-diagnostic-findings.md §5.1.A.

Fix: prefer paper_bets.closing_pinnacle_odds (frozen pre-kickoff by Writer A
at oddsPapi.ts:2596-2731) when non-null. Fall back to the odds_snapshots
Pinnacle filter only when the column is null (Tier B/C bets that Writer A
doesn't cover).

Two writers patched, mirror of R6:
- paperTrading._settleBetsInner: insert prefer-column block before snapshot
  lookup; gate snapshot lookup behind null check.
- betfairLive.reconcileSettlements: same surgery, plus widen the
  select projection at line 700-714 to include matchId, marketType,
  selectionName, oddsAtPlacement, closingPinnacleOdds. The R6 patch in
  this writer was structurally broken (queries filtered on undefined)
  but had not manifested because reconcileSettlements is isLiveMode()-
  gated and paper_mode=true.

No schema change. No historical backfill. closing_odds_proxy semantics
unchanged. See docs/r6-1-in-play-clv-fix-plan.md for full rationale +
risk register + verification procedure.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## 8. Sign-off

- [x] Diff drafted for both writers.
- [x] `betfairLive.ts` projection-widening identified as part of the same fix.
- [x] Risk register populated.
- [x] Verification SQL written.
- [ ] User approves the diff (this STOP gate).
- [ ] Edits applied via Edit tool.
- [ ] `pnpm typecheck` runs clean.
- [ ] `pnpm build` runs clean.
- [ ] Single commit with the message in §7.
- [ ] Post-deploy verification SQL run; CLV distribution confirms repair.
