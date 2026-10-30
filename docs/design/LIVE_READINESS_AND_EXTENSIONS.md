# Live readiness and extensions — Phase 15 readiness, Phases 16–20

**Status: see [PLAN.md](../PLAN.md) §20 and §30–§34.** The task boards live
there and nowhere else. This document holds the decisions those tasks
implement and names the questions they must not answer by guessing.

Authorities: [PLAN.md](../PLAN.md) for order;
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §13
(security and Live gates), §15 (broker contract), §16 (reconciliation), §19
(health and readiness), §20 (F&O sizing), §21 (notifications);
[CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §5 for the defects
still standing.

---

## 1. Why this document exists

Two inputs, both dated 2026-10-30:

1. **An architecture audit of the working branch at `478a1ad`.** It found
   defects on the paper and Live paths, and a Live broker path much narrower
   than the architecture requires. The defects that change paper behaviour
   are Phase 14 tasks 14.8–14.12; the rest are Phase 15 readiness.
2. **A review of `jakeschincariol/day-trader-skill`** (commit `3d0f4ef`),
   eleven Claude Code skills for discretionary US day trading. Its useful
   ideas are adopted here, rebuilt for NSE/BSE and FYERS. §9 lists what is
   deliberately not adopted.

Everything in this document is built inside the existing packages. No new
service, framework or second engine is introduced (PLAN §24).

---

## 2. Sequencing

### 2.1 Main line and tracks

The **main line** is Phase 14 → Phase 15, unchanged: paper validation, then
Live readiness, then promotion.

Phases 16–20 are **tracks**. Each names its dependency, and none of them
changes what the trading path decides. A track task may be taken up when its
dependency is complete **and** the main line is either finished with its
current task or waiting on calendar time (14.7's five live sessions).

Two rules carry over without exception:

- **One task is actively implemented at a time** (PLAN §25), across the main
  line and every track together.
- **The main line has priority.** A track never delays a main-line task that
  is ready to start.

### 2.2 Recommended order

```text
1. 14.9 → 14.10 → 14.11 → 14.12           main line: defects that change paper behaviour
2. 16.1 → 16.6                            Telegram, so 14.7's sessions are watched
3. 14.7                                   five live paper sessions (calendar time)
     while waiting between sessions: 17.x (setup odds), 19.x (operator skills)
4. 15.1 → 15.23                           Live readiness, one at a time; probes (15.22) early
5. 18.x                                   scanner — after 15.2, 15.6, 15.12
6. 20.x                                   corporate announcements — after 20.1's verification
7. 15.24                                  promotion — when a candidate passes Phases 13 and 14
```

Telegram comes before 14.7 deliberately. 14.7 needs the operator to keep the
process up and the FYERS token current through five market days, and today
nothing tells them when either fails. Landing it before the sessions also
keeps a runtime wiring change out of the middle of the acceptance run.

---

## 3. Audit findings, and where each is answered

| Finding (evidence at `478a1ad`)                                                                         | Task        |
| ------------------------------------------------------------------------------------------------------- | ----------- |
| A bearish option verdict sold the put it chose (`strategy-runner.ts`, `order-manager.ts`)               | 14.8 — done |
| The kill/pause flag blocks exits, including stops and the emergency exit (`order-manager.ts:89-92`)     | 14.9        |
| No BANKNIFTY capacity regression; `loosensLimits` untested on F&O fields; F&O sizing not version-pinned | 14.10       |
| FYERS status codes mis-mapped: 4 and 6 read as REJECTED, 5 as PENDING (`fyers-broker.ts:391-396`)       | 14.11       |
| A network error or timeout on `execute` is recorded as REJECTED; no request timeout                     | 14.12       |
| Partial fills dropped                                                                                   | 15.1        |
| Live reconciles orders only, at boot only; positions, trade book and funds never compared               | 15.2        |
| Order socket's close and error handlers empty; a silent feed is logged, never recovered                 | 15.3        |
| Token expiry guessed at 14 h; refresh job is a stub; 401 not classified                                 | 15.4        |
| `RateLimiter` not wired into the Live REST path                                                         | 15.5        |
| Instrument master loaded once at boot; no BSE F&O; no freeze quantity                                   | 15.6        |
| Live enabled by one variable on any non-blocked database name                                           | 15.7        |
| No broker margin; futures sized at notional                                                             | 15.8        |
| No staleness, trades/day, orders/day, concentration or unrealised-loss checks                           | 15.9        |
| Enabling a strategy, clearing its risk rules, and market hours loosen without step-up                   | 15.10       |
| OAuth `state` fixed and unchecked; logger redaction gaps; dashboard falls back to mock `mode`           | 15.11       |
| F&O ban list not known to the system                                                                    | 15.12       |
| No order-rate control against the SEBI retail algo framework                                            | 15.13       |
| No price-band / circuit-limit validation                                                                | 15.14       |
| Kill does not cancel working orders                                                                     | 15.15       |
| Per-strategy P&L snapshots empty (CURRENT_STATE §5.3)                                                   | 15.17       |
| Daily P&L snapshot lost if the process is down at the close (§5.4)                                      | 15.18       |
| Signal outcomes never written back to the signal (§5.5)                                                 | 15.19       |
| Flush depends on a hand-kept holiday list (§5.6); `marketHolidays` cannot be set through the API        | 15.20       |
| `/health` and `/readiness` not separated as ADR §19 requires                                            | 15.21       |
| Suspected: `orderTag` format, `options-chain-v3` spot row, a connect race on token change               | 15.22       |
| ADR §15 still names `/data/optionchain`                                                                 | 15.23       |

---

## 4. Phase 15 readiness additions (15.12–15.24)

Each of these is proven in paper before Live, like 15.1–15.11.

**15.12 — The F&O ban list.**

- **D1.** The ban list comes from the exchange's own daily publication only,
  stored per trading day with its source and fetch time.
- **D2.** A new entry in a derivative whose underlying is banned is blocked
  by the Risk Engine, with its own reason code. Exits are never blocked.
- **D3.** When today's list is unknown, a stock-derivative entry fails closed.
  Index derivatives are not subject to the ban, so today's index-option
  trading is unaffected; the check binds the day a stock-derivative strategy
  is enabled.
- **Q1.** Where NSE publishes the list, its format, publication time, and the
  terms for automated access. Verify before building (§10).

**15.13 — SEBI retail algorithmic trading framework.**

- **D1.** Implement only what the current circular and FYERS's implementation
  actually require of this platform, each requirement cited.
- **D2.** Whatever order-rate threshold binds is enforced in the Order
  Manager, below the threshold, never at it.
- **Q1.** The current circular, its order-per-second threshold, any algo
  identification or tagging requirement, and its effective dates. Verify;
  nothing is assumed (§10).

**15.14 — Price bands and circuit limits.**

- **D1.** A LIMIT order priced outside the instrument's current band is
  refused before it is sent, naming the band.
- **Q1.** Which FYERS response carries the band (quotes or depth), and how
  MARKET orders are protected on the exchange side. Verify.

**15.15 — The kill switch finishes its job.** After 14.9 lets exits through,
kill also cancels working **entry** orders. Flattening every position is a
separate action behind step-up, never a side effect of kill.

**15.16 — A confirm-each-order mode for the first Live sessions.**
Adopted from the reference's broker gates.

- **D1.** Every Live order is shown to the operator with a fingerprint of its
  exact fields; it is sent only after the operator confirms that fingerprint.
  A changed order is a new fingerprint and needs a new confirmation.
- **D2.** The mode is on by default for a newly promoted strategy and is
  turned off per strategy, behind step-up.
- **D3.** Exits are never held waiting for a confirmation.

**15.17–15.19 — The three standing defects** in CURRENT_STATE §5.3–§5.5,
fixed as recorded there. 15.18 backfills a missed close from Trades, never
from an estimate.

**15.20 — The session calendar.** `marketHolidays` and special sessions are
settable through the API, behind step-up, from the exchange's published
calendar with its source recorded. The §5.6 guard is added: ticks arriving on
a declared holiday are reported, not silently aggregated.

**15.21 — Health and readiness.** `/health` answers "is the process alive";
`/readiness` answers "is it safe to trade" and, in Live, also requires the
broker feed, the order socket, a valid token and a clean reconciliation.

**15.22 — Probe what is suspected.** One real call each, recorded like Phase
1's task 1.8: the accepted `orderTag` format, the underlying's row in a real
`options-chain-v3` response, and the connect-while-connecting race. A wrong
guess on the first would reject every Live order.

**15.23 — Documentation brought to the code.** ADR §15's endpoint, and a
CURRENT_STATE re-audit of everything Phases 14–15 changed.

**15.24 — Promotion.** The original Phase 15 deliverable. It is BLOCKED until
a candidate passes the Phase 13 gate and its own paper validation; none has.
It also requires Phase 16: no strategy goes Live unwatched.

---

## 5. Phase 16 — Operator notifications (Telegram)

Promotes ADR §21 from `PROPOSED` to `DECIDED` with these decisions.

### 5.1 Decisions

- **D1 — Outbound only.** The bot sends; it accepts no commands. A Telegram
  account is not an authenticated control plane, and kill, resume, limits
  and orders stay behind the dashboard's session and step-up (ADR §13). A
  read-only `/status` may be proposed later, as its own decision.
- **D2 — Never on the order path.** The notifier consumes events from the
  existing bus asynchronously. Its failures are logged and counted, never
  thrown into a caller; a dead Telegram cannot slow, block or change a
  trading decision. A fault-injection test proves it.
- **D3 — Events, not polling.** Every message comes from a real event, never
  from re-reading a dashboard value. Three sources that only log today get
  bus events, added to the contract catalogue rather than changing an
  existing one: feed silent / recovered, trading halted / resumed (kill,
  pause, resume, reconciliation halt), and broker token missing / expiring.
- **D4 — Every message names its mode.** `[PAPER]` or `[LIVE]` leads every
  message, taken from the injected mode, never inferred from the broker object
  (CURRENT_STATE §4.3).
- **D5 — Secrets.** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are optional
  config; when absent the notifier is off and says so once at boot. The token
  is redacted by the logger and never appears in a message, a log line or a
  stored record. Messages carry no FYERS identifiers or tokens.
- **D6 — Delivery discipline.** A bounded in-memory queue; per-request
  timeout; retries honour the Bot API's retry-after; the documented message
  rate limits are respected. If the queue fills, INFO messages are dropped
  first and the drop is counted.
- **D7 — A record of what was sent.** Every message, sent or failed, is kept
  in the already-registered `notifications` collection with its event, dedupe
  key and outcome, and is readable through `GET /notifications`.

### 5.2 The event catalogue

| Severity | Delivery                     | Events                                                                                                                                                                               |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | Immediately, never coalesced | Trading halted (kill, pause, reconciliation mismatch); daily-loss limit reached; broker disconnected during the session; token missing or expired during the session; `SYSTEM_ERROR` |
| WARNING  | Coalesced per minute         | `ORDER_REJECTED`; feed silent; a burst of `RISK_BLOCKED`; daily loss at 50 % and 80 % of the limit; trading resumed                                                                  |
| INFO     | As they happen, or digested  | Entry filled; position closed, with its exit reason and P&L; market open; the end-of-day summary                                                                                     |

Two scheduled messages, in IST from the session calendar:

- **Before the open:** whether a FYERS token exists and when it expires (real
  expiry from 15.4 once landed; until then, stated as unknown).
- **After the close:** the day's Trades, P&L, risk blocks, rejections and
  reconciliation result — and, in paper, the session report's identifier.

### 5.3 Open questions

- **Q1.** One chat or two (operations and trades)?
- **Q2.** Does INFO default on or off?

---

## 6. Phase 17 — Setup odds (the "Time Machine")

Answers a question the existing replay does not: for **this** plan — entry,
stop, target, now — how often does the target come before the stop? Adopted
from the reference's Time Machine; the existing replay already covers its
history half.

### 6.1 Decisions

- **D1 — Underlyings only.** Odds are computed on the stored index candles.
  We hold no option-contract history and must not invent one (ARCHITECTURE
  §20, PLAN §24), so an option plan's odds are the odds of the **index**
  reaching its levels. Every report says so in its first line.
- **D2 — Sessions from the calendar.** The regular NSE session is 09:15–15:30,
  75 five-minute bars, read from `packages/core/src/calendar.ts`, never
  hard-coded. Only full sessions enter the pool; special sessions (Budget day,
  Muhurat) are excluded and listed.
- **D3 — Two methods, never blended.**
  - _Resampling:_ each remaining bar is drawn from past sessions' bars at the
    same time of day (± a declared window), as ratios to the previous close,
    scaled to the current price. Seeded.
  - _History:_ the plan's rule run over every past session through the
    **existing replay** (Phase 4). The rule is expressed as a strategy
    configuration; if ORB's parameters cannot express it, extending them goes
    through PLAN §21, not a second engine.
- **D4 — Conservative ties.** A bar that touches both stop and target counts
  as the stop. A gap through the stop is reported as −1R **and** flagged as
  understating the real fill.
- **D5 — The verdict is against break-even.** The target's share of decided
  outcomes is compared with `1 / (1 + R)`. Thresholds are declared in the
  manifest (the reference uses 5 and 15 points).
- **D6 — Sample size and intervals.** History counts carry intervals from
  Phase 7's statistics, and fewer than Phase 7's minimum sample reports
  INSUFFICIENT_SAMPLE rather than a verdict. Resampled counts are never
  presented as if they were independent observations.
- **D7 — Determinism and isolation.** Seed, pool dates, window, thresholds
  and model versions go in a manifest with a fingerprint. Runs are kept in a
  research-database collection; a test proves no trading collection changes,
  as in Phase 4's task 4.7.
- **D8 — No lookahead.** The pool holds only sessions strictly before the
  plan's date; a mutation that admits the plan's own day must fail a test.
- **D9 — The stated limitation.** Drawing each bar independently breaks the
  momentum and volatility clustering inside a real day. Every report says so.

### 6.2 Open questions

- **Q1.** Historical expiry dates, needed to pool expiry-day sessions
  separately. The instrument master holds only live contracts, and NSE has
  changed index expiry weekdays before. Source to be found and verified;
  until then expiry days are not separated, and the report says so.
- **Q2.** Per-bar resampling, or a block bootstrap that keeps runs of
  consecutive bars together?
- **Q3.** Cost basis. Index points carry no charges; the charges model applies
  to a priced, tradable instrument. Report gross R only until a plan names
  one?
- **Q4.** Where a plan comes from: an operator CLI input, a live signal, or
  both.

---

## 7. Phase 18 — NSE F&O scanner

Adopted from the reference's scanner.

### 7.1 Decisions

- **D1 — The universe comes from the instrument master**: F&O underlyings and
  the indices, active contracts only. Expired contracts, and those inside a
  declared minimum time to expiry, are excluded.
- **D2 — Candidates, never signals.** A candidate must still pass a
  strategy's own rules, then the Risk Engine. Nothing the scanner writes is
  read by the order path.
- **D3 — Every decision explained.** Each instrument is recorded as selected
  or rejected, with the condition that decided it and the timestamp of the
  data it used.
- **D4 — Existing detectors.** Conditions are the Phase 5 pattern detectors
  and the indicator folds; no new indicator mathematics.
- **D5 — Indian filters.** The F&O ban list (15.12), liquidity from OI and
  volume, and price band, each only from a verified source.
- **D6 — Partial results say so.** A scan that stops short of its universe
  (rate limits, missing bars) is labelled PARTIAL with what was skipped.

### 7.2 Open questions

- **Q1.** Data for some 200 stock underlyings. The FYERS history rate limit is
  still unmeasured (Phase 1 Q3), and websocket symbol limits are unverified.
  Version 1 is a pre-open scan on daily bars; intraday scanning waits for
  those answers.
- **Q2.** Where scan runs are kept: the research database, or the trading
  deployment's read-only side.

---

## 8. Phase 19 — Operator skills (Claude Code)

The reference's central idea: **code decides, Claude explains.**

### 8.1 Decisions

- **D1.** Project skills in `.claude/skills/<name>/SKILL.md`, each wrapping
  one existing CLI in `apps/api/scripts/`. A skill adds no logic; its numbers
  are the CLI's numbers, verbatim.
- **D2.** The skills, each tied to its existing CLI:
  - board status and next task (PLAN.md and `check:plan`)
  - the paper session report (`paper.mts`)
  - replay (`replay.mts`)
  - setup odds (Phase 17)
  - candidates and verdicts (`validation.mts`)
  - the scanner (Phase 18)
  - a research question (`agent.mts`)
- **D3 — What a skill never does.** Place or cancel an order; kill, pause or
  resume; change a limit, a setting or a strategy; read `.env*`; run against
  a Live or paper trading database. The CLIs already refuse production
  databases (`apps/api/src/agent/guard.ts`, the research and scratch checks);
  a skill only invokes CLIs that refuse.
- **D4.** Each `SKILL.md` names the exact command, its inputs, what each
  output field means, and what the skill must not claim — the reference's
  "a scan is not a buy list" discipline.

---

## 9. Phase 20 — Corporate announcements (the News track)

PLAN §22's News track, given tasks.

### 9.1 Decisions

- **D1 — Official sources only.** Exchange announcements (NSE, BSE) and SEBI
  circulars. No third-party commentary in version 1.
- **D2 — Provenance on every item:** source, URL, publication time, ingestion
  time, and the symbols it is mapped to.
- **D3 — Never a trigger.** Announcements feed the knowledge base (the agent's
  deferred `newsContext` tool) and, optionally, a declared restriction such as
  "no new entries in a stock on its results day", set behind step-up.
- **D4 — Retention.** The registered `news` collection has a 30-day TTL, too
  short for research; retention is decided before the first ingestion.

### 9.2 Open questions

- **Q1.** Access method and terms of use for each source. This is task 20.1;
  nothing is ingested until it is answered.

---

## 10. Not adopted from the reference

| Reference skill                     | Why not                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Entry timer, exit planner, budget   | Already exist, in production form: the Strategy Runner, the Exit Engine, `sizeFno` / `sizeEquity`.                           |
| Broker (as a skill)                 | The order path is the Order Manager and the Broker contract. Its gates are adopted as 15.16, its fingerprint idea with them. |
| Analyst (company fundamentals)      | Feeds nothing in an intraday index-options system.                                                                           |
| Pelosi (Congress trade disclosures) | Not ported. Indian disclosures (insider trading, takeovers, bulk and block deals) only if a strategy ever needs them.        |
| Yahoo Finance data                  | Unofficial. FYERS and the exchanges are the only data sources.                                                               |

---

## 11. External facts to verify before building

Nothing in this table is assumed. Each blocks the task named until answered,
with the source recorded beside the answer.

| Fact                                                                | Blocks      |
| ------------------------------------------------------------------- | ----------- |
| NSE's daily F&O ban publication: location, format, timing, terms    | 15.12, 18.x |
| SEBI retail algo framework: current circular, thresholds, dates     | 15.13       |
| FYERS: where price bands appear; how MARKET orders are protected    | 15.14       |
| FYERS: accepted `orderTag` format; `options-chain-v3` spot row      | 15.22       |
| FYERS: positions, trade book, funds and margin endpoints and shapes | 15.2, 15.8  |
| FYERS: history rate limits; websocket symbol limits                 | 18.x        |
| Historical NSE index expiry dates                                   | 17.x (Q1)   |
| Telegram Bot API message rate limits                                | 16.2        |
| NSE / BSE / SEBI announcement access and terms                      | 20.1        |
