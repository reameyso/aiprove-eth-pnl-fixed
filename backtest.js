'use strict';
/**
 * Local backtest for the eth-pnl-fixed entry.
 *
 * Replay rules (no phantom fills):
 *   - positions[i] is the target decided at the CLOSE of bar i.
 *   - The fill happens at the OPEN of bar i+1.
 *   - The filled position then earns the move from open[i+1] to open[i+2]
 *     (or to the final bar's close for the last bar) — i.e. open-to-open
 *     marking, which includes the (tiny, mean |gap| $0.008) close->open gaps.
 *   - Any open position is closed out at the final bar's close.
 *
 * Cost model (documented assumptions — the public repo publishes no exact
 * fee rate or sandbox entrypoint, so these are conservative, stated here):
 *   - Taker fee: 10 bps (0.001) of notional on EVERY position change.
 *     The brief mentions maker 5 bps for passive fills; charging taker on
 *     every fill is the conservative choice (maker would only help).
 *   - Slippage: 5 bps (0.0005) scaled by trade size relative to bar volume:
 *       slippage_bps = 5 * min(1, tradeNotional / (barVolume * barClose))
 *     With 1 ETH per unit vs ~283 ETH average bar volume this is ~0.02 bps
 *     per fill — negligible, but the formula is there so a larger size
 *     would be charged more, as the brief requires.
 *   - 1 unit of position = 1 ETH (long +1, short -1, flat 0).
 *
 * Metrics returned:
 *   netPnl, grossPnl, totalCosts, maxDrawdown (USD, on the equity curve),
 *   trades (fills: every position change incl. the final close-out),
 *   roundTrips (entry->exit segments), winRate (share of round trips with
 *   net PnL > 0, after entry+exit costs), buyHoldPnl (1 ETH, same window).
 *
 * Node.js stdlib only.
 */

const TAKER_FEE = 0.001;   // 10 bps per filled trade on notional
const SLIPPAGE_BPS = 0.0005; // 5 bps, scaled by size / bar volume (see below)

function backtest(bars, positions) {
  const n = bars.length;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossPnl = 0;
  let totalCosts = 0;
  let trades = 0; // fills
  let current = 0;

  // Round-trip tracking: one segment per entry->exit (a flip closes one
  // segment and opens another at the same fill price).
  let roundTrips = 0;
  let winningTrips = 0;
  let openEntryPrice = null; // fill price of the currently open segment
  let openEntryCost = 0;     // fee+slippage paid to open it
  let openSize = 0;

  function costOf(deltaUnits, fillBar) {
    const notional = Math.abs(deltaUnits) * fillBar.open;
    const slip = SLIPPAGE_BPS * Math.min(1, notional / (fillBar.volume * fillBar.close));
    return notional * (TAKER_FEE + slip);
  }

  function closeSegment(exitPrice, exitCost) {
    if (openEntryPrice === null) return;
    const segPnl = openSize * (exitPrice - openEntryPrice) - openEntryCost - exitCost;
    roundTrips++;
    if (segPnl > 0) winningTrips++;
    openEntryPrice = null;
    openEntryCost = 0;
    openSize = 0;
  }

  for (let i = 0; i < n - 1; i++) {
    const target = positions[i];
    const fillBar = bars[i + 1]; // fill at next bar's open
    if (target !== current) {
      const cost = costOf(target - current, fillBar);
      equity -= cost;
      totalCosts += cost;
      trades++;
      if (current !== 0) closeSegment(fillBar.open, cost * (Math.abs(current) / Math.abs(target - current)));
      // NOTE: on a flip the single fill cost is split pro-rata between the
      // closing and opening legs; closeSegment above uses the closing share.
      if (target !== 0) {
        openEntryPrice = fillBar.open;
        openEntryCost = cost * (Math.abs(target) / Math.abs(target - current));
        openSize = target;
      }
      current = target;
    }
    // Mark the filled position open[i+1] -> open[i+2] (or final close).
    const exitMark = i + 2 < n ? bars[i + 2].open : bars[n - 1].close;
    const pnl = current * (exitMark - fillBar.open);
    equity += pnl;
    grossPnl += pnl;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDrawdown) maxDrawdown = peak - equity;
  }

  // Close out any open position at the final close.
  if (current !== 0) {
    const cost = Math.abs(current) * bars[n - 1].close * TAKER_FEE;
    equity -= cost;
    totalCosts += cost;
    trades++;
    closeSegment(bars[n - 1].close, cost);
  }

  return {
    netPnl: equity,
    grossPnl,
    totalCosts,
    maxDrawdown,
    trades,
    roundTrips,
    winRate: roundTrips > 0 ? winningTrips / roundTrips : 0,
    winningTrips,
    buyHoldPnl: bars[n - 1].close - bars[0].close,
  };
}

if (require.main === module) {
  const { run, loadBars } = require('./strategy.js');
  const path = require('path');
  const bars = loadBars(path.join(__dirname, 'bars.csv'));
  const r = backtest(bars, run(bars));
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { backtest, COSTS: { TAKER_FEE, SLIPPAGE_BPS } };
