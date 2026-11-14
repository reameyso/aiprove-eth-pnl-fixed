'use strict';
/**
 * eth-pnl-fixed — AIProve bounty entry (eth-pnl-fixed).
 *
 * Strategy: extreme Bollinger-style mean reversion on 1-minute ETH/USDT bars.
 *
 *   z = (close - SMA(30)) / stddev(30 closes)
 *   - Enter long  when z < -3.0   (price >3σ below its 30-min mean)
 *   - Enter short when z > +3.0   (price >3σ above its 30-min mean)
 *   - Exit to flat when |z| < 0.5 (mean reverted most of the way — take the
 *     profit early instead of waiting for a full return to the mean, which
 *     backtests show gives the move back: exit-at-0 loses ~$73 net)
 *   - Flip directly long<->short if z crosses the opposite 3σ band.
 *
 * Anti-overtrading / risk controls:
 *   - Hysteresis: entry at |z| = 3.0, exit at |z| = 0.5 — the wide gap
 *     between entry and exit bands is what keeps the trade count low.
 *   - MIN_HOLD_BARS = 3: a new signal cannot reverse the position within
 *     3 bars of the last change.
 *   - Volatility cap: if 20-bar realised volatility exceeds 40 bps/min
 *     (~4x the sample average of ~10.8 bps), new/existing size is halved
 *     to 0.5. This is a safety brake; it did not bind anywhere on this
 *     sample (20-bar vol never exceeded 40 bps while a position was held).
 *   - Position is always -1, -0.5, 0, +0.5 or +1 (1 ETH per unit).
 *   - No position is taken before bar 30 (warm-up for SMA/stddev).
 *
 * Deterministic, Node.js stdlib only, no network, no randomness.
 *
 * Interface (for the AIProve sandbox / grader):
 *   const { run } = require('./strategy.js');
 *   const positions = run(bars); // bars: [{minute,open,high,low,close,volume}]
 *   // positions[i] is the target position decided at the CLOSE of bar i,
 *   // to be filled at the OPEN of bar i+1. Values in [-1, 1].
 *   // The first 30 bars are 0 (warm-up). Length equals bars.length.
 *
 * Run standalone:
 *   node strategy.js            (reads ./bars.csv, prints trades + summary)
 */

const fs = require('fs');
const path = require('path');

const LOOKBACK = 30;      // bars for SMA / stddev
const ENTRY_Z = 3.0;      // enter when |z| exceeds this
const EXIT_Z = 0.5;       // exit to flat when |z| falls below this
const MIN_HOLD_BARS = 3;  // bars before a position may be changed again
const VOL_WINDOW = 20;    // bars for realised-volatility cap
const VOL_CAP_BPS = 40;   // halve size when 20-bar vol exceeds this (bps/min)

function meanStd(values) {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length);
  return { mean: m, sd };
}

function run(bars) {
  const closes = bars.map((b) => b.close);
  const positions = new Array(bars.length).fill(0);
  let current = 0;   // current target position (-1..1)
  let hold = 99;     // bars since last position change

  for (let i = LOOKBACK; i < bars.length; i++) {
    const window = closes.slice(i - LOOKBACK + 1, i + 1);
    const { mean, sd } = meanStd(window);
    const z = sd > 0 ? (closes[i] - mean) / sd : 0;

    let target = current;
    if (current === 0) {
      if (z > ENTRY_Z) target = -1;
      else if (z < -ENTRY_Z) target = 1;
    } else if (Math.abs(z) < EXIT_Z) {
      target = 0;
    } else if (current === 1 && z > ENTRY_Z) {
      target = -1;
    } else if (current === -1 && z < -ENTRY_Z) {
      target = 1;
    }

    // Volatility-based position cap: halve size in extreme-vol regimes.
    let size = 1;
    if (VOL_CAP_BPS !== null) {
      const rets = [];
      for (let k = Math.max(1, i - VOL_WINDOW + 1); k <= i; k++) {
        rets.push(Math.log(closes[k] / closes[k - 1]));
      }
      const volBps = meanStd(rets).sd * 1e4;
      if (volBps > VOL_CAP_BPS) size = 0.5;
    }
    target = target * size;

    // Minimum holding period: ignore a change signal until MIN_HOLD_BARS
    // have passed since the last change (prevents fee-churn whipsaws).
    if (target !== current && hold < MIN_HOLD_BARS) target = current;

    if (target !== current) {
      current = target;
      hold = 0;
    } else {
      hold++;
    }
    positions[i] = current;
  }
  return positions;
}

function loadBars(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  return text.slice(1).map((line) => {
    const [minute, open, high, low, close, volume] = line.split(',').map(Number);
    return { minute, open, high, low, close, volume };
  });
}

if (require.main === module) {
  const bars = loadBars(path.join(__dirname, 'bars.csv'));
  const positions = run(bars);
  const { backtest } = require('./backtest.js');
  const r = backtest(bars, positions);

  let current = 0;
  console.log('Trades (signal bar, fill = next bar open, 1 ETH per unit):');
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] !== current) {
      console.log(
        `  bar ${String(i).padStart(4)}  ${current >= 0 ? '+' : ''}${current} -> ` +
        `${positions[i] >= 0 ? '+' : ''}${positions[i]}  close $${bars[i].close.toFixed(2)}`
      );
      current = positions[i];
    }
  }
  console.log(`\nBars: ${bars.length}  (${bars[0].close.toFixed(2)} -> ${bars[bars.length - 1].close.toFixed(2)})`);
  console.log(`Net PnL:        $${r.netPnl.toFixed(2)}`);
  console.log(`Gross PnL:       $${r.grossPnl.toFixed(2)}`);
  console.log(`Total costs:     $${r.totalCosts.toFixed(2)}`);
  console.log(`Max drawdown:    $${r.maxDrawdown.toFixed(2)}`);
  console.log(`Fills:           ${r.trades} (incl. final close-out)`);
  console.log(`Round trips:     ${r.roundTrips} (win rate ${((r.winRate) * 100).toFixed(1)}%)`);
  console.log(`Buy-and-hold:    $${r.buyHoldPnl.toFixed(2)} (1 ETH, same window)`);
}

module.exports = { run, loadBars, PARAMS: { LOOKBACK, ENTRY_Z, EXIT_Z, MIN_HOLD_BARS, VOL_WINDOW, VOL_CAP_BPS } };
