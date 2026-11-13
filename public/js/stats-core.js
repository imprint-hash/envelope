// Pure maths for the Stats page: no DOM, no ethers, no network. Shared by public/js/stats.js and
// test/node/stats.test.mjs.
//
// An "event" here is one decoded contract log:
//   { v: 1 | 2, name: "Created" | "Claimed" | "Refunded" | "FeeTaken" | "RelayerPaid" | "Swept",
//     tx: "0x..", block: number, logIndex: number,
//     args: { id?, sender?, recipient?, relayer?, amount?, fee? } }   // numbers as bigint or decimal strings

export const LOG_WINDOW = 10_000; // Mezo RPC: eth_getLogs covers at most 10,000 blocks per call

const big = (x) => (x === undefined || x === null ? 0n : BigInt(x));
const low = (a) => String(a || "").toLowerCase();
const key = (e) => `${e.v}:${String(e.args.id)}`;

/** Block windows [from, to] (inclusive, at most `size` blocks each), newest first, from `head` down to `floor`. */
export function windows(floor, head, size = LOG_WINDOW) {
  const out = [];
  for (let to = head; to >= floor; to -= size) out.push([Math.max(floor, to - size + 1), to]);
  return out;
}

/** Oldest first: block, then position in the block. */
export function sortEvents(events) {
  return [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/** Drop duplicates (same tx + log index), e.g. after merging a cached scan with a fresh one. */
export function dedupe(events) {
  const seen = new Set();
  return events.filter((e) => {
    const k = `${e.tx}:${e.logIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Which V2 txs were `createFor` (a relayer created the envelope from the sender's signatures:
 * the "borrow to send" flow). Only createFor emits Created and RelayerPaid in the same tx without a Claimed.
 */
export function createForTxs(events) {
  const byTx = new Map();
  for (const e of events) {
    if (e.v !== 2) continue;
    if (!byTx.has(e.tx)) byTx.set(e.tx, new Set());
    byTx.get(e.tx).add(e.name);
  }
  const out = new Set();
  for (const [tx, names] of byTx) if (names.has("Created") && names.has("RelayerPaid") && !names.has("Claimed")) out.add(tx);
  return out;
}

/**
 * Every headline number on the Stats page.
 * @param events decoded events (any order)
 * @param opts.claimOptionTxs Set of tx hashes that called the claim-into-Mezo-Pools function,
 *        or null when that function isn't live yet (the count is then null, not 0).
 */
export function aggregate(events, { claimOptionTxs = null } = {}) {
  const evs = sortEvents(dedupe(events));
  const borrowTxs = createForTxs(evs);
  const created = new Map(); // "v:id" -> amount
  const closed = new Set();
  const senders = new Set();
  const recipients = new Set();
  const s = {
    sent: 0, claimed: 0, refunded: 0, open: 0,
    volume: 0n, delivered: 0n, refundedAmount: 0n, openAmount: 0n,
    sentV1: 0, sentV2: 0,
    uniqueSenders: 0, uniqueRecipients: 0,
    borrowToSend: 0, borrowToSendVolume: 0n,
    claimsIntoPools: claimOptionTxs ? 0 : null,
    fees: 0n, relayerPaid: 0n, relayerPayouts: 0, swept: 0n, gasFundComputed: 0n,
    firstBlock: evs.length ? evs[0].block : null,
    lastBlock: evs.length ? evs[evs.length - 1].block : null,
  };
  for (const e of evs) {
    const a = e.args || {};
    switch (e.name) {
      case "Created": {
        const amt = big(a.amount);
        created.set(key(e), amt);
        s.sent++;
        if (e.v === 2) s.sentV2++; else s.sentV1++;
        s.volume += amt;
        senders.add(low(a.sender));
        if (borrowTxs.has(e.tx)) { s.borrowToSend++; s.borrowToSendVolume += amt; }
        break;
      }
      case "Claimed":
        s.claimed++;
        s.delivered += big(a.amount);
        recipients.add(low(a.recipient));
        closed.add(key(e));
        if (claimOptionTxs && claimOptionTxs.has(e.tx)) s.claimsIntoPools++;
        break;
      case "Refunded":
        s.refunded++;
        s.refundedAmount += big(a.amount);
        closed.add(key(e));
        break;
      case "FeeTaken": s.fees += big(a.fee); break;
      case "RelayerPaid": s.relayerPaid += big(a.amount); s.relayerPayouts++; break;
      case "Swept": s.swept += big(a.amount); break;
      default: break;
    }
  }
  for (const [k, amt] of created) if (!closed.has(k)) { s.open++; s.openAmount += amt; }
  s.uniqueSenders = senders.size;
  s.uniqueRecipients = recipients.size;
  s.gasFundComputed = s.fees - s.relayerPaid - s.swept;
  return s;
}

/**
 * The latest `n` transactions, one row each, newest first.
 * kind: "sent" | "sent-bitcoin" (createFor) | "claimed" | "refunded" | "swept".
 */
export function latestTxs(events, n = 20) {
  const evs = sortEvents(dedupe(events));
  const borrowTxs = createForTxs(evs);
  const rows = new Map();
  for (const e of evs) {
    let kind = null;
    if (e.name === "Created") kind = borrowTxs.has(e.tx) ? "sent-bitcoin" : "sent";
    else if (e.name === "Claimed") kind = "claimed";
    else if (e.name === "Refunded") kind = "refunded";
    else if (e.name === "Swept") kind = "swept";
    if (!kind || rows.has(e.tx)) continue;
    rows.set(e.tx, {
      tx: e.tx, block: e.block, logIndex: e.logIndex, v: e.v, kind,
      id: e.args?.id === undefined ? null : String(e.args.id),
      amount: big(e.args?.amount),
    });
  }
  return [...rows.values()].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, n);
}
