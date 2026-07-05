# 23 — Monitoring

> Prerequisites: **[02_MASTER_ARCHITECTURE.md](02_MASTER_ARCHITECTURE.md)** §10 ("degrade safely, never silently" — this chapter is how "never silently" is achieved), **[09_EVENT_DRIVEN_SYSTEM.md](09_EVENT_DRIVEN_SYSTEM.md)** (`SYSTEM_ERROR`), **[22_DEPLOYMENT.md](22_DEPLOYMENT.md)** (where logs land).

---

## 1. Purpose

This system runs unattended for hours while holding positions. Monitoring answers the operator's three standing questions — **is it alive, is it healthy, is it behaving?** — without requiring them to watch it. The design principle inherited from Chapter 02 §10: every failure must become a *visible, logged fact*; the only unacceptable failure is a silent one.

---

## 2. Two records, one distinction

The system produces two different kinds of record, and conflating them muddles both:

- **The business audit** — *what did the machine decide and do?* This already lives in Mongo by design: `signals`, `orders`, `positions`, `risk_logs`, `trade_logs` (Chapter 07). It is append-only, permanent, and answers forensic questions ("why did this trade happen?").
- **Operational telemetry** — *is the machine functioning?* Structured logs, metrics, and health states. Shorter-lived, higher-volume, and answers engineering questions ("why is candle close late?").

**Why keep them separate:** the audit trail has legal/forensic-grade retention and immutability requirements (Chapter 07 §3); telemetry is diagnostic exhaust with TTLs. Mixing them either bloats the audit or under-protects it.

---

## 3. Structured logging

- **Format:** JSON structured logs (pino — Fastify-native, near-zero overhead, which matters on a process that also runs the tick path, Chapter 02 §9). Captured by PM2, rotated (Chapter 22 §2).
- **Every log line carries:** timestamp, level, component (`engine.risk`, `broker.fyers`, …), message, context object — and, on anything pipeline-related, the **`correlationId`** from the event envelope (Chapter 09 §3). **Why correlation is the load-bearing field:** it's what turns a pile of lines into a *story* — grep one signal id and see its context build, its risk checks, its order, its fill, its position update, in order. The audit collections tell you *what*; correlated logs tell you *how it went operationally*.
- **Levels used honestly:** `error` = something failed; `warn` = something degraded or suspicious (feed silence, retry exhaustion approaching); `info` = lifecycle facts (boot, session open, strategy enabled); `debug` = development only. **Why discipline matters:** an `error` level that also logs routine noise trains the operator to ignore it — alert fatigue is a security hole.
- **Never logged, ever:** broker tokens, session ids, password material (Chapter 19 §8, Chapter 24). Redaction is enforced in the logger configuration, not left to call-site discipline.

---

## 4. Health model

Two probes with different meanings, exposed by the api and checked by Docker/PM2 and the dashboard:

- **Liveness** — the process responds. Failure ⇒ supervisor restarts it (Chapter 22 §2).
- **Readiness** — the process can *do its job*: Redis reachable, Mongo reachable, broker connection state, session state, queues draining. **Why the split:** a process that's alive but can't reach Redis must *not* be restarted in a loop (restart won't fix Redis) — it should report unready, halt new orders (Chapter 08 §11), and wait. Liveness answers "restart me?"; readiness answers "trust me?".

The dashboard's status strip (Chapter 06 §7) is the operator-facing rendering of readiness — the first-line monitor is the control center itself.

---

## 5. The metrics that matter (and why each)

A deliberately short list — each metric exists because a specific failure mode hides behind it:

| Metric | Watches for |
|---|---|
| **Event-loop lag** | The architecture's one shared resource (Chapter 02 §9). Rising lag = something blocking the hot path = ticks and decisions delayed. *The* canary for this design. |
| **Tick rate per subscribed symbol** | Feed health; complements Chapter 17 §8's silence detection. A liquid symbol at 0 ticks/min during session = feed problem regardless of socket state. |
| **Candle-close latency** (boundary → `CANDLE_CLOSED`) | The heartbeat's punctuality; late candles delay every decision downstream. |
| **`analyze()` duration per strategy** | A strategy violating the purity/speed contract (Chapter 15 §7) shows up here before it hurts. |
| **Signal → order latency** | The synchronous critical path's health (Chapter 02 §6, Regime A) — should be milliseconds, always. |
| **Risk block rate (by check)** | A sudden spike = a misconfigured strategy hammering the gate; a sudden *zero* on a busy day = the gate may not be running. Both directions are signals. |
| **BullMQ queue depth & failure count** | Background-work backlog (news floods) and dying jobs — especially `jobs:token-refresh` (Chapter 19 §3), whose failure is a morning outage. |
| **Broker call rate vs. budget** | Headroom against FYERS caps (Chapter 08 §8, Chapter 19 §6) before throttling ever triggers. |
| **Reconnect count / disconnect duration** | Flapping connections that individually recover but collectively signal instability. |
| **Process memory / restarts** | Leaks and crash loops (Chapter 22 §7). |

---

## 6. Alerting — what interrupts the operator

Alerts are tiered by required response, and delivered through the `notifications` collection → dashboard + (roadmap) push channel:

- **Act now (during session):** `BROKER_DISCONNECTED` beyond the reconnect budget; feed silence threshold hit; **daily loss ≥ 80% of limit** (warning *before* the breaker, so the auto-pause at 100% — Chapter 14 §8 — is never a surprise); order stuck unreconciled (Chapter 12 §8); crash-restart during market hours; severe `SYSTEM_ERROR`.
- **Act today:** token-refresh failure or upcoming manual-auth requirement (Chapter 19 §3); backup job failure; queue dead-letters accumulating; readiness degraded off-hours.
- **Awareness:** strategy auto-disabled after repeated errors (Chapter 15 §7); reconnect flapping; retention/TTL anomalies.

**Why tiering is explicit:** an alerting system where everything pages is one where nothing does. The tiers encode the honest question — *what would the operator actually do right now?* — and anything with no action attached is a log line, not an alert.

---

## 7. Scheduled verifications (the "is it still true?" checks)

Monitoring covers not just live signals but standing assumptions:

- **Daily reconcile results** (Chapter 13 §6) — divergence between hot state and durable state is a `SYSTEM_ERROR`, and *its absence is itself confirmed daily* (a reconcile that silently stopped running is the failure mode of the failure detector).
- **Backup restore rehearsal — quarterly, minimum.** A scheduled drill restores the latest Mongo dump into a scratch instance and verifies collection counts and spot records. This is the cadence Chapter 22 §6 committed to: *a backup that has never been restored is a theory.* The drill's result is logged and its non-occurrence alerts.
- **Certificate / token / calendar expiries** — TLS certs (proxy auto-renewal verified), FYERS app credential validity, and the exchange holiday calendar (Chapter 17 §6) checked ahead of need, not discovered at 09:15.

---

## 8. Failure modes of monitoring itself

- **Logging pipeline failure** must not take the process down — logging is best-effort exhaust; the process trades on, and PM2-level capture (Chapter 22) is the fallback.
- **Notification delivery failure** → notifications persist in Mongo regardless (Chapter 07); the dashboard shows them on next load. Delivery is a channel, not the record.
- **Metrics gap** → a monitoring outage is *visible as an outage* (dead-man's-switch style: the absence of the daily reconcile confirmation alerts, §7) — the watcher is itself watched by the simplest possible mechanism.

---

## 9. Roadmap

- **Prometheus + Grafana** for the §5 metrics with dashboards and alert rules — the natural next step once the metric set stabilizes.
- **External uptime probe** (outside the VPS) so a total box failure still alerts (Chapter 22 §7).
- **Push alerting channel** (Telegram/email) for the act-now tier, replacing dashboard-only delivery.

---

*Previous: **[22_DEPLOYMENT.md](22_DEPLOYMENT.md)**  ·  Next: **[24_SECURITY.md](24_SECURITY.md)** — the threat model and the layers defending it.*
