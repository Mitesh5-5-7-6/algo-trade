# Phase 1 Design — Historical Market Data

**Status:** Design, not implemented
**Phase:** 1 of [RND_RESEARCH_SPECIFICATION.md §4](../architecture/RND_RESEARCH_SPECIFICATION.md)
**Governed by:** [ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md)
**Closes:** [CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §3.1, §3.2, §3.3

**Implementation target:** introduce historical 5-minute market-data ingestion and establish the canonical research candle dataset, with provenance, so that a named trading day can be reconstructed from storage.

No code is written by this document. It states the decisions an implementation must follow, and names the questions it must not answer by guessing.

---

## 1. Scope

### In

| Item                                                             | Gap closed |
| ---------------------------------------------------------------- | ---------- |
| A history port on the broker layer, with a FYERS implementation  | §3.1       |
| `source` provenance on the candle record, with a precedence rule | §3.3       |
| A date-range candle query                                        | §3.2       |
| A trading-calendar helper for enumerating real trading days      | —          |
| A backfill job and an operator-triggered entry point             | §3.1       |
| Validation, rejection accounting, and idempotent re-runs         | —          |

### Out

- The completed Trade entity (Phase 2).
- Exit-model completeness (Phase 3).
- Parameterising the golden pipeline to consume this data (Phase 4).
- Any pattern, statistic or research record (Phases 5+).
- Tick-level history. [ARCHITECTURE_DECISION §10.3](../architecture/ARCHITECTURE_DECISION.md) defers it to proven need.

### Prerequisite — the aggregator flush fix ships first

The aggregator is never flushed at session close ([CURRENT_STATE §5.1](../architecture/CURRENT_STATE.md)), so the final partial bar of every session is missing from storage and open bars carry across days in memory.

**This is a hard prerequisite, not an adjacent task.** Backfilling over a still-broken aggregator creates two data-quality problems at once, in the same collection, where each masks the other: the missing bar is silently filled by broker data, and any live-vs-historical discrepancy becomes impossible to attribute to its cause. The fix belongs to [Phase 0](../architecture/RND_RESEARCH_SPECIFICATION.md), is its own change, and lands before the first production backfill.

Sequencing:

```
Verify repo → Fix aggregator flush → Phase 1 ingestion
→ Validate historical + live candle coexistence
```

Implementing the fix is outside this design. Depending on it is not — §9 point 5 is the acceptance check that the two sources coexist correctly, and it is only meaningful once the flush is repaired.

---

## 2. Where ingestion runs, and why

[ARCHITECTURE_DECISION §13.1](../architecture/ARCHITECTURE_DECISION.md) makes FYERS reachable only from behind the Live broker adapter. Historical ingestion needs FYERS data access, so:

```
Trading deployment (holds FYERS credentials)
        │
        ▼
  Historical backfill job  ──writes──▶  candles collection
                                             │
                                             ▼
                                    R&D reads from Mongo
                                    R&D never calls FYERS
```

R&D consumes normalised candles from storage, exactly as [§10.3](../architecture/ARCHITECTURE_DECISION.md) already specifies for live data. This preserves the boundary without giving the research platform a broker.

### 2.1 A precision correction already applied to the ADR

[ARCHITECTURE_DECISION §13.1](../architecture/ARCHITECTURE_DECISION.md) originally stated the boundary as `Paper --✗--> FYERS`, absolutely. That was stricter than both this design and the running system: [apps/api/src/composition-root.ts](../../apps/api/src/composition-root.ts) deliberately builds a hybrid in paper mode — live FYERS **market data** spliced onto paper **execution** — and that hybrid is correct and intentional.

The boundary that matters is **order placement**, not all FYERS contact, which is what §8.1 already said by scoping the rule to "FYERS order credentials". §13.1 has been amended to match: order placement is walled off absolutely, read-only market data is permitted inside the trading deployment, and R&D stays walled off in both directions.

---

## 3. The FYERS history endpoint

Confirmed against the vendor's own client (`fyers-api-v3@2.1.0`), not inferred: `apiService.js` `getHistory` builds `Config.data_Api1 + Config["history"]`, where `data_Api1` is `https://api-t1.fyers.in/data` and `history` is `/history`.

```
GET https://api-t1.fyers.in/data/history?<params>

Headers
  Authorization: <appId>:<accessToken>
  version:       3
```

| Param         | Value                                        |
| ------------- | -------------------------------------------- |
| `symbol`      | FYERS symbol, e.g. `NSE:NIFTY50-INDEX`       |
| `resolution`  | `"1"`, `"5"`, `"15"`, `"30"`, `"60"`, `"1D"` |
| `date_format` | `"0"` epoch seconds, `"1"` `YYYY-MM-DD`      |
| `range_from`  | start, in the chosen format                  |
| `range_to`    | end, in the chosen format                    |
| `cont_flag`   | `"1"` for a continuous series                |

Response:

```json
{ "s": "ok", "candles": [[ts, open, high, low, close, volume], ...] }
```

`ts` is **epoch seconds** and marks the **start** of the interval — the same convention as the internal aggregator, which buckets by `floor(ts / intervalMs) * intervalMs`. Internal storage is epoch **milliseconds**, so ingestion multiplies by 1000.

### 3.1 What must be verified against the live API before coding

These are not guessable and must not be assumed:

1. **Maximum range per request.** Community sources report ~100 days per call; the exact cap per resolution is unconfirmed. The implementation pages regardless (§7.2) — confirm the real window and set the page size from it.
2. **How far back 5-minute history is retained.**
3. **Data-API rate limits** (per second / minute / day), which set the delay in §7.2.
4. **Index volume.** NSE index symbols are widely reported to return zero or meaningless volume. Confirm empirically, because [ARCHITECTURE_DECISION §20.2](../architecture/ARCHITECTURE_DECISION.md) forbids volume-based conclusions where volume is not real, and D2's deferred `volumeAvailable` / `volumeSource` / `volumeQuality` fields depend on the answer.
5. **Behaviour on a holiday or non-trading range** — empty `candles`, an error, or `s: "no_data"`.

Record the answers in this document when they are established.

---

## 4. Design decisions

### D1 — History is a separate port, not a `Broker` method

**Decision:** add a new interface in `packages/broker`, implemented by `FyersBroker`; do **not** widen `Broker`.

```ts
// packages/broker/src/history-provider.ts
export interface HistoryProvider {
  getHistory(req: HistoryRequest): Promise<HistoryResult>;
}
```

**Why not add it to `Broker`:** the contract's two duties are execution and the realtime feed, each with a named consumer ([packages/broker/src/broker.ts](../../packages/broker/src/broker.ts)). Historical fetch has neither — the Order Manager and Market Data Engine never call it. Adding it forces `PaperBroker` and `ScriptedFakeBroker` to implement a method they cannot meaningfully answer, and the honest implementations would be a throw and a stub. A capability interface keeps `Broker` truthful and lets the backfill job depend on exactly what it needs.

`FyersBroker` implements both. The composition root supplies the history provider only where a real one exists; the backfill job requires a non-null provider and refuses to start without one, rather than silently producing nothing.

### D2 — Candle provenance is additive and backward compatible

**Decision:** extend `CandleSchema` ([packages/core/src/market.ts](../../packages/core/src/market.ts)) with a defaulted source and ingestion metadata.

```ts
export const CandleSourceSchema = z.enum([
  "LIVE_TICK",
  "BROKER_HISTORICAL",
  "REPLAY",
  "IMPORTED_DATA",
]);

export const CandleSchema = z.object({
  // … existing fields unchanged …
  source: CandleSourceSchema.default("LIVE_TICK"),
  ingestedAt: TimestampSchema.optional(),
  ingestionVersion: z.number().int().positive().optional(),
});
```

**The default is load-bearing.** [CandlesRepository.loadRecent](../../packages/db/src/candles-repository.ts) runs `CandleSchema.parse` on every document it reads. Every candle already in Mongo lacks `source`; a required field would make indicator warm-up throw on the first read after deploy. `.default("LIVE_TICK")` is also factually correct — every existing bar came from tick aggregation, because no other producer has ever existed.

`volumeAvailable` / `volumeSource` / `volumeQuality` from [ARCHITECTURE_DECISION §20.2](../architecture/ARCHITECTURE_DECISION.md) are deliberately **not** added here. They depend on question 4 in §3.1 and belong with the first index backfill, not with the schema change.

### D3 — Source precedence governs the upsert

**The invariant this decision protects:**

> One `(symbol, interval, ts)` represents one canonical candle, regardless of whether it originated from live ticks or historical data.

Provenance records **where the bar came from**. It never creates a second bar. Every decision below follows from holding that line, and the coexistence check in §9 point 5 exists to prove it holds in practice.

The storage key is unique on `(symbol, interval, ts)` ([packages/db/src/collections.ts](../../packages/db/src/collections.ts)), and today's `upsert` is an unconditional `$set`. Once two producers exist, a backfill and the live aggregator will write the same bar, and whichever ran last would win by accident.

**Decision:** rank the sources and let a write proceed only when it does not demote the stored bar.

| Source              | Rank | Reasoning                                     |
| ------------------- | ---- | --------------------------------------------- |
| `BROKER_HISTORICAL` | 3    | The exchange's own consolidated record        |
| `IMPORTED_DATA`     | 2    | Vetted third-party, deliberately loaded       |
| `LIVE_TICK`         | 1    | Our aggregation of a feed that can drop ticks |
| `REPLAY`            | 0    | Never written to this collection at all       |

```ts
await collection.updateOne(
  { symbol, interval, ts, sourceRank: { $lte: rank } },
  { $set: { ...doc, sourceRank: rank } },
  { upsert: true },
);
```

**Rejected alternative:** adding `source` to the unique key. It breaks the invariant directly — two rows for one bar — and every reader (indicator warm-up, candle-window seeding, future replay) would have to decide which is real on every query, forever, with no guarantee they decide alike.

`sourceRank` is stored denormalised so the conditional is a pure index-supported predicate rather than an application-side read-then-write race.

**Consequence to accept knowingly:** a backfill permanently overwrites live-aggregated bars for the same minute. That is the intent — the broker's record is better than ours — but it also means the flush bug becomes unobservable after the first backfill of an affected day. This is precisely why §1 makes the flush fix a Phase 0 prerequisite rather than a parallel task.

### D4 — Date-range query, no new index

**Decision:** add one method. The existing unique index `{symbol: 1, interval: 1, ts: 1}` is a covering prefix for this query; no schema change to the index is needed.

```ts
async findRange(
  symbol: string,
  interval: CandleInterval,
  fromTs: number,   // inclusive, epoch ms
  toTs: number,     // exclusive, epoch ms
): Promise<Candle[]>   // oldest → newest
```

Half-open `[from, to)` so that consecutive day requests tile without overlap or duplication. This is the method Phase 4 replay will call to ask for "a trading day", which `loadRecent(limit)` structurally cannot answer.

### D5 — Trading days come from the session calendar, never from the date arithmetic

**Decision:** extract a trading-day enumerator beside the existing session logic in [packages/engines/src/market-data/session-manager.ts](../../packages/engines/src/market-data/session-manager.ts), reusing `istDateKey`, `startOfDayIST` and the holiday set that `SessionManager` already holds.

```ts
export function tradingDaysBetween(
  fromTs: number,
  toTs: number,
  holidays: ReadonlySet<string>,
): string[]; // "YYYY-MM-DD" IST, weekends and holidays removed
```

Holidays come from `marketHolidays` in the global settings document ([packages/db/src/settings-repository.ts](../../packages/db/src/settings-repository.ts)) — the same source the live session manager uses, so backfill and live trading cannot disagree about whether a day existed.

**Why this matters more than it looks.** Without it, a closed market is indistinguishable from a failed fetch: both yield zero candles. The job would log gaps for every Diwali and every Saturday, and a genuinely missing day would be lost in the noise. It is also rule 5 of [RND_RESEARCH_SPECIFICATION §5.5](../architecture/RND_RESEARCH_SPECIFICATION.md) arriving at its first real use.

### D6 — The job is explicit and operator-triggered

**Decision:** no automatic backfill at boot. A boot-time fetch would make startup depend on a third-party API and could silently rewrite history on every restart — and [ARCHITECTURE_DECISION §46](../architecture/ARCHITECTURE_DECISION.md) already separates being alive from being ready to trade.

Three entry points, in the order they should be built:

1. `apps/api/src/jobs/historical-backfill.ts` — the job module, following the shape of the existing [token-lifecycle](../../apps/api/src/jobs/token-lifecycle.ts) job.
2. `scripts/backfill-candles.ts` — a CLI for the first real ingestion, alongside the existing `scripts/chaos-drill.ts` convention. This is what runs to produce the first research dataset.
3. A control-plane route, behind the same step-up authentication as `PATCH /settings`, only once the CLI has proven the job.

The job is a pure function of `(symbol, interval, fromDate, toDate)` and is safely re-runnable: idempotent by D3, and re-running a completed range is a no-op that rewrites identical values.

---

## 5. Validation

A bar is rejected, never stored, and counted, if any of these holds:

| Check                                                 | Rationale                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `high < low`                                          | Impossible; indicates a mangled row                          |
| `high < max(open, close)` or `low > min(open, close)` | Internally inconsistent OHLC                                 |
| any price `<= 0`                                      | Not a tradeable price                                        |
| `volume < 0`                                          | Corrupt                                                      |
| `ts` not aligned to the interval boundary             | Would create a phantom bucket the aggregator can never match |
| `ts` outside the session window for its IST date      | A bar that could not have traded                             |
| `ts` on a non-trading day                             | Calendar disagreement worth surfacing, not absorbing         |

Rejections are summarised per run — count, first few examples, and the reason — and the run reports them as a result, not a log line. A backfill that silently discarded 4% of its bars is worse than one that failed.

**Never repair a bad bar by interpolation.** [RND_RESEARCH_SPECIFICATION §5.7](../architecture/RND_RESEARCH_SPECIFICATION.md) treats stored candles as evidence; an invented bar is evidence of nothing and cannot be distinguished later from a real one.

---

## 6. Interfaces

```ts
// packages/broker/src/history-provider.ts

export interface HistoryRequest {
  symbol: string;
  interval: CandleInterval;
  /** Inclusive, epoch ms. */
  fromTs: number;
  /** Exclusive, epoch ms. */
  toTs: number;
}

export interface HistoryResult {
  candles: readonly Candle[]; // source already stamped BROKER_HISTORICAL
  /** Bars the provider returned but validation refused. */
  rejected: readonly HistoryRejection[];
  /** True when the provider signalled no data rather than an error. */
  empty: boolean;
}

export interface HistoryRejection {
  ts: number;
  reason: string;
  raw: readonly number[];
}

export interface HistoryProvider {
  getHistory(req: HistoryRequest): Promise<HistoryResult>;
}
```

```ts
// apps/api/src/jobs/historical-backfill.ts

export interface BackfillRequest {
  symbols: readonly string[];
  interval: CandleInterval;
  fromDate: string; // "YYYY-MM-DD" IST, inclusive
  toDate: string; // "YYYY-MM-DD" IST, inclusive
}

export interface BackfillReport {
  requestedTradingDays: number;
  perSymbol: ReadonlyMap<
    string,
    {
      stored: number;
      rejected: number;
      daysWithNoData: readonly string[];
      pagesFetched: number;
    }
  >;
  startedAt: number;
  finishedAt: number;
}
```

The job returns a report. It does not decide what the report means.

---

## 7. Execution behaviour

### 7.1 Ordering

Oldest range first, one symbol at a time. A partial run then leaves a contiguous prefix of history rather than a scatter of fragments, and re-running resumes cleanly.

### 7.2 Paging and rate limits

Requests are chunked to the confirmed maximum window (§3.1 question 1) and issued **sequentially**, never concurrently, with a fixed delay between calls. Historical backfill is not latency-sensitive and shares a rate-limit budget with live trading — the existing optional `checkRateLimit` hook on `FyersBrokerDeps` ([packages/broker/src/fyers-broker.ts](../../packages/broker/src/fyers-broker.ts)) is the intended seam.

A backfill must never be able to rate-limit the live order path. If that guarantee cannot be made from inside the trading process, the job moves to its own process before it runs against a full symbol list.

### 7.3 Failure

A failed page fails its range and is reported; it does not abort the whole run, and it does not retry indefinitely. Bounded retry with backoff on transport errors; no retry on an authentication or malformed-request error, which will not improve by repetition.

---

## 8. Test plan

| Level               | Test                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                | `tradingDaysBetween` — weekends removed, holidays removed, IST boundaries at month and year ends, empty range, reversed range                                                                  |
| Unit                | Validation — one case per row of §5, each asserting rejection rather than storage                                                                                                              |
| Unit                | FYERS response mapping — seconds→ms, row order `[ts,o,h,l,c,v]`, empty `candles`, `s != "ok"`                                                                                                  |
| Unit                | Paging — a range wider than one window issues the right number of sequential calls with no gap and no overlap                                                                                  |
| Integration (Mongo) | D3 precedence: `LIVE_TICK` then `BROKER_HISTORICAL` overwrites; `BROKER_HISTORICAL` then `LIVE_TICK` does **not**; equal rank overwrites; one document per `(symbol, interval, ts)` throughout |
| Integration (Mongo) | `findRange` — half-open boundaries, ordering, empty range                                                                                                                                      |
| Regression          | A candle document written before this change still parses, and `loadRecent` returns it with `source: "LIVE_TICK"`                                                                              |
| Golden              | The existing golden pipeline still produces a byte-identical `golden-record.json`                                                                                                              |

The precedence and backward-compatibility tests are the two that protect against silent data loss. Neither is optional.

---

## 9. Verification

The design is proven when, against a real token:

1. One symbol, one known trading day, 5-minute resolution, backfilled from an empty collection.
2. `findRange` returns exactly 75 bars for a regular NSE session (09:15–15:30), all with `source: "BROKER_HISTORICAL"`.
3. The same run repeated changes nothing — same document count, same values.
4. A range spanning a known holiday reports that day under `daysWithNoData` and does not treat it as a failure.
5. **Historical and live candle coexistence.** A range spanning a day already covered by live aggregation shows those bars upgraded to `BROKER_HISTORICAL`, with the document count unchanged — no duplicate bars, no orphaned `LIVE_TICK` rows at the same `ts`, and the session's final bar present from both sources rather than only from the backfill.
6. `pnpm typecheck`, `pnpm test` and `pnpm build` pass, and the golden record is unchanged.

Point 2 is the real acceptance criterion: it is the first moment a named trading day can be reconstructed from storage, which is what every later phase stands on.

Point 5 is the one that only works in the right order. Run against an unflushed aggregator, it cannot distinguish "the backfill correctly upgraded a bar" from "the backfill invented a bar we never recorded" — which is the whole argument for §1.

---

## 10. Open questions

Seven questions remain open. **Do not invent answers.** Each must be settled before implementation, not discovered during it. A plausible-looking guess here produces a dataset that is quietly wrong, and every phase downstream inherits it.

### 10.1 Vendor verification — answer against the live API

Five questions the vendor client cannot answer. Each needs one real call with a real token.

| #   | Question                                         | Sets                                                                               |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Maximum range per request, per resolution        | The page size in §7.2                                                              |
| 2   | How far back 5-minute history is retained        | The floor on question 7                                                            |
| 3   | Data-API rate limits (per second / minute / day) | The inter-call delay in §7.2, and whether the job needs its own process            |
| 4   | Whether index volume is real or always zero      | D2's deferred `volumeAvailable` / `volumeSource` / `volumeQuality` fields          |
| 5   | Behaviour on a holiday or non-trading range      | Whether `daysWithNoData` is driven by empty `candles`, an error, or `s: "no_data"` |

Record the answers in §3 when established, and mark §3.1 resolved.

Question 3 carries a decision with it: §7.2 accepts a shared rate-limit budget only if the live order path is provably unaffected. If the measured limits cannot guarantee that, the backfill moves to its own process before it runs against a full symbol list.

### 10.2 Project sequencing — decide before Phase 1 implementation

Two decisions that are nobody's default:

| #   | Question           | Notes                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6   | **Which symbols?** | Index-only, or index plus the breadth basket already in global settings ([settings-repository.ts](../../packages/db/src/settings-repository.ts) `indexSymbols`, `breadthSymbols`)? Derivatives pull in the F&O continuity rule ([RND_RESEARCH_SPECIFICATION §5.6](../architecture/RND_RESEARCH_SPECIFICATION.md)) and should not be first. |
| 7   | **How far back?**  | Bounded above by question 2. One year gives roughly 250 trading days and ~18,750 five-minute bars per symbol — enough for daily and weekly research, thin for quarterly regime comparison.                                                                                                                                                 |

### 10.3 Resolved

- **Does the flush fix ship first?** Yes. It is a Phase 0 prerequisite — §1.
- **§2.1's ADR correction** — applied.

---

## Related documents

- [../architecture/ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md)
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) — Phase 1 sits in §4
- [../architecture/CURRENT_STATE.md](../architecture/CURRENT_STATE.md) — gaps §3.1, §3.2, §3.3, §5.1
