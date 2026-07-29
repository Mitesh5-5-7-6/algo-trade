# Project Progress Tracker

Based on the `/plan` (specifically `28_ROADMAP.md`) and the current state of the monorepo, here is the status of the project:

## Phase 0 — Foundation (Status: Complete / In-Progress)
- [x] Monorepo skeleton set up
- [x] `core` and `contracts` packages created
- [x] `config` package
- [x] `logger`, `redis`, and `db` packages
- [x] Composition root (API) setup
- [ ] CI pipeline and health model implementation

## Phase 1 — Paper Trading (Status: Complete)
- [x] Dashboard UI structure (e.g., `live.ts` connecting via React Query to API)
- [x] Basic Engine scaffolding (`packages/engines/src/` has `market-data`, `indicators`, `risk`, `order`, `position`, `strategy`)
- [x] Basic strategies package structure
- [x] Broker Interface & FYERS data side
- [x] Indicator Engine with warm-up logic
- [x] Strategy Engine implementation (initial 2-3 strategies)
- [x] Risk Engine (all 4 checks)
- [x] Order Manager & Paper Broker
- [x] Position/Portfolio/PnL chain
- [x] Socket.IO bridge for Dashboard
- [x] Authentication

## Phase 2 — AI Assist (Status: In-Progress)
- [ ] News fetch job
- [ ] AI Sentiment & summary jobs
- [ ] Context integration + confidence modulation
- [ ] AI Summaries page
- [ ] Evaluation loop

## Phase 3 — Live Trading (Status: In-Progress)
- [x] Go-live swap (Wire Broker and Market Data into runtime)
- [ ] Bracket/cover orders
- [ ] TOTP 2FA
- [ ] Staging environment & chaos drills

## Code Review: `apps/dashboard/src/lib/live.ts`
- **Current State:** The code effectively wires up the live trading dashboard to the backend via `@tanstack/react-query`. It defines a `DashboardSnapshot` that components can consume.
- **Good Practices:**
  - `initialData` falls back to `getMockSnapshot()`, which guarantees the dashboard is never blank on initial load (great for optimistic UI).
  - Clean separation of concerns: The `useDashboardData` hook isolates all data fetching from the actual UI components.
  - Efficient polling configuration (`refetchInterval: 60_000` for `pnlCurve` to avoid unnecessary renders).
- **In-Progress Details:** 
  - There are `TODO(read-model)` comments indicating missing live pieces, such as broker mode and live broker health which are blocked by credentials. 
  - The UI gracefully displays the `livePositions` once fetched while relying on mock settings when undefined.
