# C3c — Lineup-trigger cancel-and-rebet for pending real-stake bets

**Status:** ⏸ **DEFERRED** as of 2026-05-07. Reasons + future trigger rule below.
**Authored:** 2026-05-07. **Predecessors:** C3a (predictions/standings ingestion), C3b (predictions feature wiring).

---

## 0. Why deferred (2026-05-07 decision)

Independent verification of Betfair Exchange API rules confirmed Chris's
understanding:
- Unmatched LIMIT bets can be cancelled or `replaceOrders`-amended for free
  pre-event. (`cancelOrders` already wired at `betfairLive.ts:556`.)
- Matched portions are binding and cannot be cancelled — only laid off.

But the SQL audit showed:
- We are running in PAPER mode. Zero real bets placed on Betfair Exchange in
  the last 14 days (`real_stake_with_betfair_bet_id = 0`).
- When live, the cancellable surface (unmatched portions of LIMIT+LAPSE
  bets sitting in the book pre-event) will be a small fraction of placements
  — Tier A high-liquidity markets typically match in seconds.

The bigger CLV opportunity is in **lineup-aware features** (the model gets
smarter, the placement pipeline benefits on every bet, not just the tiny
unmatched slice). Shipped instead as **C3-lineup-features**: expected-XI
baseline + `key_player_missing_count` feature derivation.

## 0.1 Future re-activation rule (when we go live)

When real-money trading goes live on Betfair Exchange, the simplest viable
cancel-rebet logic is:

> **Per pending unmatched bet, after lineup arrival (~T-60min): re-fetch
> latest odds + recompute model_probability with refreshed feature set
> (incl. lineup-aware features). If the new edge would NOT have qualified
> the bet at original placement time (i.e. recomputed
> opportunityScore < min_opportunity_score OR edge < min_edge_threshold),
> issue a cancelOrders call for the unmatched portion only.**

Properties:
- Conservative — only cancels when the bet wouldn't have been placed at all
  with current information. Doesn't try to predict or hedge; just exits.
- Bounded — only the unmatched portion. Matched portions ride to settlement.
- Free — cancelOrders on unmatched LIMIT bets has zero exchange cost.
- Reversible — if model prob recovers in the next cycle, a fresh placement
  can re-enter at current price.

Implementation cost when re-activated: ~2-3h (the trigger logic + a
single `cancelOrders` call wrapped in a daily-cap guard). No
`bet_cancel_proposals` table needed for this rule — the decision is
deterministic, not probabilistic.

## 0.2 What stays out of scope even at re-activation

- Lay-off hedging on already-matched bets (locks in realized PnL — separate
  product decision, requires explicit user approval each time)
- `replaceOrders`-style price improvements (chasing the line — different
  trading philosophy, not a defensive cancel)
- Cancellations during bet-delay window (rejected by Betfair API)

---

## (Original proposal preserved below for archival reference)

---

## 1. The opportunity

Lineups arrive ~T-60min before kickoff. Sharp money moves on lineup news.
For our pending bets at this moment, three states are possible:

1. **Edge confirmed by lineup** — Pinnacle's price has moved toward our pick.
   Our bet is locked at the better price. CLV positive. **No action needed.**

2. **Edge unchanged by lineup** — Pinnacle's price hasn't moved materially.
   Our bet thesis still holds. **No action needed.**

3. **Edge eroded or inverted by lineup** — Pinnacle's price has moved against
   our pick (drifted), often because a key player was missing. Our bet is
   locked at a price that no longer represents value. We may be holding a
   negative-EV position.

C3c addresses scenario 3 — when our pending real-stake bet has lost edge
between placement and lineup arrival, can we *cancel and reallocate* the
stake into a fresher opportunity at the new prices?

## 2. Why this is user-approval territory

Three reasons this is not autonomous:

1. **Cancelling a placed Betfair Exchange bet has real PnL impact.** If we
   placed at price 2.50 and the line is now 3.50, lay-off at the new price
   locks in a loss. The autonomous heuristic can't distinguish "this bet
   was always wrong" from "the market over-reacted to lineup news".

2. **Cancellation cadence affects our exchange relationship.** Frequent
   cancel-and-rebet cycles look like noise trading; market-makers may stop
   filling our quotes. Real-stake cancellations should be conservative.

3. **The £200 floor and drawdown circuit breakers** assume bets, once
   placed, are deterministic outcomes. Cancellation re-introduces capital
   to the available pool mid-cycle, which interacts with risk gates in
   ways the current code path doesn't model.

Per durable rule: "money guardrails (stakes, circuit breakers, bankroll
caps) are user-only and need explicit approval to change."

## 3. Proposed two-track design

### Track A — Shadow bets: auto-execute, no user gate
- Shadow bets are £0 stake. No capital at risk.
- After lineup capture, re-run value detection for the affected fixture.
- If new candidates emerge at the post-lineup prices, place them as
  fresh shadow bets with `lineup_triggered = true` flag.
- Existing pending shadow bets stay as-is. They'll settle on outcome.
- **No cancellation. Just additional capture.**

### Track B — Real-stake bets: propose, queue, require approval
- After lineup capture, for each pending real-stake bet:
  - Re-fetch latest Pinnacle/Betfair prices for the same selection.
  - Recompute model probability with refreshed feature set (incl.
    lineup-aware features once C3b expanded scope ships).
  - Compute *current* edge = model_prob - 1/current_back_odds.
- If current edge has flipped negative AND |delta_edge| > threshold (default 5%):
  - Write a row to `bet_cancel_proposals` table with rationale, current price,
    proposed action ("cancel" or "lay_off_partial").
  - Notify via dashboard / alert.
  - **Do not auto-execute.** User reviews and approves.
- On user approval (via dashboard endpoint or admin route):
  - Execute the lay-off / cancel via betfairLive.
  - Capture the resulting locked PnL into paper_bets.settlement_pnl.
  - Mark proposal status = `approved_executed`.

## 4. Schema additions

```sql
CREATE TABLE bet_cancel_proposals (
  id SERIAL PRIMARY KEY,
  paper_bet_id INTEGER NOT NULL REFERENCES paper_bets(id),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger TEXT NOT NULL,           -- 'lineup_arrival' | 'odds_drift' | etc.
  prior_model_prob NUMERIC(6,4) NOT NULL,
  current_model_prob NUMERIC(6,4) NOT NULL,
  prior_edge NUMERIC(6,4) NOT NULL,
  current_edge NUMERIC(6,4) NOT NULL,
  prior_back_odds NUMERIC(8,4) NOT NULL,
  current_back_odds NUMERIC(8,4) NOT NULL,
  proposed_action TEXT NOT NULL,   -- 'cancel' | 'lay_off_partial' | 'lay_off_full'
  estimated_pnl_impact NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved_executed' | 'denied' | 'expired'
  reviewed_at TIMESTAMPTZ,
  reviewer TEXT,
  notes TEXT
);
```

`paper_bets` additions:
- `lineup_triggered BOOLEAN NOT NULL DEFAULT FALSE` (C3 Track A flag)
- `lineup_review_completed_at TIMESTAMPTZ` (C3 Track B sentinel: per-bet
  re-evaluation has been recorded for this lineup arrival)

## 5. Triggering logic

After `capturePreKickoffLineups` successfully captures lineup for a match:

```
for each match where lineup just arrived:
  scope = pending bets on this match
  for each pending bet:
    if not yet reviewed_for_this_lineup:
      compute current_edge from latest odds_snapshots
      if current_edge < prior_edge - 0.05 AND current_edge < 0:
        if isShadowBet: log only (no cancellation needed)
        else: write to bet_cancel_proposals
      mark lineup_review_completed_at = NOW()
  re-run value detection for this match scope:
    new shadow candidates with lineup_triggered=true
    new real-stake candidates queued for normal dispatcher (no bypass)
```

## 6. Decision points for user review

Q1. Is the 5% delta-edge threshold the right trigger sensitivity? Tighter
    (e.g. 3%) catches more cases but generates more proposals. Looser
    (e.g. 10%) only catches significant moves.

Q2. Should we propose `lay_off_partial` (hedge half the stake) or only
    full cancellation? Partial preserves optionality; full reduces
    operational complexity.

Q3. Approval workflow:
    (a) Dashboard widget showing pending proposals with one-click
        approve/deny — fastest UX.
    (b) Email/Slack notification with deep-link — works async.
    (c) Auto-approve after N hours if user inactive — risky.

Q4. Daily cap on cancel-and-rebet actions — say 20/day max, even with
    approval. Prevents runaway behaviour during a heavy-fixture day.

Q5. Should this also fire on **odds drift without lineup arrival**?
    e.g. if Pinnacle's price moves 10% in a 30min window before any
    lineup news, the market knows something. Same review trigger.

## 7. Implementation effort estimate

- Schema + migrations: 1h
- bet_cancel_proposals write logic in apiFootball:capturePreKickoffLineups
  (post-capture hook): 2h
- Per-bet edge recomputation logic: 2h
- Dashboard endpoint for proposal review + approve/deny: 2h
- Lay-off execution path through betfairLive: 3h
- Testing + canary diff: 2h

Total: ~12h. Recommend phasing as C3c.1 (Track A — shadow auto-execute,
~3h), C3c.2 (proposal-only, no execution — ~4h), C3c.3 (execution after
1 week of proposal-only data — ~5h).

## 8. What I need from Chris before any code lands

1. **Approve overall direction** — Track A (shadow auto), Track B (propose+
   approve) split.
2. **Decision on Q1-Q5** above.
3. **Approval gate path** — dashboard, email, or both.
4. **Phasing** — ship all together, or C3c.1 first then re-evaluate.

Once these are answered, I'll produce a tightly-scoped implementation
plan per phase with file:line edits and ship one phase at a time.
