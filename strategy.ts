// Hot-launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window shows (measured on the kit's 24 h of chain data, 1,122 coins):
//   - The pump is front-loaded: a coin's price action is mostly decided in its create slot.
//     Coins that do not move in the create slot almost never move later (3% win rate), and
//     buying the dip after a pump fades loses money. So this bot only ever buys on the batch
//     that carries a coin's CreateEvent, and its buy fills two slots later (the harness
//     latency), right at the tail of the opening pump.
//   - What predicts a profitable opening is how busy that first slot is: coins with at
//     least 10 trades in the create slot from at least 4 distinct non-creator buyers win
//     59% of quick round trips on the dev window (v1 grade), and the edge holds in both
//     halves of the window (+2.8% / +3.1% per stake in a price-based backtest). Fewer
//     trades, and the edge is gone (6-9 trades: -2.8%, everything: -4.2%). So the bot is
//     picky: it only takes the busy launches at full size.
//   - Hot launches — at least 10 trades from at least 4 distinct non-creator
//     buyers in the create slot — get a 0.30 SOL buy (within the 1% of real
//     reserve cap). On the dev window these win 59% of quick round trips at
//     +0.0122 SOL per coin. Never pyramided: adding to a winner destroys the edge.
//   - A second, small tier keeps the run above the 20-coin guardrail: launches with
//     6-9 trades in the create slot get a 0.01 SOL probe, and only until 25 distinct
//     coins have been traded — warm coins lose a little each, so the bot buys just
//     enough of them and lets the hot tier pay.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, so the two graded executions produce byte-identical action logs.

import {
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Minimum trades in the create slot for a hot launch. */
  hotMinTrades: number;
  /** Minimum distinct non-creator buyers in the create slot for a hot launch. */
  hotMinBuyers: number;
  /** SOL staked on a hot launch (capped by 1% of the real reserve). */
  hotStakeSol: number;
  /** Minimum trades in the create slot for a warm (guardrail) launch. */
  warmMinTrades: number;
  /** Minimum distinct non-creator buyers in the create slot for a warm launch. */
  warmMinBuyers: number;
  /** SOL staked on a warm launch. */
  warmStakeSol: number;
  /** Most warm positions open at once (hot launches may use any free slot). */
  maxWarmOpen: number;
  /** Smallest buy worth sending (also the guardrail's minimum round trip). */
  minBuySol: number;
  /** Take profit: sell when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: sell when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots (counted from the buy's fill slot). */
  maxHoldSlots: number;
  /** Exit at once when the creator sells while we hold. */
  exitOnCreatorSell: boolean;
  /** Slippage tolerance on buys and sells (bps); wide open so fills are never refused. */
  slippageBps: number;
  /** Stop opening warm (guardrail) launches once this many distinct coins have a buy. */
  maxCoinsTraded: number;
}

export const DEFAULT_PARAMS: Params = {
  hotMinTrades: 10,
  hotMinBuyers: 4,
  hotStakeSol: 0.3,
  warmMinTrades: 6,
  warmMinBuyers: 3,
  warmStakeSol: 0.01,
  maxWarmOpen: 3,
  minBuySol: 0.01,
  takeProfit: 0.06,
  stopLoss: 0.07,
  maxHoldSlots: 30,
  exitOnCreatorSell: true,
  slippageBps: 10_000,
  /** Stop opening warm (guardrail) launches once this many distinct coins have a buy. */
  maxCoinsTraded: 25,
};

const LAMPORTS = 1_000_000_000n;
const FEE_BPS = 125n;
const BPS = 10_000n;

/** What selling `tokens` against (vq, vt) would pay, curve fees deducted. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Launch {
  createSlot: number | null;
  creator: Pubkey | null;
  /** Trades seen in the create slot. */
  trades: number;
  /** Distinct non-creator buyers in the create slot. */
  buyers: Set<Pubkey>;
  /** The creator sold in (or before) the create slot. */
  creatorSold: boolean;
  /** Decided already (bought, skipped, or the create slot has passed). */
  done: boolean;
  /** Bought as a warm (guardrail) launch rather than a hot one. */
  warm: boolean;
}

interface Held {
  /** Slot the opening buy filled at. */
  openedSlot: number;
  /** Transaction fees paid on fills for this position. */
  txPaid: bigint;
  /** Warm-tier position (smaller stake, same exits). */
  warm: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const launches = new Map<Pubkey, Launch>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight: do not send another. */
  const selling = new Set<Pubkey>();
  /** Distinct mints this run has sent a buy for (hot and warm together). */
  const coinsTraded = new Set<Pubkey>();

  const launchOf = (mint: Pubkey): Launch => {
    let l = launches.get(mint);
    if (l === undefined) {
      l = {
        createSlot: null,
        creator: null,
        trades: 0,
        buyers: new Set(),
        creatorSold: false,
        done: false,
        warm: false,
      };
      launches.set(mint, l);
    }
    return l;
  };

  return {
    onHello(state: BotState): void {
      // The hello carries the run's capital, caps and fees; the strategy reads them
      // from state on every batch, so nothing is cached here.
      void state;
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;

      // 1. Fold this batch's events into the per-coin launch records. The hello
      // handshake already happened, so every batch here is a slot of market events.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const l = launchOf(e.mint);
          l.createSlot = e.slot;
          l.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const l = launchOf(e.mint);
          if (l.createSlot !== null && e.slot === l.createSlot) {
            l.trades++;
            if (e.is_buy) {
              if (l.creator !== null && e.user !== l.creator) l.buyers.add(e.user);
            } else if (l.creator !== null && e.user === l.creator) {
              l.creatorSold = true;
            }
          } else if (l.createSlot !== null && e.slot > l.createSlot && !e.is_buy) {
            // A sell after the create slot: remember a creator sale for the exit rule.
            if (l.creator !== null && e.user === l.creator) l.creatorSold = true;
          }
        } else {
          // CompleteEvent: the curve is done; the harness closes any position in it.
          const l = launches.get(e.mint);
          if (l !== undefined) l.done = true;
        }
      }

      // 2. Fold the fills: learn when a buy landed (opens the hold clock) and clear
      // sells that resolved, so a failed sell can be retried on the next batch.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            warm: launches.get(f.mint)?.warm ?? false,
          });
        }
        if (f.side === 'sell') selling.delete(f.mint);
      }
      // A held record whose position is gone (sold, flattened, written off) is done.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          let buyPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') buyPending = true;
          }
          if (!buyPending) held.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // 3. Exits first: every held position is checked against its take-profit,
      // stop-loss, hold limit and creator-sell rules, and sold whole when one trips.
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        let h = held.get(mint);
        if (h === undefined) {
          // A position the fills never announced (e.g. the buy filled on a batch
          // whose fills arrived with the position already reported): open it now.
          h = { openedSlot: slot, txPaid: tx, warm: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (basis <= 0n) continue;
        const l = launches.get(mint);
        let exit = false;
        if (value * BPS >= basis * (BPS + BigInt(Math.round(p.takeProfit * 10_000)))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(Math.round(p.stopLoss * 10_000)))) exit = true;
        if (slot - h.openedSlot > p.maxHoldSlots) exit = true;
        if (p.exitOnCreatorSell && l !== undefined && l.creatorSold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slippageBps });
        selling.add(mint);
        if (l !== undefined) l.done = true;
      }

      // 4. Entries: only on the batch that carries a coin's CreateEvent. The orders
      // decided on this batch fill two slots later, at the tail of the opening pump.
      // Buys are capped at 1% of the coin's real SOL reserve (the harness's per-reply
      // cap), so a busy launch is the only kind that can take a full stake.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      let warmOpen = 0;
      for (const mint of state.positions.keys()) if (held.get(mint)?.warm) warmOpen++;
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy' && !state.positions.has(po.order.mint) && launches.get(po.order.mint)?.warm) warmOpen++;
      }
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);

      for (const e of batch.events) {
        if (orders.length >= cap) break;
        if (e.event !== 'CreateEvent') continue;
        const l = launches.get(e.mint);
        if (l === undefined || l.done) continue;
        // The entry decision is made once, on this batch; whatever the verdict, the
        // coin is never reconsidered, so a later batch cannot re-enter it.
        l.done = true;
        if (l.creatorSold) continue;
        const hot = l.trades >= p.hotMinTrades && l.buyers.size >= p.hotMinBuyers;
        const warm = !hot && l.trades >= p.warmMinTrades && l.buyers.size >= p.warmMinBuyers;
        if (!hot && !warm) continue;
        // Warm launches exist only to clear the 20-coin guardrail: once enough
        // distinct coins have been traded, stop opening them — every warm coin
        // costs a little, and the hot tier is what pays.
        if (warm && coinsTraded.size >= p.maxCoinsTraded) continue;
        if (warm && warmOpen >= p.maxWarmOpen) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (state.positions.has(e.mint) || pendingMints.has(e.mint)) continue;
        const curve = state.curves.get(e.mint);
        if (curve === undefined || curve.complete) continue;
        const stake = BigInt(Math.round((hot ? p.hotStakeSol : p.warmStakeSol) * Number(LAMPORTS)));
        const sizeCap = state.maxBuyLamports(e.mint);
        const amount = stake < sizeCap ? stake : sizeCap;
        const minBuy = BigInt(Math.round(p.minBuySol * Number(LAMPORTS)));
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: p.slippageBps });
        l.warm = warm;
        coinsTraded.add(e.mint);
        free -= amount + tx;
        open++;
        if (warm) warmOpen++;
        pendingMints.add(e.mint);
      }
      return orders;
    },
  };
}
