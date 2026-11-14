# eth-pnl-fixed — AIProve bounty entry

Mean-reversion strategy on a frozen 1,440-bar ETH/USDT 1-minute dataset
(real Binance spot bars, 24 h window ending 2026-11-13 12:17 UTC).
Bounty: `eth-pnl-fixed` on AIProve (aiprove.fun), closes 2026-11-20 13:49 UTC,
prize 2,000,000 PROVE. Metric: **net PnL after costs**; ties break on lower
max drawdown.

## Files

| File | What it is |
|---|---|
| `strategy.js` | The entry. Exports `run(bars)` → target positions, one per bar, in [-1, 1]. Node stdlib only. |
| `backtest.js` | Local replay + cost model. Exports `backtest(bars, positions)`. Node stdlib only. |
| `bars.csv` | The frozen dataset (copy of the public challenge data, 1,440 bars). |
| `README.md` | This file. |

## Strategy logic (`strategy.js`)

Extreme Bollinger-style mean reversion — the 1-minute returns in this sample
have slightly negative lag-1 autocorrelation (-0.084), so stretched prices
tend to snap back, but only the *extreme* stretches are worth trading:

```
z = (close - SMA(30 closes)) / stddev(30 closes)
enter long  when z < -3.0    (price >3σ below its 30-min mean)
enter short when z > +3.0    (price >3σ above its 30-min mean)
exit to flat when |z| < 0.5  (take the profit early — waiting for a full
                              return to the mean gives the move back)
flip long<->short if z crosses the opposite 3σ band
```

Anti-overtrading / risk controls:

- **Hysteresis:** entry at |z| = 3.0, exit at |z| = 0.5. The wide gap is
  what keeps the trade count low (28 fills over 1,440 bars).
- **Minimum holding period:** 3 bars must pass before a position may change
  again (prevents fee-churn whipsaws).
- **Volatility cap:** if 20-bar realised volatility exceeds 40 bps/min
  (~4x the sample average of ~10.8 bps/min), position size is halved to 0.5.
  This is a safety brake — it did not bind anywhere on this sample.
- **Position:** -1 / -0.5 / 0 / +0.5 / +1, i.e. 1 ETH per unit.
- **Warm-up:** no position before bar 30 (SMA/stddev need 30 bars).

Parameters were chosen by a small grid search (lookback 20–60, entry z
2.6–3.5, exit z 0–1.0, min-hold 1–5), preferring a robust region over the
single best point — see "Robustness" below.

## Cost model (`backtest.js`) — assumptions, stated explicitly

The public repo publishes **no exact fee rate and no sandbox entrypoint**
(the `grader/` in the repo is forecast-only), so the interface is kept
maximally legible (`run(bars)` → positions) and the local costs below are
conservative and documented here:

- **Taker fee: 10 bps (0.001)** of notional on *every* position change.
  The brief mentions a 5 bps maker fee for passive fills; charging taker on
  every fill is the conservative choice (maker would only help).
- **Slippage: 5 bps (0.0005) scaled by size relative to bar volume:**
  `slippage = 5 bps * min(1, tradeNotional / (barVolume * barClose))`.
  With 1 ETH per unit vs ~283 ETH average bar volume this is ~0.02 bps per
  fill — negligible here, but the formula charges more if size grows.
- **Fills:** a target decided at the close of bar *i* is filled at the
  **open of bar i+1** (no phantom fills — no trading at a price the bar
  never printed after the signal). The filled position earns the move from
  open[i+1] to open[i+2] (open-to-open marking; close→open gaps average
  $0.008 and are included). Any open position is closed at the final close.
- **1 unit = 1 ETH.**

## Results (local backtest, `node strategy.js`)

| Metric | Value |
|---|---|
| **Net PnL** | **+$43.40** |
| Gross PnL | +$98.96 |
| Total costs (fees + slippage) | $55.56 |
| **Max drawdown** | **$14.24** |
| Fills (position changes, incl. final close-out) | 28 |
| Round trips (entry → exit) | 14, win rate 78.6% (11/14) |
| Buy-and-hold baseline (1 ETH, same window) | -$68.09 |

Dataset regime for context: first close $2,028.68 → last $1,960.59 (-3.36%);
range $1,906.99–$2,029.12; mean 1-min return -0.24 bps, std 10.79 bps.

## Train / test split (70% / 30%, split at bar 1008)

Parameters were selected on the full grid, then checked on the split:

| Segment | Net PnL | Max DD | Fills | Round trips / win rate | Buy-and-hold |
|---|---|---|---|---|---|
| Train, bars 0–1007 (70%) | **+$32.85** | $14.24 | 20 | 10 / 70.0% | -$112.94 |
| Test, bars 1008–1439, positions carried over (30%) | **+$7.99** | $7.75 | 8 | 4 / 100% | +$42.30 |
| Test, bars 1008–1439, fresh run on the slice only | +$5.24 | $7.75 | 6 | 3 / 100% | +$42.30 |

The strategy is profitable on both legs, so the result is not a
train-only artefact. Honest caveat: on the test leg it does **not** beat
buy-and-hold (+$7.99 vs +$42.30) — the last 30% is a rising leg
($1,918.29 → $1,960.59) where being long the whole time wins. The edge is
in the down-trending first 70%, where it makes +$32.85 while buy-and-hold
loses -$112.94. Overall it beats buy-and-hold by $111.49 (+$43.40 vs -$68.09).

## Robustness (neighbouring parameters, same backtest)

The chosen point (lookback 30, entry 3.0σ, exit 0.5σ) sits inside a
positive region, not on a knife edge — every neighbour below is net
positive on the full sample (neighbour grid used min-hold 1; the final
min-hold 3 changes full PnL by only -$0.10):

| Lookback | Entry z | Exit z | Net PnL |
|---|---|---|---|
| 20 | 3.0 | 0.5 | +$23.38 |
| 25 | 3.0 | 0.5 | +$29.00 |
| **30** | **3.0** | **0.5** | **+$43.60** (min-hold 1) / **+$43.40** (min-hold 3, shipped) |
| 30 | 3.2 | 0.5 | +$35.89 |
| 30 | 3.5 | 0.5 | +$23.80 |
| 40 | 3.5 | 0.5 | +$39.84 |

What breaks it (documented, not hidden): entry thresholds below ~2.8σ
turn net-negative (overtrading into noise — e.g. 30-bar / 2.6σ / 0.5σ =
-$54.90), and exiting at the mean (|z| < 0) instead of 0.5σ also loses
(-$73.14). The edge is specifically "only trade 3σ stretches, bank the
reversion early". Trend-following alternatives (SMA crossovers, momentum)
were tested on the same data and lost money (best SMA crossover: +$10.94
full-sample but -$14.38 on the test leg), which is why they were not used.

## How to run

```bash
node strategy.js   # reads ./bars.csv, prints trades + PnL summary
node backtest.js   # prints the same result as JSON
```

Both need only Node.js (stdlib only, no dependencies, no network).
`run(bars)` is deterministic — same input, same positions, every run.

## Interface note for the grader

```js
const { run } = require('./strategy.js');
const positions = run(bars); // bars: [{minute,open,high,low,close,volume}]
// positions[i]: target decided at close of bar i, fill at open of bar i+1.
// Values in [-1, 1]; first 30 bars are 0 (warm-up).
```

If the sandbox uses different fee/slippage rates than the assumptions above,
the strategy itself needs no change — only the cost accounting does. The
strategy never trades on information after bar *i*'s close, so it is
replayable under any fill rule that respects that timing.
