# btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/lycann666/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/lycann666/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Ridge Rider — a TypeScript bot (Node 22, standard library only) that trades
Coinbase Wrapped BTC (CBBTC) against USDC on the `agent-fun/bars-replay/v1`
protocol: one-minute bars, long only, starting from 1,000 USDC.

## Strategy

One-minute BTC prices are noisy, and a full-size round trip costs about
26 bps in fees, slippage and pool impact, so chasing every wiggle loses
money. This bot only rides an uptrend, and it only gets on in one of three
ways:

- **Pullback** — it buys when the close is at least **0.60% below the
  highest close of the last 240 bars** but has already bounced at least
  **0.15% off the lowest close of the last 30 bars** and sits at or above
  its 9-bar EMA, i.e. the dip has stopped falling.
- **Breakout** — the close pushes above the 240-bar high while the 9-bar
  EMA sits above the 30-bar EMA above the 120-bar EMA, i.e. a smooth
  uptrend with no dip to buy.
- **EMA cross** — the 9-bar EMA crosses above the 30-bar EMA while the
  30-bar EMA is above the 120-bar EMA, so an early trend is not missed
  while waiting for a pullback that never comes.

It spends all of its cash on that one entry. Once in, it lets the winner
run but never gives much back:

- **Exit** — it sells the whole position when its marked value reaches
  **5% over its blended cost**, trails **2.5% below the highest close
  seen since entry**, or after 1440 bars without either. It deliberately
  does **not** exit on a fast-under-mid EMA cross: on one-minute bars
  that cross whipsaws and sells every dip. After a sell it waits 120 bars
  before it may buy again.
- **Late-window fallback** — if no trade has happened by bar 1200 and the
  fast EMA is above the mid EMA, it buys once with a tighter 1.5%
  take-profit and 1% stop-loss; if even that never fires, a last-resort
  buy at bar 1380 takes one trade whatever the trend says, so a quiet
  window is not a guaranteed zero.

Everything is decided from the bars and the account the harness sends.
EMAs run in float64, every amount is a bigint of raw units. No clock, no
environment, no network, no files outside the repository.

## Dev-window results (local grade, kit CLI fill model)

| Window | Net PnL | Return | Max drawdown | Trades |
|---|---|---|---|---|
| `btc-race-24h-20261123-0511` (dev) | **+30.76 USDC** | +3.08% | 1.98% | 1 |
| `btc-race-24h-20261118-1444` (dev, older kit) | -11.74 USDC | -1.17% | 2.81% | 2 |
| `btc-race-24h-20261117-0603` (dev, older kit) | -1.22 USDC | -0.12% | 2.12% | 1 |

The current window passes the dev gate (net PnL > 0) with max drawdown far
under the 25% guardrail. These are dev-window numbers only: the race
window is a different 24 hours and past performance there says nothing
about it.

## Layout

- `main.ts` — the bot (entrypoint, speaks the protocol via the shim).
- `vendor/makefun-bars.ts` — the kit's TypeScript protocol shim,
  byte-for-byte as shipped in the kit (excluded from authorship counts).
- `LICENSE` — MIT.

## Grade locally

From inside the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

---

Built for [make.fun](https://make.fun/?ref=5f3j6jyb&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) — bounty: https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511
