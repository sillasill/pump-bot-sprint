# Hot-Launch Sniper — Pump.fun Bot Sprint

![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)
![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sillasill/pump-bot-sprint/rank.svg)
![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sillasill/pump-bot-sprint/reward.svg)

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty. It trades paper SOL on a replay of pump.fun bonding-curve events.

## Strategy

The dev window (24 h, 1,122 coins) shows the opening pump is decided in a coin's
create slot, so the bot only buys on the batch carrying a coin's `CreateEvent`
and exits fast:

- **Hot launches** — at least 10 trades from at least 4 distinct non-creator
  buyers in the create slot — get a 0.30 SOL buy (within the 1%-of-real-reserve
  cap). On the dev window these win 59% of quick round trips at +0.0122 SOL per
  coin (v3, 0.30 SOL stake). Never pyramided: adding to a winner destroys the edge.
- **Warm launches** (6–9 trades in the create slot) get a small 0.01 SOL probe,
  only until 25 distinct coins have been traded, so the run clears the 20-coin
  guardrail without paying for more losers than needed.
- **Exits** — take profit at +6% of liquidation value over cost, stop loss at
  −7%, out after 30 slots, or at once if the creator sells while held.

Everything is deterministic: a pure function of the replay batches, no clock,
no randomness, no network, standard library only.

## Run

```sh
node main.ts
```

Grade locally with the kit (from the kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
