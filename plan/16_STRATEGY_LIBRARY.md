# 16 — Strategy Library

> Prerequisite: **[15_STRATEGY_ENGINE.md](15_STRATEGY_ENGINE.md)** — every strategy here implements that contract: pure `analyze(context) → Signal`, indicators declared not computed, SL/target attached to entries, exits enforced by the engine's position watcher.
>
> **Template discipline:** every strategy below is specified with the same eleven attributes — *Formula · Inputs · Outputs · Buy conditions · Sell conditions · Stop Loss · Target · Strengths · Weaknesses · Suitable market · Unsuitable market* — so strategies are comparable, and adding a ninth strategy means filling the same template, not inventing a new format.

---

## 0. Conventions used throughout

- `C, O, H, L, V` = close, open, high, low, volume of a bar; subscript `t` = current bar, `t−1` = previous. All decisions are on **closed candles** (Chapter 15 §4).
- **R-multiple targets:** `R = |entry − stopLoss|` (the risk per share). "Target = 2R" means `entry + 2R` for longs, `entry − 2R` for shorts. **Why R-based defaults:** they tie reward directly to the risk actually taken, so a strategy's edge is expressed as risk:reward, comparable across symbols and prices.
- **Sell conditions** below mean *exit long / enter short* per the strategy's config (`allowShort` parameter); intraday Indian equity supports both.
- **Tolerances:** equality conditions (e.g., Open = Low) use a configurable tolerance `ε` (basis points), because exact tick equality is rare and would make the condition nearly untriggerable.
- Every entry signal also carries `confidence`, computed from how decisively the condition was met (each strategy notes its measure), then modulated by AI sentiment (Chapter 15 §6, Chapter 20).
- All parameters shown are **defaults** — operator-configurable per Chapter 07 `strategies.params`, validated by each strategy's Zod schema.

---

## 1. OHL (Open = High / Open = Low)

An Indian intraday classic: read the first bar's verdict on opening sentiment.

- **Formula:**
  - Bullish condition: `|O_first − L_first| ≤ ε · O_first` (open equals the low of the first candle — sellers never pushed below open).
  - Bearish condition: `|O_first − H_first| ≤ ε · O_first` (open equals the high — buyers never pushed above open).
  - Evaluated once, on the close of the first reference candle (default: the 09:15–09:30 IST 15-minute bar).
- **Inputs:** first-candle OHLC; `ε` (default 5 bps); reference interval (default 15m); optional volume floor.
- **Outputs:** at most one entry signal per symbol per day, at first-candle close. Confidence scales with the first candle's range and volume (a wide, high-volume O=L bar is stronger conviction than a doji).
- **Buy conditions:** bullish condition true → BUY at first-candle close.
- **Sell conditions:** bearish condition true → SELL/short at first-candle close. Exit any open trade at stop, target, or square-off before `MARKET_CLOSE`.
- **Stop Loss:** longs — below `L_first`; shorts — above `H_first`. **Why:** the first candle's extreme *is* the thesis ("that level held"); if it breaks, the thesis is dead.
- **Target:** default `2R`; alternative: first-candle range projected from entry.
- **Strengths:** dead simple; one clean decision per day; captures genuine strong-open conviction; trivially auditable.
- **Weaknesses:** one bar of evidence — vulnerable to opening whipsaws and news reversals; low trade frequency; `ε` sensitivity.
- **Suitable market:** trending days with decisive opens (gap-and-run days, post-news directional opens).
- **Unsuitable market:** choppy/range-bound opens, doji first candles, days dominated by mid-session news.

---

## 2. EMA Crossover

Trend-following on the crossing of two exponential moving averages.

- **Formula:**
  - `EMA_t = α · C_t + (1 − α) · EMA_{t−1}`, with `α = 2/(N+1)`; seeded with `SMA(N)` over the first N bars (hence warm-up, Chapter 15 §2).
  - Compute `EMA_fast` (default N=9) and `EMA_slow` (default N=21).
  - Crossover up: `EMA_fast,t > EMA_slow,t` AND `EMA_fast,t−1 ≤ EMA_slow,t−1`. Crossover down: mirrored.
- **Inputs:** closes; fast/slow periods (9/21); candle interval (default 5m); optional trend filter (e.g., price above VWAP).
- **Outputs:** entry on crossover; opposite crossover doubles as exit. Confidence scales with the separation `|EMA_fast − EMA_slow| / C` at cross and its slope.
- **Buy conditions:** crossover up on a closed bar (plus filters if configured).
- **Sell conditions:** crossover down → exit long / enter short.
- **Stop Loss:** below the most recent swing low (longs) / above swing high (shorts); fallback: below `EMA_slow`. **Why swing-based:** the structural level invalidates the trend thesis; the EMA fallback keeps the stop mechanical when no clean swing exists.
- **Target:** default `2R`, or ride until the opposite cross (pure trend-following mode) — configurable.
- **Strengths:** the canonical trend capture; smooth, well-understood behavior; few parameters; works across symbols.
- **Weaknesses:** **lag by construction** — entries come after the move starts, exits after it ends; whipsaws brutally in ranges (repeated small losses).
- **Suitable market:** sustained directional trends with pullbacks.
- **Unsuitable market:** sideways/consolidating markets — the crossover's known failure mode.

---

## 3. RSI (Relative Strength Index) — mean reversion

Fade exhaustion: buy oversold recoveries, exit into overbought.

- **Formula (Wilder):**
  - Per bar: `gain_t = max(C_t − C_{t−1}, 0)`, `loss_t = max(C_{t−1} − C_t, 0)`.
  - Seed: `avgGain = mean(gain, N)`, `avgLoss = mean(loss, N)` over first N bars (default N=14).
  - Then Wilder smoothing: `avgGain_t = (avgGain_{t−1}·(N−1) + gain_t)/N` (same for loss).
  - `RS = avgGain/avgLoss`;  `RSI = 100 − 100/(1 + RS)` (RSI = 100 when avgLoss = 0).
- **Inputs:** closes; period N=14; oversold level (30), overbought level (70); interval (5m).
- **Outputs:** mean-reversion entries/exits. Confidence scales with the depth of the extreme (RSI 18 recovering is stronger than RSI 29) and the sharpness of the cross back.
- **Buy conditions:** `RSI_{t−1} < 30` AND `RSI_t ≥ 30` — the **cross back up through** oversold. **Why the re-cross, not the raw level:** buying while RSI is *still falling* through 25, 20, 15 is catching a falling knife; the re-cross demands the first evidence of recovery.
- **Sell conditions:** exit long when `RSI` crosses down through 70 (or stop/target); short entry: cross back **down through** 70 (mirror logic).
- **Stop Loss:** below the recent swing low that formed the oversold extreme (longs); mirrored for shorts.
- **Target:** default the midline (RSI ≈ 50) reversion price or `1.5R` — mean-reversion targets are deliberately modest. **Why:** the edge is a snap-back, not a trend; overstaying converts winners into losers.
- **Strengths:** exploits a real, persistent intraday tendency (short-term overreaction); bounded oscillator is regime-legible; complements trend strategies.
- **Weaknesses:** **in strong trends RSI stays pinned** — "oversold" keeps getting more oversold and every fade loses; fixed 30/70 levels are blunt across volatility regimes.
- **Suitable market:** range-bound, oscillating markets with defined support/resistance.
- **Unsuitable market:** strong trending days (exactly where EMA crossover shines — the two are near-complements).

---

## 4. VWAP (Volume-Weighted Average Price) — bias + pullback

Trade with the session's institutional benchmark: VWAP as fair value and dynamic support/resistance.

- **Formula:**
  - Typical price: `TP_t = (H_t + L_t + C_t)/3`.
  - `VWAP_t = Σ_{i=open..t}(TP_i · V_i) / Σ_{i=open..t}(V_i)` — **cumulative from session open, reset daily.** **Why session-anchored:** VWAP's meaning *is* "the average price paid today"; carrying it across sessions destroys that meaning (this is why the Indicator Engine resets it on `MARKET_OPEN`, Chapter 18).
- **Inputs:** HLC + volume per bar; interval (1m/5m); pullback tolerance band `b` (default ±0.1%); optional deviation bands.
- **Outputs:** pullback entries in the direction of the VWAP bias. Confidence scales with how cleanly price rejected the VWAP touch (wick through, close back above) and the session's one-sidedness.
- **Buy conditions:** price established **above** VWAP (bias long), pulls back to within `±b` of VWAP, and the touching candle **closes back above** VWAP → BUY. **Why demand the close-back:** touching VWAP is ambiguous; closing back above is the rejection that confirms buyers defended fair value.
- **Sell conditions:** mirror below VWAP for shorts; exit long on a decisive close below VWAP (bias lost), stop, or target.
- **Stop Loss:** just beyond the other side of VWAP (or beyond the pullback candle's extreme). **Why:** the thesis is "VWAP holds as support"; a true break of it is the thesis failing.
- **Target:** default `2R`, or the session high (longs) as a structural magnet.
- **Strengths:** anchored to real order flow (volume-weighted, not just price); self-adjusting intraday level watched by institutions — self-fulfilling relevance; natural bias filter for other strategies.
- **Weaknesses:** frequent whipsaw when price oscillates *around* VWAP (no bias); early-session VWAP is unstable (few bars of volume); needs reliable volume data.
- **Suitable market:** liquid symbols on days with a clear one-sided bias and orderly pullbacks.
- **Unsuitable market:** VWAP-hugging chop; illiquid symbols where single prints distort volume weighting.

---

## 5. ORB (Opening Range Breakout)

Let the first minutes define the battlefield; trade the escape from it.

- **Formula:**
  - Opening range over the first K minutes (default 15: 09:15–09:30 IST): `OR_high = max(H)`, `OR_low = min(L)` over that window; `range = OR_high − OR_low`.
  - Breakout up: first bar after the window with `C_t > OR_high` (close-based to filter wick fakes). Breakout down: `C_t < OR_low`.
- **Inputs:** K (15/30 min); interval (5m); optional volume confirmation `V_t ≥ k · avgVol` (k default 1.5); optional minimum range floor.
- **Outputs:** at most one breakout entry per direction per day. Confidence scales with breakout-bar volume and the margin of the close beyond the range.
- **Buy conditions:** close above `OR_high` after the window (plus volume filter if configured).
- **Sell conditions:** close below `OR_low` → short entry (or exit any long); exits otherwise at stop/target/square-off.
- **Stop Loss:** default the **range midpoint** `(OR_high + OR_low)/2`; conservative variant: the opposite range boundary. **Why midpoint default:** a genuine breakout shouldn't retrace deep into the range; the midpoint halves the risk per share versus the far boundary, improving R while still allowing normal retest behavior.
- **Target:** measured move — `1× range` beyond the breakout level (default), `2×` for runners. **Why range-projected:** the opening range sizes the day's initial energy; projecting it is the classic, self-consistent objective.
- **Strengths:** crisp, fully mechanical levels known within minutes; naturally early positioning for trend days; every parameter auditable.
- **Weaknesses:** **false breakouts are the tax** — break, trigger, collapse back into the range; narrow-range opens produce noise-level signals (hence the range floor); one shot per direction per day.
- **Suitable market:** days with post-open directional resolution — event days, gap follow-through days, high-volatility opens with real range.
- **Unsuitable market:** tight consolidation days where the "range" is noise and price re-enters it repeatedly.

---

## 6. Gap Up (gap-and-go continuation)

Overnight repricing as fuel: trade the continuation of a strong gap.

- **Formula:**
  - `gap% = (O_today − C_prevDay) / C_prevDay × 100`.
  - Qualify: `gap% ≥ G` (default 0.75%; symmetric Gap Down variant with `≤ −G` for shorts if enabled).
  - Trigger: first-candle high breakout — `C_t > H_first` on a bar after the first (default 5m first candle), with volume confirmation `V ≥ k · avgVol`.
- **Inputs:** previous close, today's open; `G`; first-candle interval; `k` (default 1.5); optional gap ceiling `G_max` (very large gaps tend to exhaust, not continue).
- **Outputs:** at most one continuation entry per qualifying gap day. Confidence scales with gap size (within `[G, G_max]`), relative volume, and how firmly the first candle held above the open.
- **Buy conditions:** qualifying gap up AND price holds ≥ `O_today` through the first candle AND breaks `H_first` on volume. **Why the hold-above-open filter:** a gap that immediately trades below its open is already filling — the continuation thesis is dead before it starts; demanding the hold screens out fade-type gaps.
- **Sell conditions:** exit at stop/target/square-off; Gap Down mirror for short entries if `allowShort`.
- **Stop Loss:** below `L_first` (the gap day's first defended level); deeper variant: the gap-fill level `C_prevDay` (wider stop, stronger invalidation).
- **Target:** default `2R`; alternative: `1× first-candle range` projected, or trail once `1R` is achieved.
- **Strengths:** overnight news creates genuine information asymmetry worth trading; the volume + hold-above-open filters are effective trap screens; clearly defined risk levels from minute one.
- **Weaknesses (and they're the story with gaps):** **gap fills are the classic trap** — a large open, early strength, then a full retrace to yesterday's close; low-volume gaps (no institutional participation) fail disproportionately; exhaustion gaps into major resistance reverse; only a handful of qualifying days per symbol per month.
- **Suitable market:** earnings/news-driven gaps with heavy relative volume and room overhead (no immediate resistance).
- **Unsuitable market:** small drift gaps in quiet tape; gaps directly into strong prior resistance; broad-market gap days where the symbol's gap is just beta.

---

## 7. SuperTrend

An ATR-based trailing band that flips with the trend — entry signal and trailing stop in one construct.

- **Formula:**
  - True range: `TR_t = max(H_t − L_t, |H_t − C_{t−1}|, |L_t − C_{t−1}|)`; `ATR` = Wilder smoothing of TR over N (default 10).
  - Basic bands: `mid = (H_t + L_t)/2`; `basicUpper = mid + m·ATR_t`; `basicLower = mid − m·ATR_t` (multiplier m default 3).
  - Final bands (the carry-forward rule that makes the line *ratchet* rather than flap):
    - `finalUpper_t = basicUpper_t` if `basicUpper_t < finalUpper_{t−1}` or `C_{t−1} > finalUpper_{t−1}`, else `finalUpper_{t−1}`.
    - `finalLower_t = basicLower_t` if `basicLower_t > finalLower_{t−1}` or `C_{t−1} < finalLower_{t−1}`, else `finalLower_{t−1}`.
  - Line & trend: in an uptrend the SuperTrend line is `finalLower` (below price); it flips to downtrend when `C_t < finalLower_t`, whereupon the line becomes `finalUpper` — and vice-versa. **Why the carry-forward rule matters:** without it the bands would loosen whenever volatility expands, letting the stop *retreat*; the ratchet ensures the trailing line only ever tightens in your favor.
- **Inputs:** OHLC; ATR period N=10; multiplier m=3; interval (5m/15m).
- **Outputs:** entries on trend flips; a **continuously trailing stop** (the line itself) pushed to the engine's position watcher each bar (Chapter 15 §5). Confidence scales with the flip's decisiveness (close's distance beyond the band in ATR units).
- **Buy conditions:** trend flips down→up (`C_t` closes above `finalUpper`).
- **Sell conditions:** trend flips up→down (`C_t` closes below `finalLower`) — this is simultaneously the long exit and the short entry (if enabled).
- **Stop Loss:** **the SuperTrend line itself, trailing** — updated every bar. This is the strategy's defining property: the stop is not a static level but the indicator.
- **Target:** none by default — ride until the flip (pure trend capture); optional `2R` partial-booking variant.
- **Strengths:** volatility-adaptive by construction (ATR sizes the buffer to current conditions); built-in trailing exit means winners run mechanically; visually and forensically legible (one line, one side).
- **Weaknesses:** same family curse as all trend followers — **whipsaw in ranges** (flip, stop, flip, stop); ATR lag on sudden volatility spikes; parameters (10, 3) meaningfully change character and need per-symbol sanity.
- **Suitable market:** sustained trends with normal volatility — the strategy's whole design assumption.
- **Unsuitable market:** tight ranges and low-volatility drift, where the bands sit inside the noise.

---

## 8. Volume Breakout

Price escaping a consolidation is opinion; volume confirming it is participation.

- **Formula:**
  - Resistance: `res = max(H_{t−M..t−1})` — the highest high of the prior M bars (default 20), excluding the current bar.
  - Volume baseline: `avgVol = SMA(V, P)` (default P=20).
  - Breakout: `C_t > res` **AND** `V_t ≥ k · avgVol` (k default 2.0). Mirror for breakdown shorts: `C_t < support` with the same volume gate.
- **Inputs:** OHLCV; lookback M=20; volume period P=20; multiplier k=2.0; interval (5m/15m); optional consolidation-tightness filter (range of last M bars below a threshold — tighter coils break harder).
- **Outputs:** breakout entries. Confidence scales with the volume ratio `V_t/avgVol` and the closing margin above `res`. **Why volume is a gate, not a bonus:** a price-only breakout can be a single participant's spray; `k×` average volume is evidence of broad participation, which is what distinguishes an initiative move from noise. Cutting the volume condition converts this strategy into a false-breakout generator.
- **Buy conditions:** breakout condition true on a closed bar.
- **Sell conditions:** breakdown short (if enabled); exits at stop/target/square-off.
- **Stop Loss:** just below `res` (the broken resistance should now act as support — "polarity flip"); fallback: below the breakout bar's low if that's tighter.
- **Target:** measured move — the height of the consolidation (`res − min(L)` over the lookback) projected from the breakout; default alternative `2R`.
- **Strengths:** the volume gate is a genuinely discriminating filter (most price-only breakouts fail; volume-confirmed ones fail less); clean structural levels for stop and target; works on any liquid symbol without tuning per name.
- **Weaknesses:** volume spikes can *themselves* be traps (stop-hunts print huge volume too); `avgVol` is distorted early in the session and around known high-volume times (open/close), so `k` needs time-of-day awareness; late entries when the breakout bar is huge (poor R at fill).
- **Suitable market:** liquid symbols emerging from visible, tight consolidations — especially with a market-wide tailwind.
- **Unsuitable market:** illiquid names (volume signal meaningless), news-halt reopenings (volume distorted), and wide sloppy "consolidations" with no real level to break.

---

## 9. The library as a portfolio

The eight strategies are deliberately **regime-complementary**, and the operator should read them that way rather than enabling everything everywhere:

| Regime | Thrives | Suffers |
|---|---|---|
| Strong trend | EMA Crossover, SuperTrend, VWAP pullback | RSI mean-reversion |
| Range / chop | RSI | EMA, SuperTrend, ORB (whipsaw) |
| Decisive open / event day | OHL, ORB, Gap Up | — |
| Consolidation → expansion | Volume Breakout | — |

**Why this matters architecturally:** no strategy is good in all regimes — the honest weakness sections above are half the value of this chapter. The system's edge comes from the operator enabling the right subset for conditions (and, in Phase 2, from AI sentiment nudging confidence toward the regime-appropriate strategies, Chapter 20) — never from one strategy pretending to be universal.

---

## 10. Adding a ninth strategy (checklist)

1. Implement the Chapter 15 contract (`analyze` pure; indicators declared; warm-up stated; SL/target on entries; `reason` populated).
2. Define its Zod params schema in `core`; register the `type` in the registry (Chapter 15 §4).
3. **Write its section here using the eleven-attribute template — including honest Weaknesses and Unsuitable-market entries.** A strategy documented without its failure modes is not documented.
4. Unit-test `analyze()` against fabricated contexts covering both its trigger and its known traps (Chapter 27).

---

*Previous: **[15_STRATEGY_ENGINE.md](15_STRATEGY_ENGINE.md)**  ·  Next: **[17_MARKET_DATA_ENGINE.md](17_MARKET_DATA_ENGINE.md)** — the feed that drives all of the above.*
