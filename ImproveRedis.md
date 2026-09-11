# Redis Command Usage Optimization - Algo Trade

## Objective

Optimize the Redis architecture in the existing `algo-trade` repository to significantly reduce Redis command usage.

Recent Upstash Redis monitoring shows unexpectedly high command consumption.

Observed production/test data:

- Day 1: ~135K commands
- Day 2: ~192K commands
- Total: ~327K commands
- Upstash free limit: 500K/month

A Redis MONITOR capture from approximately:

`14:17:47 → 14:18:02`

showed approximately:

- `230` × `PUBLISH events:MARKET_TICK`
- `231` × `SET hot:price:*`
- `16` × `PUBLISH events:CANDLE_CLOSED`
- Total: approximately `477` Redis commands in 15 seconds

This means the current market-data hot path is generating approximately:

`477 / 15 ≈ 31.8 Redis commands/sec`

Approximately 96% of the observed commands are from:

1. `PUBLISH events:MARKET_TICK`
2. `SET hot:price:*`

The goal is to reduce unnecessary Redis operations while preserving all existing trading behavior.

---

# VERY IMPORTANT

Do NOT blindly remove Redis commands.

First inspect the complete data flow and determine:

1. Why `MARKET_TICK` is published.
2. Who subscribes to `MARKET_TICK`.
3. Why `hot:price:*` is written.
4. Who reads `hot:price:*`.
5. Whether both are actually required.
6. Whether market tick state can safely remain in memory.
7. Whether Redis is being used as a cache where an in-memory state would be more appropriate.
8. Whether dashboard/WebSocket consumers actually require every tick.
9. Whether any Redis operation is required for distributed coordination/recovery.

The objective is NOT simply "use fewer Redis commands".

The objective is:

> Keep Redis for persistence, coordination, events, queues, locks, recovery, and distributed state where necessary, while removing Redis from unnecessary high-frequency market-data operations.

---

# NON-GOALS

Do NOT implement any of the following as part of this task:

- New trading strategies
- New indicators
- F&O features
- New broker integration
- AI
- LLM
- RAG
- LangGraph
- MCP
- Backtesting
- VPS deployment
- Database migration unrelated to Redis optimization
- UI redesign
- Trading behavior changes
- Risk-management redesign

This task is ONLY Redis command optimization.

---

# STEP 1 - FULL REDIS USAGE AUDIT

Before modifying code, inspect the entire repository.

Search for all Redis usage.

Search for:

```text
Redis
redis
RedisClient
get(
set(
mget(
mset(
hget(
hset(
publish(
subscribe(
pipeline(
multi(
exec(
expire(
ttl(
del(
exists(
eval(
xadd(
lpush(
rpush(
zadd(

Also specifically search for:

events:MARKET_TICK
events:CANDLE_CLOSED
hot:price:
MARKET_TICK
hot:price

Build a map of every Redis call.

For each Redis call identify:

File
Function
Caller
Frequency
Purpose
Read/write
Critical/non-critical
Can be cached in memory?
Can be batched?
Can be removed?
Can be replaced with local state?

Do not change code until this audit is complete.

STEP 2 - IDENTIFY THE MARKET DATA HOT PATH

Trace the complete flow from FYERS market data.

Expected architecture is approximately:

FYERS WebSocket
      ↓
Market Data Service
      ↓
Tick normalization
      ↓
Candle builder
      ↓
Indicators
      ↓
Strategies
      ↓
Risk Engine
      ↓
Order Manager

Determine exactly where Redis is inserted.

Especially investigate:

FYERS tick
    ↓
SET hot:price:*
    ↓
PUBLISH events:MARKET_TICK

Determine whether the strategy engine receives market data through:

Redis Pub/Sub
direct function calls
event emitter
WebSocket
another event bus
combination of the above

Document the actual architecture before changing it.

STEP 3 - ANALYZE SET hot:price:*

Find every writer and reader of:

hot:price:*

For example:

hot:price:NSE:RELIANCE-EQ
hot:price:NSE:HDFCBANK-EQ

Determine:

Why is latest price stored in Redis?
Who reads it?
How frequently is it read?
Does the reader require real-time tick-level state?
Can the latest tick be held in process memory?
Is Redis required for recovery?
Is Redis required because multiple application instances access it?

If hot:price:* is only used by the same process that receives the FYERS tick, strongly prefer in-memory state.

Example:

private readonly latestPrices = new Map<string, MarketTick>();

The market data service should update:

latestPrices.set(symbol, tick)

without Redis.

Redis should only be updated if there is a demonstrated requirement.

STEP 4 - ANALYZE PUBLISH events:MARKET_TICK

Find every subscriber to:

events:MARKET_TICK

Determine exactly why the event is published.

For every subscriber document:

Subscriber
Purpose
Required frequency
Can it consume direct in-process events?
Requires cross-process communication?
Requires every tick?
Can it consume candle events instead?

IMPORTANT:

If the producer and consumer are running inside the same Node.js process, do NOT use Redis Pub/Sub unnecessarily.

Prefer:

FYERS
 ↓
MarketDataService
 ↓
in-process event
 ↓
CandleBuilder / StrategyEngine

instead of:

FYERS
 ↓
Redis PUBLISH
 ↓
Redis SUBSCRIBE
 ↓
CandleBuilder

However, if the consumer is intentionally a separate process/service, preserve Redis Pub/Sub unless there is a better safe architecture.

Do not break multi-process behavior.

STEP 5 - SEPARATE HOT PATH FROM DURABLE STATE

Establish a clear distinction.

Hot path

These operations happen at very high frequency:

ticks
latest prices
temporary indicator state
temporary strategy state
in-memory candle construction

These should preferably remain in memory.

Durable / coordination path

These may legitimately use Redis:

orders
trade events
locks
distributed coordination
job queues
recovery state
important events
cross-process events
rate limiting
temporary distributed state

Do not move everything into memory.

Do not remove Redis where Redis is required for correctness.

STEP 6 - CHECK IF DASHBOARD IS CAUSING REDIS POLLING

Inspect dashboard/API code for patterns such as:

setInterval
polling
refetchInterval
Redis GET
Redis HGET
Redis MGET

Especially look for:

every 1 second
every 2 seconds
every 5 seconds

Determine whether the dashboard repeatedly queries Redis for:

price
orders
positions
PnL
signals
strategies
risk

If so, determine whether existing Socket.IO infrastructure can push updates instead.

Preferred architecture:

Market Engine
      ↓
Socket.IO
      ↓
Dashboard

rather than:

Dashboard
      ↓
API
      ↓
Redis GET
      ↓
repeat every second

Do not redesign the dashboard unnecessarily.

Only remove unnecessary polling if it is actually contributing to Redis command usage.

STEP 7 - CHECK BULLMQ / QUEUES

Inspect all BullMQ and queue usage.

Look for:

Queue
Worker
QueueEvents
Repeatable jobs
Delayed jobs
Retries
Polling
Heartbeat
Stalled-job checks
Cleanup

Determine whether workers are running continuously during development/testing when they are not required.

Do not remove required queues.

But identify:

unnecessary polling
duplicate workers
high-frequency heartbeat
unnecessary job creation
unnecessary retries
unbounded job history

If queue behavior contributes materially to Redis usage, optimize it safely.

STEP 8 - PIPELINE / BATCH OPERATIONS

Find multiple Redis commands that can safely be grouped.

Example:

Current:

await redis.get("a");
await redis.get("b");
await redis.get("c");
await redis.get("d");

Consider:

await redis.mget("a", "b", "c", "d");

or an appropriate pipeline.

For writes:

await redis.set(...)
await redis.set(...)
await redis.set(...)

consider a pipeline or MSET where semantically safe.

IMPORTANT:

Do not batch operations merely for appearance.

Verify:

ordering requirements
error handling
atomicity requirements
TTL behavior
transaction requirements
STEP 9 - AVOID REDUNDANT TTL OPERATIONS

Find patterns like:

await redis.set(key, value);
await redis.expire(key, 60);

Where appropriate, replace with a single operation that sets the expiry together.

Example:

await redis.set(key, value, { ex: 60 });

Only do this when behavior is exactly equivalent.

Be careful with:

existing TTL preservation
conditional SET
NX/XX semantics
refresh behavior
STEP 10 - DO NOT STORE EVERY INDICATOR IN REDIS

Inspect indicator calculations.

Avoid architectures such as:

tick
 ↓
EMA → Redis
RSI → Redis
ATR → Redis
VWAP → Redis
SMA → Redis
ADX → Redis

If indicators are only required by the same process, calculate them in memory.

Preferred:

Market Data
 ↓
In-memory Candle State
 ↓
Indicator Engine
 ↓
Strategy

Persist only meaningful state/results when required.

STEP 11 - CANDLE DATA

Inspect candle creation.

The current system needs reliable candle data for:

strategy evaluation
trading
historical R&D
replay

Do NOT remove database persistence of completed candles merely to save Redis commands.

The intended separation should be:

LIVE TICK
    ↓
Memory
    ↓
Candle Builder
    ↓
Completed Candle
    ↓
Database

Redis should not be required for every intermediate candle calculation unless there is a demonstrated cross-process requirement.

STEP 12 - PRESERVE TRADING CORRECTNESS

This is a trading system.

Never optimize Redis at the expense of:

duplicate orders
missed orders
incorrect positions
incorrect fills
incorrect PnL
broken risk checks
race conditions
lost events
recovery failures
broker reconciliation

The following flow must continue to work:

FYERS market data
      ↓
Market Data
      ↓
Strategy
      ↓
Signal
      ↓
Risk Engine
      ↓
Order Manager
      ↓
Broker
      ↓
Order
      ↓
Position
      ↓
PnL

Redis optimization must be behavior-preserving.

STEP 13 - ADD A MARKET DATA IN-MEMORY STATE

If architecture analysis confirms that market ticks do not need Redis persistence, implement a typed in-memory state.

Do NOT use any.

Example concept:

interface LatestMarketTick {
  symbol: string;
  ltp: number;
  timestamp: number;
  volume?: number;
}

Then:

private readonly latestTicks = new Map<string, LatestMarketTick>();

Use proper existing project types if they already exist.

Do not create duplicate domain types unnecessarily.

STEP 14 - CONTROL REDIS MARKET EVENTS

If MARKET_TICK is required across processes, investigate whether every tick needs to be published.

Possible architecture:

FYERS
 ↓
MarketDataService
 ↓
in-memory processing
 ↓
CANDLE_CLOSED
 ↓
Redis

Instead of:

every tick
 ↓
Redis

However, do NOT replace tick-level events with candle-level events if an existing strategy genuinely requires tick-level data.

This decision must be based on actual consumers.

STEP 15 - OPTIONAL THROTTLING

Only if the dashboard/UI or a non-trading consumer requires high-frequency market prices, consider throttling that consumer.

For example:

FYERS: 20 ticks/sec
        ↓
Trading engine: every tick
        ↓
Dashboard: 2–5 updates/sec

The trading engine must not be throttled if doing so changes trading behavior.

UI updates can be throttled independently.

Example:

Trading engine
    ↓
every tick

Dashboard
    ↓
latest state
    ↓
throttle 200–500ms

This is especially important because UI does not need 20 updates/sec to display a price.

STEP 16 - REDIS USAGE METRICS

Add development diagnostics that can report:

Redis commands/sec
Market ticks/sec
Redis commands per tick
Redis commands per candle
Redis commands per order

Do not introduce a Redis command counter that itself generates significant Redis traffic.

Prefer local application metrics/logging.

Example target:

market ticks/sec: 15.3
redis commands/sec: 30.6
redis commands/tick: 2.0

After optimization:

market ticks/sec: 15.3
redis commands/sec: target significantly lower
redis commands/tick: ideally near 0 for purely local market processing

The exact target must be based on actual architecture.

STEP 17 - TEST BEFORE AND AFTER

Create or update tests for:

Market data

Verify:

FYERS tick
 ↓
in-memory state
 ↓
candle builder

works exactly as before.

Strategy

Verify strategies receive the same market data.

Risk

Verify risk calculations are unchanged.

Orders

Verify order creation is unchanged.

Position

Verify position updates are unchanged.

Redis

Verify only required Redis operations occur.

Do NOT write brittle tests that depend on an arbitrary exact Redis command count unless the behavior is an explicit contract.

Prefer tests such as:

does not persist every tick to Redis
publishes required cross-process events
preserves required candle events
preserves order events
STEP 18 - ADD A REDIS COMMAND BUDGET TEST/DIAGNOSTIC

Create a development-only diagnostic.

It should report something like:

Redis Usage Report
------------------
Period: 15 seconds

Market ticks: 230
Redis commands: 477

MARKET_TICK publish: 230
hot:price SET: 231
CANDLE_CLOSED publish: 16

Commands/tick: 2.08

After optimization, produce the same report.

This lets us compare:

BEFORE
477 commands / 15 sec

AFTER
??? commands / 15 sec

Do not hardcode the expected final number before understanding the architecture.

STEP 19 - PERFORMANCE VALIDATION

Validate at least:

Application startup
FYERS connection
Market tick reception
Candle generation
Strategy evaluation
Signal generation
Risk evaluation
Order test flow
Position update
PnL update
Dashboard updates
Restart/recovery behavior

Confirm that Redis optimization did not change trading behavior.

STEP 20 - COMPARE REDIS USAGE

Use the same market-data workload before and after.

Capture approximately the same duration:

15 seconds
30 seconds
60 seconds

Compare:

Metric                 Before       After
------------------------------------------------
Market ticks
Redis commands
Commands/sec
Commands/tick
MARKET_TICK publishes
hot:price SETs
CANDLE_CLOSED
Other commands

The result must clearly show the reduction.

STEP 21 - DO NOT OVER-ENGINEER

Do NOT introduce:

Kafka
NATS
RabbitMQ
another Redis instance
another database
complex event sourcing
microservices
Kubernetes
unnecessary abstractions

The current application should remain simple.

The goal is to make the existing architecture efficient.

STEP 22 - FILE CHANGES

Before editing, identify exact files.

After editing, report:

Modified:
- file/path.ts
- file/path.ts

Added:
- file/path.ts

Removed:
- none

Do not modify unrelated files.

STEP 23 - FINAL ACCEPTANCE CRITERIA

The task is complete only if all are true:

Redis
 High-frequency unnecessary Redis writes are removed.
 High-frequency unnecessary Redis Pub/Sub is removed or reduced.
 Required cross-process events remain functional.
 Required distributed locks remain functional.
 Required queue functionality remains functional.
 Required recovery state remains functional.
 No unnecessary Redis polling remains.
 No unnecessary indicator persistence remains.
Market Data
 FYERS ticks continue arriving.
 Latest market state is correctly maintained.
 Candle generation is unchanged.
 Strategy evaluation is unchanged.
 No ticks are lost where the trading engine requires them.
Trading
 Risk Engine behavior is unchanged.
 Order Manager behavior is unchanged.
 Broker execution behavior is unchanged.
 Position behavior is unchanged.
 PnL behavior is unchanged.
 Order reconciliation remains functional.
TypeScript
 No any is introduced.
 Existing types are reused where appropriate.
 No unnecessary duplicate interfaces are created.
Tests
 Existing tests pass.
 New tests pass.
 Typecheck passes.
 Lint passes.
 Build passes.
IMPORTANT TRADING SAFETY RULE

Do NOT place a real BUY or SELL order while implementing or testing this Redis optimization.

Use:

unit tests
integration tests
paper trading
existing order-test mode

Do not introduce any automatic real-order trigger.

The purpose of this task is infrastructure optimization, not live trading.

FINAL REPORT

At the end, provide a concise but technically detailed report with:

1. Root cause

Explain exactly why Redis usage was high.

Example:

230 MARKET_TICK publishes
231 hot:price SETs
16 candle events

477 commands / 15 sec
2. Before architecture

Show:

FYERS
 ↓
Redis SET
 ↓
Redis PUBLISH
 ↓
Consumer
3. After architecture

Show the actual new architecture.

4. Redis commands removed

List exactly which Redis operations were eliminated/reduced.

5. Redis commands retained

Explain why each retained operation is required.

6. Measured improvement

Provide actual before/after measurements.

Example:

Before:
477 commands / 15 sec

After:
XX commands / 15 sec

Reduction:
XX%

Commands/tick:
Before: X
After: X

Do NOT invent measurements.

7. Trading behavior validation

Confirm:

Market data: PASS
Candles: PASS
Strategies: PASS
Risk: PASS
Orders: PASS
Positions: PASS
PnL: PASS
Dashboard: PASS
Recovery: PASS

Only mark PASS when actually tested.

8. Remaining optimization opportunities

List only real findings discovered during the audit.

GOLDEN RULE

Do not optimize Redis by simply deleting Redis calls.

First understand why every command exists.

Then classify every operation:

HIGH FREQUENCY + LOCAL ONLY
        ↓
        MEMORY

HIGH FREQUENCY + CROSS PROCESS
        ↓
        carefully optimized event mechanism

LOW FREQUENCY + IMPORTANT
        ↓
        REDIS

DURABLE STATE
        ↓
        DATABASE

TRADING CRITICAL
        ↓
        preserve reliability first

The final goal is:

FYERS
  ↓
Market Data
  ↓
IN-MEMORY HOT PATH
  ↓
Candle / Indicator / Strategy
  ↓
Signal
  ↓
Risk
  ↓
Order Manager
  ↓
Redis only where actually required
  ↓
Broker

while preserving the existing behavior and correctness of the trading platform.


### One thing I especially want Claude to investigate

Your **477 commands / 15 seconds** is strong evidence, but I would **not immediately delete `PUBLISH events:MARKET_TICK`**. The critical question is whether your strategy engine is consuming that Redis event from another process.

The ideal outcome, if your architecture permits it, is:

```text
                 FYERS
                   ↓
             MarketDataService
                   ↓
          ┌────────┴────────┐
          ↓                 ↓
       MEMORY          Candle Closed
          ↓                 ↓
   Strategy Engine       Redis
          ↓
        Signal
          ↓
         Risk

instead of:

FYERS
 ↓
SET Redis
 ↓
PUBLISH Redis
 ↓
SUBSCRIBE Redis
 ↓
Strategy

That distinction could eliminate a very large portion of your current Redis consumption without compromising the trading engine.
