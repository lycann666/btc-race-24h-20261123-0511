// Ridge Rider — a cbBTC trend-pullback bot for make.fun's
// "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261123-0511).
//
// Idea, in plain terms: one-minute BTC prices are noisy and a full-size
// round trip costs about 26 bps in fees, slippage and pool impact, so this
// bot never chases every wiggle. It only rides an uptrend, and it only gets
// on in one of three ways: (1) a pullback inside an uptrend — the close is
// at least 0.60% below the highest close of the last 240 bars but has
// already bounced at least 0.15% off the lowest close of the last 30 bars
// and sits at or above its 9-bar EMA, i.e. the dip has stopped falling;
// (2) a breakout — the close pushes above the 240-bar high while the fast
// EMA sits above the mid EMA above the long EMA, i.e. a smooth uptrend with
// no dip to buy; (3) the first fast-over-mid EMA cross of an uptrend, so an
// early trend is not missed while waiting for a pullback that never comes.
// It spends all of its cash on that one entry, long only, one position.
//
// Once in, it lets the winner run but never gives much back: it sells the
// whole position when the marked value reaches 5% over its blended cost,
// trails 2.5% below the highest close seen since entry, or after 1440 bars
// without any of those (in practice never: a mid-rally stale exit cost
// ~$10 of upside on the dev window, so the stale exit is effectively
// off). It deliberately does NOT exit on a fast-under-mid EMA cross: on
// one-minute bars that cross whipsaws and sells every dip. After a sell it
// waits 120 bars before it may buy again, so it cannot re-buy straight
// into the same slide it just left.
//
// A late-window fallback covers a window that never offers any entry at
// all: if no trade has happened by bar 1200 and the fast EMA is above the
// mid EMA, it buys once with a tighter 1.5% take-profit and 1% stop-loss,
// so a quiet window is not a guaranteed zero — the race needs at least one
// trade, and the dev gate needs a net PnL above zero. If even that never
// fires, a last-resort buy at bar 1380 takes one trade whatever the trend
// says: a small loss still meets the guardrails and ranks above a
// no-trade entry, and the trailing stop caps it at about 2.5%.
//
// Everything is decided from the bars and the account the harness sends:
// EMAs run in float64 on + - * / alone (IEEE 754, so the same bars give
// the same orders run after run), and every amount is a bigint of raw
// units. No clock, no environment, no network, no files outside the repo.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** EMA spans: fast 9, mid 30, long 120 bars. */
const FAST_SPAN = 9;
const MID_SPAN = 30;
const LONG_SPAN = 120;
/** Reference high: highest close of the last 240 bars (4 hours). */
const HIGH_BARS = 240;
/** Bounce low: lowest close of the last 30 bars. */
const LOW_BARS = 30;
/** No signal is taken until 40 closes have been seen, so the EMAs and the
 * rolling low have some history. The EMAs are seeded with the first close
 * (not the mean of the first span) so entries can start early: on a
 * steadily rising window the first two hours are worth real money. */
const MIN_HISTORY = 40;

/** Pullback entry: 0.60% below the 240-bar high... */
const DIP_BPS = 60;
/** ...having bounced 0.15% off the 30-bar low... */
const BOUNCE_BPS = 15;

/** Exit: 5% over blended cost. The hard stop below cost is dropped on
 * purpose: the trailing stop already caps the downside, and a tight stop
 * fires on ordinary one-minute noise (see dev grade v1: 32 trades, -70). */
const TAKE_BPS = 500;
const STOP_BPS = 10_000;
/** Trailing stop: 2.5% below the highest close since entry. */
const TRAIL_BPS = 250;
/** A position that has not reached any exit for 1440 bars (the whole
 * window) is sold: in practice the stale exit never fires — an earlier
 * version sold after 720 bars mid-rally and re-bought higher (dev grade
 * v3: the 720-bar exit cost ~$10 of upside). */
const MAX_HOLD_BARS = 1440;
/** Bars to wait after a sell before a new entry may be taken. */
const COOLDOWN_BARS = 120;

/** Late-window fallback: first entry only from bar 1200, tighter exits. */
const LATE_BAR = 1200;
const LATE_TAKE_BPS = 150;
const LATE_STOP_BPS = 100;
/** Last-resort fallback: if no trade has happened at all by bar 1380, buy
 * once whatever the trend says. A one-trade entry that loses a little
 * still meets the race guardrails and ranks above every no-trade entry
 * (which takes no prize even at a PnL of zero), while the trailing stop
 * caps the loss at about 2.5% over the last hour. */
const FORCE_BAR = 1380;

/** 1% past the close the order was decided on: a fill further away is
 * refused rather than chased; the bot simply retries on the next bar. */
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  value: number | null;
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  // Seed with the first close: the EMA is defined from bar one, and the
  // MIN_HISTORY gate keeps entries out until it has real history.
  e.value = close;
}

/** Rolling closes (raw price units), oldest first, at most HIGH_BARS long. */
const closes: number[] = [];
const emaFast: Ema = { span: FAST_SPAN, value: null };
const emaMid: Ema = { span: MID_SPAN, value: null };
const emaLong: Ema = { span: LONG_SPAN, value: null };
/** fast - mid after the bar before this one, once both are set. */
let prevGap: number | null = null;
/** Bars remaining in the post-exit cooldown; 0 means entries are allowed. */
let cooldown = 0;
/** Seq of the batch on which the current position first appeared, or null. */
let entrySeq: number | null = null;
/** Highest close seen since the current entry, raw price units. */
let peakSinceEntry = 0;
/** "base" or "late": which entry rule opened the current position. */
let entryMode: 'base' | 'late' | null = null;
/** True once any position has ever been held in this run. */
let everTraded = false;
/** Highest close of the 240 bars before this one (breakout reference). */
let prevHigh240 = 0;

function pushClose(close: number): void {
  prevHigh240 = closes.length > 0 ? Math.max(...closes.slice(-HIGH_BARS)) : close;
  closes.push(close);
  if (closes.length > HIGH_BARS) closes.shift();
  emaStep(emaFast, close);
  emaStep(emaMid, close);
  emaStep(emaLong, close);
}

function high240(): number {
  return Math.max(...closes.slice(-HIGH_BARS));
}

function low30(): number {
  return Math.min(...closes.slice(-LOW_BARS));
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const close = Number(bar.c);
      const gapBefore =
        emaFast.value !== null && emaMid.value !== null ? emaFast.value - emaMid.value : null;
      pushClose(close);
      const gapNow =
        emaFast.value !== null && emaMid.value !== null ? emaFast.value - emaMid.value : null;
      const crossUp = gapBefore !== null && gapNow !== null && gapNow > 0 && gapBefore <= 0;

      if (state.warmingUp) {
        prevGap = gapNow;
        return [];
      }

      const { caps, fees } = state.hello;
      const held = state.positions.get(SYMBOL);
      const orders: (SellInput | BuyInput)[] = [];

      if (held !== undefined) {
        // A position exists: track its peak and check every exit.
        if (entrySeq === null) {
          entrySeq = state.seq;
          peakSinceEntry = close;
          if (entryMode === null) entryMode = 'base';
          everTraded = true;
        }
        if (close > peakSinceEntry) peakSinceEntry = close;
        const value = state.value(SYMBOL, held.qty);
        const takeBps = entryMode === 'late' ? LATE_TAKE_BPS : TAKE_BPS;
        const stopBps = entryMode === 'late' ? LATE_STOP_BPS : STOP_BPS;
        const hitTake = value * 10_000n >= held.cost * BigInt(10_000 + takeBps);
        const hitStop = value * 10_000n <= held.cost * BigInt(10_000 - stopBps);
        const hitTrail =
          BigInt(Math.trunc(peakSinceEntry)) > 0n &&
          BigInt(Math.trunc(close)) * 10_000n <= BigInt(Math.trunc(peakSinceEntry)) * BigInt(10_000 - TRAIL_BPS);
        // NOTE: no exit on a fast-under-mid EMA cross: on one-minute bars
        // that cross whipsaws and sells every dip (dev grade v2: 22 trades,
        // win rate 0). The trailing stop is the only trend-break exit.
        const stale = entrySeq !== null && state.seq - entrySeq >= MAX_HOLD_BARS;
        if (hitTake || hitStop || hitTrail || stale) {
          orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          cooldown = COOLDOWN_BARS;
          entrySeq = null;
          entryMode = null;
        }
      } else {
        // No position: maybe open one.
        if (entrySeq !== null) entrySeq = null;
        if (cooldown > 0) cooldown -= 1;
        if (closes.length >= MIN_HISTORY && cooldown === 0) {
          const fast = emaFast.value;
          const mid = emaMid.value;
          const long = emaLong.value;
          if (fast !== null && mid !== null && long !== null) {
            const uptrend = mid > long && close > mid;
            const aligned = fast > mid && mid > long;
            const high = high240();
            const low = low30();
            const dipped = close * 10_000 <= high * (10_000 - DIP_BPS);
            const bounced = close * 10_000 >= low * (10_000 + BOUNCE_BPS);
            const turningUp = close >= fast;
            const brokeOut = close > prevHigh240 && prevHigh240 > 0;
            let mode: 'base' | 'late' | null = null;
            if (uptrend && dipped && bounced && turningUp) mode = 'base';
            else if (aligned && brokeOut) mode = 'base';
            else if (uptrend && crossUp) mode = 'base';
            else if (!everTraded && state.seq >= LATE_BAR && fast > mid) mode = 'late';
            else if (!everTraded && state.seq >= FORCE_BAR) mode = 'late';
            if (mode !== null) {
              let spend = state.cash;
              const room = state.weightRoom(SYMBOL);
              if (spend > room) spend = room;
              if (spend >= BigInt(fees.min_notional_quote_units)) {
                orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
                entryMode = mode;
              }
            }
          }
        }
      }

      prevGap = gapNow;
      return orders.slice(0, caps.max_orders_per_bar);
    }
    prevGap = prevGap;
    return [];
  },
});
