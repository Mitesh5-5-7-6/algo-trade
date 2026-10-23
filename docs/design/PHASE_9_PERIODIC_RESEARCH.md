# Phase 9 — Weekly / monthly / quarterly research

**Status: see [PLAN.md](../PLAN.md) §14.** Phase 9 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §14 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 9, §5.5 (trading calendar), §5.8 (data revision) and §6.1 (one
`research_reports` collection, told apart by `period`) for research
behaviour.

---

## 1. Goal

> Aggregate daily evidence. Weekly: find recurring behaviour. Monthly: find
> persistent weaknesses and opportunities. Quarterly: check whether findings
> survive different market regimes. All windows use the trading calendar.

The spec's questions, per window:

| Window    | Questions                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly    | Which patterns recurred? Which strategies worked with them? Which failed repeatedly, and under what conditions? Do findings repeat across days? |
| Monthly   | Which weaknesses recur? Which patterns were most profitable? Which caused the largest losses? Did behaviour change across regimes?              |
| Quarterly | Are monthly findings still valid across regimes? Are they robust or overfit?                                                                    |

These are observations with sample sizes, aggregated from Phase 8's daily
reports. Whether one is evidence is Phase 7's question; a window report
names what deserves a hypothesis, it never registers one.

---

## 2. What exists

### 2.1 Nothing to port

No branch carries periodic-research code. Phase 9 is built on Phase 8's
daily reports.

### 2.2 The finding — no trading calendar is configured anywhere

Spec §5.5: windows are resolved against `marketHolidays` in the global
settings, "never raw calendar timestamps". **Neither the trading database
nor the research database holds a settings document with a holiday list.**
The stored year has 261 weekdays, 247 sessions with bars, 15 weekdays
without bars and one weekend date with them (the Budget Sunday,
2026-02-01). Those 15 look like NSE holidays — 2 October, Diwali, 25
December, 26 January, Holi — but "no bars, so it was a holiday" is exactly
the inference §5.5 forbids: it would hide every real data gap inside the
holiday list. See §5, finding F1.

---

## 3. Design decisions

### D1 — Windows are built from a declared calendar

A calendar is `{ holidays, specialSessions, source }` — from the global
settings, or declared explicitly with its source named. Trading weeks
(Monday–Sunday, `2026-W10`), months (`2026-03`) and quarters (calendar,
`2026-Q1`) are the calendar's trading days in those spans: a week holding a
holiday has four days, and a Budget Sunday belongs to its week. The calendar
and its fingerprint are on every window report.

### D2 — Coverage: the calendar and the data must agree, or say where they do not

A window lists its expected trading days, the days it has daily reports
for, **gaps** — expected, but unreported (no bars, or not yet researched) —
and **unexpected** days — reported, but the calendar says closed. A window
with a gap is reported with the gap, never as a shorter window: an
aggregation that silently assumes five days, or four, is wrong in a way
that is very hard to see (§5.5).

### D3 — One aggregation, every window

Pooled across instruments and days, from the newest version of each daily
report: per (pattern, strategy), per (pattern, strategy, regime), per
strategy, and per **condition** — a Trade's strategy, its entry regime and
the patterns that preceded it (Phase 8 D2). Each row carries `n`,
wins, net, expectancy, charges and slippage, and **day-level
consistency**: on how many days it occurred, traded, made and lost money.

### D4 — Each window answers its own questions

`PERIODIC_RESEARCH_VERSION` 1, with its thresholds on the report:

- **Week — recurring behaviour.** A (pattern, strategy) pair _recurred_ if it
  occurred on at least 60% of the week's trading days; a strategy _failed
  repeatedly_ with a pattern if it lost money on it on two or more days and
  in total.
- **Month — weaknesses and opportunities.** Conditions with at least 10
  Trades, ranked by total net: the costliest are _weaknesses_, the best
  _opportunities_; the most profitable and most costly patterns; whether a
  strategy's expectancy changed sign between regimes.
- **Quarter — survival across regimes.** A (pattern, strategy) pair
  _survives_ when every regime holding at least 10 of its Trades shows the
  same sign of expectancy, and its month-by-month expectancy keeps that sign
  — otherwise it is _regime-dependent_ or _unstable_, and says which.

Every answer carries its `n`; none is a finding until Phase 7 says so.

### D5 — A window report says what it read, and is never edited

It records the id and fingerprint of every daily report it aggregated. When
one of them is superseded by a newer version (Phase 8 D5), the window is
stale and is recomputed as its next version beside the old — so one revised
bar reaches its days, then their week, month and quarter, and nothing else.
Kept in `research_reports` with `period` `WEEK`, `MONTH` or `QUARTER`.

### D6 — It runs itself, after the daily research

One idempotent operation: every **complete** window — all its calendar
trading days closed — without a report, and, asked to, every stale one. A
CLI for the same scheduler as Phase 8, research database only.

---

## 4. Proposed task order

| ID  | Task                                                                                                                                          | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 9.1 | Trading-calendar windows from a declared calendar; coverage — gaps and unexpected days (D1, D2)                                               | —          |
| 9.2 | One aggregation over daily reports: pattern × strategy × regime, strategy, condition; day-level consistency (D3)                              | 9.1        |
| 9.3 | The questions: weekly recurrence, monthly weaknesses and opportunities, quarterly survival (D4)                                               | 9.2        |
| 9.4 | The window report: daily reports it read, versioned, kept in `research_reports`; staleness (D5)                                               | 9.3        |
| 9.5 | Every complete, unreported window, automatically and idempotently; CLI (D6)                                                                   | 9.4        |
| 9.6 | Acceptance: the real year's weeks, months and quarters under the exchange's published calendar; a daily revision reaching exactly its windows | 9.5        |

---

## 5. Findings outside this phase

| #   | Finding                                                                                                                                                                                                                                                     | Owner      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| F1  | No `marketHolidays` is configured in any settings document. The live Session Manager therefore believes every weekday is a trading day — the failure the settings schema's own comment describes — and research has no calendar to resolve windows against. | operations |

---

## 6. Done when

Every complete week, month and quarter of the stored year has a report
built from the exchange's trading calendar — coverage stated, gaps named,
each answer carrying its `n` — produced by one command that adds nothing
when run again; and a revised daily report recomputes exactly the windows
that read it, as new versions beside the old.

---

## 7. Acceptance (task 9.6)

The real year's bars copied to a scratch database (the research database
stays read-only), researched day by day (Phase 8: 494 reports, 59 s), then
by window through `scripts/periodic-research.mts` at `0205981`.

**The calendar.** `apps/api/scripts/calendars/nse-2025-26.json`: the NSE
equity holidays for 2025 (from 29 September) and 2026 as the brokers
publish them — NSE's own circular was not reachable, and the file says so
— with the Budget Sunday (2026-02-01) and the 2026 Muhurat Sunday as
special sessions. 2025-10-21, Diwali Laxmi Pujan, is _not_ a holiday in
it: the stored data holds 13 bars that day, 13:45–14:45 IST, the Muhurat
session. Asked for the settings calendar instead, the CLI refused: no
`marketHolidays` (F1).

| Run                                                                              |                                        Reported |                                  Recomputed | Current |
| -------------------------------------------------------------------------------- | ----------------------------------------------: | ------------------------------------------: | ------: |
| 1 — the year                                                                     | **71** (53 weeks, 13 months, 5 quarters), 6.9 s |                                           0 |       0 |
| 2 — again                                                                        |                                               0 |                                           0 |      71 |
| — one NIFTY bar on 2026-03-02 revised; the daily run recomputes its 10 reports — |                                                 |                                             |         |
| 3 — with `--recompute-stale`                                                     |                                               0 | **4**: 2026-W10, 2026-W11, 2026-03, 2026-Q1 |      67 |
| 4 — again                                                                        |                                               0 |                                           0 |      71 |

- **Coverage: the published calendar and the stored data agree on every
  day.** Every window inside the data is clean. The only gaps are the
  dataset's own edges — September 2025 before the 29th, and 29 September –
  1 October 2026 after its end — named in the windows that hold them.
- **And without a calendar:** built, not kept, the same 53 weeks would show
  19 gap days — the 15 holidays and the four days past the data's end — and
  the Budget Sunday as _unexpected_. That is the failure §5.5 describes,
  made visible rather than silent.
- **Exactly the windows a revision reaches:** the revised day's five daily
  reports fall in weeks 10 and 11, March and Q1, and nothing else was
  recomputed.
- `pnpm test:integration`, strict: 1,392 tests, 0 skipped.

What the windows say, before any statistics. **Week 2026-W10** (four
sessions; Holi closed): all three patterns recurred on all four days;
ORB lost on its ORB_BREAKOUT Trades on four days of four (10 Trades,
−4,288) and RSI on RSI_REVERSION on three (11, −2,210) — _failed
repeatedly_. **March 2026**: the costliest condition was RSI after an
RSI_REVERSION in a BEARISH regime (51 Trades, −152.5 a Trade); no
strategy's expectancy changed sign between regimes. **Quarters**:
EMA_CROSSOVER and ORB on their own patterns SURVIVE in 2025-Q4, 2026-Q1
and 2026-Q3 — they lose in every regime and every month; RSI is
INSUFFICIENT in every quarter, because it trades almost only in a BEARISH
regime and one regime cannot show survival across regimes.

The first acceptance run's weekly answer listed a pattern once per
strategy, including strategies that never touched it; recurrence was
restructured per pattern (`0de8fd6`) and the acceptance redone.

**Still standing:**

| #   | Limit                                                                                                                                                                                                                                     | Owner       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| P1  | F1: no `marketHolidays` in any settings document — the live Session Manager still believes every weekday is a trading day. The calendar file is the research's input; configuring settings from it is an operational step, not done here. | operations  |
| P2  | The calendar's source is broker-published lists that agree with each other and with the stored data; NSE's circular was not reached.                                                                                                      | operations  |
| P3  | Settings carry no special sessions (Phase 4 R2); only a declared calendar file can.                                                                                                                                                       | later       |
| P4  | Windows are calendar quarters, not the Indian financial year's.                                                                                                                                                                           | by design   |
| P5  | Thresholds (60%, two days, ten Trades, five a month) are declared, not derived; every report carries them so a reader can disagree.                                                                                                       | by design   |
| P6  | Nothing schedules the CLI (Phase 8 L1), and the windows pool instruments — a per-instrument view is the daily reports'.                                                                                                                   | R&D runtime |

## Related documents

- [../PLAN.md](../PLAN.md) §14
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 9, §5.5
- [PHASE_8_DAILY_RESEARCH.md](PHASE_8_DAILY_RESEARCH.md) — the daily reports aggregated here
- [PHASE_1_HISTORICAL_DATA.md](PHASE_1_HISTORICAL_DATA.md) — MARKET_CLOSED, DATA_MISSING and API_FAILURE, never merged
