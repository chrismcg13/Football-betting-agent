# Backlog — Parked Tickets

## TICKET-001 — Pre-kickoff Pinnacle cron coverage gap (parked 2026-04-19)

**Origin:** §7 CLV diagnostic, scope v3 follow-up. Surfaced when 95 of 96 missing-CLV
matches turned out to have a Pinnacle snapshot somewhere in their history but none
within ±15 min of kickoff.

**Investigation questions (all read-only first):**

1. Why did the pre-kickoff Pinnacle cron miss snapshots within ±15 min of kickoff
   for 95 of 96 matches in the missing-CLV sample (last 30d)?
   Hypotheses to test:
   - API-Football daily call-budget exhaustion before the T-15/T-5 buckets fire
   - Fixture-mapping miss (cron runs but match isn't in the mapping table at that moment)
   - Scheduler priority / lock contention with the 5-min multi-snapshot cron
   - Pinnacle simply not offering a price for the match at T-15

2. What is the actual cost of widening the closing-line capture window from
   ±5 min to ±15 min? Quantify:
   - How many additional bets would be captured (recompute (a) bucket totals at ±15)
   - How much CLV signal degrades (compare snapshots at T-5 vs T-15 for matches
     where both exist — is the price meaningfully different?)
   - Decision: tighten the cron, widen the window, or both

**Scope boundary:** read-only diagnostic first. No schedule changes, no window
changes, no backfills until numbers are on the table.

**Dependencies:** none. Can run independently of league-whitelist work.

**Not started.** Defer to next session.

---

## Standing methodology rule (effective 2026-04-19)

Every numerical finding in any report MUST be accompanied by the SQL query that
produced it, inline in the response, BEFORE the number. No exceptions.

Triggered after two material numerical corrections in successive sessions:
- 81.7% → 53.6% (in-league Pinnacle coverage; union vs intersection)
- 17pp → 9pp (won-vs-lost CLV capture gap)

---

## Promotion-engine block (effective 2026-04-19)

No experiment → candidate → promoted progression for ANY tag until:
- Captured-bet sample reaches ≥200 across MO+OU25
- CLV-by-experiment-tag broken down won vs lost is reviewed
- Tags showing systematic "win against the line, lose with it" pattern are
  flagged for demotion regardless of headline ROI

Trigger: §7 (c) finding of reverse-survivorship signature on n=63 captured bets
(winners CLV −5.07%, losers CLV +1.71% across all markets; persists in MO+OU25
clean subset at −2.15% won vs +4.12% lost).
