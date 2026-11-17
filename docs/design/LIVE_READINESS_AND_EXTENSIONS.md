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
  pause, resume, reconciliation halt), and broker token missing / restored.
  Each fires on the transition only. _Token expiring_ is not built yet: the
  stored expiry is an assumed 14 hours, not the token's own, and a warning
  computed from a guess would be invented data. It comes with 15.4's real
  expiry. Events raised during boot are published once the bus exists.
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
- **D8 — Two chats (Q1, decided 2026-11-06).** Operations — halts, daily
  loss, broker, feed and token faults, rejections, risk-block bursts, market
  open, and the two daily messages — and trades — entry fills and closed
  positions. A second, optional `TELEGRAM_TRADES_CHAT_ID`; while it is absent,
  trades go to the operations chat, so one configured chat keeps working.
  Task 16.8.
- **D9 — INFO on, silent (Q2, decided 2026-11-06).** INFO messages are sent
  by default, without a notification sound. The provisional default becomes
  the decided one.
- **D10 — Research and lifecycle events (decided 2026-11-06).** ADR §21's
  list — new R&D finding, new strategy candidate, historical validation
  completed or failed, paper validation completed, strategy improvement
  discovered, promotion candidate created, Live promotion approved, the
  weekly report — is notified too, under the same D1–D7. Those events happen
  in the research CLIs and the R&D process, not on the trading bus, so where
  each is raised and which chat it goes to is Q3, answered in task 16.9.
- **D11 — Each CLI tells what it kept (Q3, decided 2026-11-06).** The CLI
  that keeps the result notifies, from its own process, after the keep and
  never for a dry run, with the API's notifier and its own env file's
  Telegram settings (`apps/api/src/notifications/cli.ts`). It never reaches
  the trading process or its bus, so D2 holds by construction. INFO, in the
  operations chat, led by `[RESEARCH]` — or `[PAPER]` from `paper.mts` (D4).
  Each outcome is kept in the CLI's own database, so `GET /notifications`,
  which reads the trading one, does not list them. A CLI waits for delivery
  up to 20 s and never fails because of it. Rejected: Redis into the trading
  process (couples R&D to it, ADR rule 4, and loses messages while it is
  down); an outbox the API polls (the trading process would read the research
  database, against D3's events-not-polling). Wired now: a candidate
  declared, a walk-forward kept with its verdict, a paper session report
  kept, the weekly reports. Deferred: promotion candidate created and Live
  promotion approved, with Phase 15; a new R&D finding and a strategy
  improvement discovered, until either is defined — nothing in the code is
  either today.

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

- **Q1.** One chat or two (operations and trades)? **Decided: two, D8.**
- **Q2.** Does INFO default on or off? **Decided: on, silent, D9.**
- **Q3.** For D10's events: where each is raised — the research process has
  no trading bus — how it reaches the notifier without putting research on
  the order path, and which of D8's chats it goes to. **Decided: D11.**

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
- **D10 — Per-bar draws, history beside them (Q2, decided 2026-11-16).** Each
  bar is drawn on its own from the same time of day, as D3 describes; no
  block bootstrap in version 1. D9's limitation therefore stands and is
  printed, and the history method — real days, in their real order — is shown
  beside the resampled odds, never blended with them (D3).
- **D11 — Gross R, in index points (Q3, decided 2026-11-16).** Odds and R are
  reported without charges or slippage: an index is not a tradable contract,
  and the charges model applies to one. The report says so beside D1's line.
- **D12 — The operator types the plan (Q4, decided 2026-11-16).** Version 1
  takes side, entry, stop, target, date and time from the operator CLI. A
  plan taken from a live signal comes later, as its own task.
- **D13 — Expiry days are not separated in version 1 (Q1, decided
  2026-11-16).** No verified source of historical index expiry dates is held,
  so expiry sessions stay in the pool with the rest and the report says so.
  The fact itself stays in §11 to be verified.
- **D14 — The history is judged on every trade's R (found 2026-11-16).** D5's
  share of decided outcomes fits the resampled odds, where a replay ends only
  at the stop, the target or the close. A rule's own history is different: a
  rule may leave a trade before either level, and then the decided trades are
  the few that ran far enough to be decided. On the stored year EMA_CROSSOVER
  went long 357 times on NIFTY 50; 50 were decided, 56 % of them at the
  target against a 33 % break-even, while the average of all 357 was 0.02R.
  So the history's verdict is the average R of every time the rule fired,
  with Phase 7's interval of a mean: FAVOURABLE or UNFAVOURABLE once that
  interval clears zero, INCONCLUSIVE until it does, INSUFFICIENT_SAMPLE below
  Phase 7's minimum of times fired. The share of decided outcomes is still
  reported, with its Wilson interval, against the break-even of the rule's
  own targets — a rule's stop and target move with each day, so its trades
  do not pay the plan's R.
- **D15 — Kept with the other experiments (D7).** A run is one
  `strategy_experiments` document, `kind: "SETUP_ODDS"`, in the research
  database: the same collection, indexes and never-overwrite rule as the
  counterfactual runs, not a new collection for the same concept.
- **D16 — Served by a separate research service (decided by the operator
  2026-11-16).** The operator wants the odds in the dashboard. They are not
  computed in the trading process: a rule's history replays a year of
  sessions on one thread — seven seconds on the stored year — and that work
  must not share an event loop with live ticks and exits; and the trading
  deployment holds the paper database, not the research one (ADR §8.1).
  So:
  - **The research service** is its own process on the research database:
    `apps/api/src/research-api/`, started with
    `node dist/research-api/main.js`. It refuses, by name and before it
    connects, any database but `neelkanth_research` or a scratch one. It
    holds no broker, no Redis and no trading repository. Every route but the
    health probes needs a shared secret as a bearer token.
  - **The trading API relays.** The dashboard is a static site whose one
    credential is the session cookie for the trading API, and that cookie is
    never sent to another origin. So the dashboard asks the trading API
    (`/research/odds`, `/research/odds/coverage`, behind the same session
    guard as every other route) and `apps/api/src/control-plane/research-relay.ts`
    passes the request on with the secret. It runs no research code and opens
    no research database. Unconfigured or unanswered, it says so with a 503
    and nothing else in the trading process changes (ADR §5.6).
  - **Placement — reported, not silently chosen.** ADR §6 names
    `apps/research-api` (with `packages/research`) for the day a research
    API lands. The service is instead a second entry point inside `apps/api`:
    the replay, the validation statistics and the odds code it calls all live
    in `apps/api/src`, and a separate workspace could reach them only after
    they moved to a shared package — a refactor of some hundred files that
    this task does not justify. The process, the deployment and the database
    are separate, which is what ADR §5.6 and §8.1 ask for; the workspace is
    not, yet. Moving it is the ADR's own later step.
  - **A dashboard run keeps nothing by default** (`save: false`); a kept run
    is still a `SETUP_ODDS` experiment (D15).

### 6.3 Deploying the research service

One more web service on the same host as the API, from the same repository
and the same build.

| Setting              | Value                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Build command        | the API service's own (it builds `apps/api/dist`)                                                                 |
| Start command        | `node apps/api/dist/research-api/main.js`                                                                         |
| `MONGO_URI`          | the same cluster, with the database `neelkanth_research`. Any other name is refused at start                      |
| `RESEARCH_API_TOKEN` | a new random secret of 32 characters or more                                                                      |
| `PORT`               | set by the platform; the service then binds every interface. Locally it is `127.0.0.1:4100` (`RESEARCH_API_PORT`) |
| Health check path    | `/health/ready`                                                                                                   |

Then, on the **API** service, set `RESEARCH_API_URL` to the research
service's address and `RESEARCH_API_TOKEN` to the same secret — both or
neither — and redeploy the API and the dashboard. The dashboard needs no new
setting: it reaches research through the API.

To check it: the dashboard's **Time Machine** tab shows the stored dates under
the form. "Research data unavailable: the research service is not configured
for this deployment" means the API's two settings are missing; "did not
answer" means the service is down or its address is wrong; "refused this
deployment's credentials" means the two secrets differ.

### 6.2 Open questions

- **Q1.** Historical expiry dates, needed to pool expiry-day sessions
  separately. The instrument master holds only live contracts, and NSE has
  changed index expiry weekdays before. Source to be found and verified;
  until then expiry days are not separated, and the report says so.
  **Decided: not separated in version 1, D13.**
- **Q2.** Per-bar resampling, or a block bootstrap that keeps runs of
  consecutive bars together? **Decided: per-bar, D10.**
- **Q3.** Cost basis. Index points carry no charges; the charges model applies
  to a priced, tradable instrument. Report gross R only until a plan names
  one? **Decided: gross R only, D11.**
- **Q4.** Where a plan comes from: an operator CLI input, a live signal, or
  both. **Decided: the operator CLI first, D12.**

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
- **D7 — Built ahead of 15.2, 15.6 and 15.12 (decided by the operator
  2026-11-16).** §2.2 placed the scanner after three Live-readiness tasks;
  the operator asked for it now. What each was for, and what stands in for it:
  - _15.6, the instrument master refreshed daily:_ the scan reads the
    broker's public symbol files itself, at scan time (D9). It does not need
    the trading process's copy.
  - _15.12, the ban list:_ not available. Until its source is verified (§11),
    no scan checks it, and **every scan is PARTIAL** and says "the F&O ban
    list was not checked" (D5, D6). A candidate may be a banned security.
  - _15.2, the broker ports:_ a scan on stored bars reads no positions, order
    book or funds.
- **D8 — A pre-open scan on daily bars, in research (Q1, Q2, decided
  2026-11-16).** The scan is research: it reads bars already stored, keeps its
  runs in the research database, and is served by the research service (§6.1
  D16). Fetching the bars is the backfill's job, with the broker's token; the
  scan never calls the broker. Intraday scanning waits, as Q1 says: the data
  socket carries 100 symbols on the Standard plan (§11.1), fewer than the
  universe.
- **D9 — The universe is joined by token, not by name (found 2026-11-17).**
  A derivative's row in the F&O file carries the fyToken of what it derives
  from, and that token is the first column of the underlying's own row in the
  cash file. So `BANKNIFTY` becomes `NSE:NIFTYBANK-INDEX` from the files
  themselves, with no table of index names to go stale — on the files of
  2026-11-17 the join found six index underlyings, one more than anyone would
  have typed from memory (`NIFTYFPI`). An underlying whose token is missing
  is rejected with that reason, not guessed.
- **D10 — The published rate limit is honoured, not probed.** Phase 1 Q3
  asked for the history rate limit to be measured. It is read from FYERS's
  own page instead (§11.1) and the backfill is held under the lower plan's
  figure — 50 data requests a minute — because finding the limit by exceeding
  it costs the account its market data for the rest of the day after the
  third time, and that is the paper session's feed.
- **D11 — Daily bars are a candle interval, and only research reads them
  (Q3, decided by the operator 2026-11-17: option (a)).** `CandleInterval`
  gains `1d`. Two guards keep it out of trading: the strategy registry
  refuses to instantiate a strategy on it — the one door live, paper, replay
  and backtest all go through — and the live aggregator refuses to be built
  with it. A daily bar is stamped 00:00 UTC of its IST trading date, 05:30
  IST: that is FYERS's own stamp for resolution `D` (measured 2026-11-17 —
  RELIANCE's bar of 2026-11-16 arrived as `1794787200`) and it is what
  `floor(ts / day) * day` gives, so alignment needs no special case;
  validation drops only the session-hours check for it. One request covered
  366 days at `D` (measured: 249 bars of RELIANCE for a year), against 100
  for the intraday resolutions. Fetched by
  `backfill-candles.mts --interval=1d --max-days=366`, with `--real-volume`
  for the cash equities, whose volume is real; an index's stays SUSPECT.
- **D12 — The conditions (18.3).** Three Phase 5 detectors at their default
  parameters: `EMA_CROSS`, `HIGH_VOLUME_BREAKOUT`, `RSI_REVERSION`.
  `ORB_BREAKOUT` and `VWAP_RECLAIM` are left out — both are anchored to an
  intraday session, and a daily bar has neither. On the daily interval the
  sweep's detector window spans sessions, since each bar is one; otherwise a
  "20-bar high" could never be seen. A member is a candidate when at least
  one condition held on the data day's bar — the last trading day before the
  scan day — and otherwise rejected as `NO_CONDITION`, `NOT_JUDGEABLE`
  (every condition warming up or declining untrusted volume), `STALE_DATA`
  or `NO_BARS`, each with every condition's verdict and the bar's time. A
  bar on or after the scan day is refused, not filtered: it is a broken
  caller. An index cannot be judged by `HIGH_VOLUME_BREAKOUT` while its
  volume is SUSPECT; the other two still judge it.
- **D13 — Served like the odds (D16).** `POST /scan` and
  `GET /scan/coverage` on the research service, relayed by the trading API
  as `/research/scan` and `/research/scan/coverage`. The service fetches
  the two public symbol files at most once per IST day (about 19 MB), and
  reads the trading calendar from `apps/api/scripts/calendars/nse-2025-26.json`
  — the backfill's. A dashboard scan keeps nothing by default; a kept one is
  a `SCAN` experiment with the files' sha256 in its manifest.

### 7.2 Open questions

- **Q1.** Data for some 200 stock underlyings. The FYERS history rate limit is
  still unmeasured (Phase 1 Q3), and websocket symbol limits are unverified.
  Version 1 is a pre-open scan on daily bars; intraday scanning waits for
  those answers.
- **Q2.** Where scan runs are kept: the research database, or the trading
  deployment's read-only side. **Decided: the research database, D8.**
- **Q3 — Daily bars have no interval to be stored under (found
  2026-11-17; decided: (a), D11).** `CandleInterval` is `1m` to `60m`; D8's daily bars and D4's
  detectors, which take candles, need a daily one. Two ways:
  - **(a)** Add `1d` to the candle interval, with two guards so trading can
    never decide on it — the strategy registry refuses a daily strategy, the
    live aggregator refuses a daily bucket — and an IST-day alignment rule for
    stored daily bars. The detectors then run on daily bars unchanged.
  - **(b)** A scanner-only daily bar outside the candle type, and conditions
    written from the indicator folds alone. No core change, but D4's detectors
    are not used, and 18.3 says they are.

  Recommended: (a). It is a change to a core type, so it is the operator's to
  approve before it is made. **The operator chose (a) on 2026-11-17 — D11.**

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
  a Live trading database, or a paper one except as D6 allows. The CLIs
  already refuse production databases (`apps/api/src/agent/guard.ts`, the
  research and scratch checks); a skill only invokes CLIs that refuse.
- **D4.** Each `SKILL.md` names the exact command, its inputs, what each
  output field means, and what the skill must not claim — the reference's
  "a scan is not a buy list" discipline.
- **D5 — Enforced, not trusted (19.1).** The conventions live in
  [`.claude/skills/README.md`](../../.claude/skills/README.md), and
  `scripts/check-skills.mjs` (`pnpm check:skills`) holds every skill to them.
  Every shell line in a skill must match an `ALLOW` entry exactly: the CLI, its
  directory, its env file, its subcommand and its flags. A `--db=` must be the
  research database or a scratch one. An entry is added by the task that adds
  its skill, and it cites the line where its CLI refuses, so D3's "only CLIs
  that refuse" is checked rather than asserted. A skill has no
  `allowed-tools`: the operator approves each command at the prompt.
- **D6 — The paper report reads, and only reads (Q1, decided 2026-11-04).**
  The operator wants a paper-trading skill, so reading (b) below holds: the
  `paper-report` skill runs `paper.mts` against `neelkanth_paper` with
  `reports`, and with `report --dry-run` only. Neither keeps anything.
  `provision` (it writes `strategies`) and a `report` without `--dry-run`
  (it writes `paper_session_reports`) stay the operator's. `check-skills`
  allows `neelkanth_paper` for that one entry and no other, and requires
  `--dry-run` on `report`. `paper.mts` still refuses any database but a
  paper or scratch one, so a skill never reaches Live.

### 8.2 Open questions

- **Q1 — The paper report and D3 conflict. Decided: (b), see D6.** D2 lists the paper session
  report (`paper.mts`), and D3 (with PLAN §33) says a skill never runs
  against a paper trading database. `paper.mts` runs only against the paper
  database: `provision` writes `strategies`, and `report` writes
  `paper_session_reports` unless `--dry-run` is given. Two readings are
  possible:
  - **(a)** No paper skill at all.
  - **(b)** A read-only exception: `report --dry-run` and `reports` only,
    which change nothing.

  Until it was decided, the stricter reading (a) held, because `ALLOW` had no
  `paper.mts` entry.

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

### 11.1 Answers so far

| Fact                            | Answer                                                                                                                                                                                                                                                                                                                                                                                                                         | Source, read                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| FYERS: history rate limits      | The documented limit, not yet measured. Data APIs on the Standard plan: 5 requests a second, 50 a minute, 5,000 a day (Prime: 10, 500, 5,00,000). Past a limit the API answers -429, and "if the per-minute rate limit is exceeded more than 3 times in a day, the user is blocked for the rest of the day". Which plan this account is on is not yet confirmed                                                                | <https://fyers.in/api-docs/v3/getting-started/plans-and-limits/>, 2026-11-16                   |
| FYERS: websocket symbol limits  | Data socket: 100 symbols for a user on Standard, 5,000 on Prime, across all connections; a subscription past the limit is not established                                                                                                                                                                                                                                                                                      | the same page, 2026-11-16                                                                      |
| NSE's daily F&O ban publication | **Still open.** NSE's file-structure document names the file `fo_secban_DDMMYYYY.csv`, and its risk-management page links the next trade date's list; the page did not answer an automated read on 2026-11-16 (timeout), so its exact address, publication time and terms of automated access are unverified. The ban itself: open interest past 95 % of the market-wide position limit; only position-reducing trades allowed | <https://www.nseindia.com/static/products-services/equity-derivatives-risk-management-sec-ban> |
