// Node 22 built-in test runner, no installs:  node --test test/node/
// Checks the Stats page's pure aggregation (public/js/stats-core.js) with fake decoded events. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, latestTxs, windows, createForTxs, LOG_WINDOW } from "../../public/js/stats-core.js";

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // dollars -> 18-decimal wei
const A = { alice: "0xA11CE00000000000000000000000000000000001", bob: "0xB0B0000000000000000000000000000000000002",
  carol: "0xCA70100000000000000000000000000000000003", relayer: "0x7E1A900000000000000000000000000000000004" };
let li = 0;
const ev = (v, name, tx, block, args) => ({ v, name, tx, block, logIndex: li++, args });

// Story:
//  V1 #1 alice $100 -> claimed by bob
//  V1 #2 alice $20  -> refunded
//  V1 #3 bob   $5   -> open
//  V2 #1 carol $50 via create (fee 0.25)        -> claimed by bob (relayer paid 0.05)
//  V2 #2 alice $10 via createFor (fee 0.05, relayer paid 0.025 at create) -> claimed by carol (paid 0.025)
//  V2 #3 carol $40 via create (fee 0.20)        -> open
//  sweep 0.10
const events = [
  ev(1, "Created", "0x01", 100, { id: "1", sender: A.alice, amount: String(E(100)) }),
  ev(1, "Created", "0x02", 110, { id: "2", sender: A.alice, amount: String(E(20)) }),
  ev(1, "Claimed", "0x03", 120, { id: "1", recipient: A.bob, relayer: A.relayer, amount: String(E(100)) }),
  ev(1, "Created", "0x04", 130, { id: "3", sender: A.bob.toLowerCase(), amount: String(E(5)) }), // case must not matter
  ev(1, "Refunded", "0x05", 140, { id: "2", sender: A.alice, amount: String(E(20)) }),
  ev(2, "Created", "0x10", 200, { id: "1", sender: A.carol, amount: E(50) }),
  ev(2, "FeeTaken", "0x10", 200, { id: "1", fee: E(0.25) }),
  ev(2, "Created", "0x11", 210, { id: "2", sender: A.alice, amount: E(10) }),
  ev(2, "FeeTaken", "0x11", 210, { id: "2", fee: E(0.05) }),
  ev(2, "RelayerPaid", "0x11", 210, { relayer: A.relayer, amount: E(0.025) }),
  ev(2, "Claimed", "0x12", 220, { id: "1", recipient: A.bob, relayer: A.relayer, amount: E(50) }),
  ev(2, "RelayerPaid", "0x12", 220, { relayer: A.relayer, amount: E(0.05) }),
  ev(2, "Claimed", "0x13", 230, { id: "2", recipient: A.carol, relayer: A.relayer, amount: E(10) }),
  ev(2, "RelayerPaid", "0x13", 230, { relayer: A.relayer, amount: E(0.025) }),
  ev(2, "Created", "0x14", 240, { id: "3", sender: A.carol, amount: E(40) }),
  ev(2, "FeeTaken", "0x14", 240, { id: "3", fee: E(0.2) }),
  ev(2, "Swept", "0x15", 250, { amount: E(0.1) }),
];

test("counts: sent, claimed, refunded, open (V1 and V2 ids don't collide)", () => {
  const s = aggregate(events);
  assert.equal(s.sent, 6);
  assert.equal(s.sentV1, 3);
  assert.equal(s.sentV2, 3);
  assert.equal(s.claimed, 3);
  assert.equal(s.refunded, 1);
  assert.equal(s.open, 2);
});

test("totals: volume, delivered, refunded, open amounts", () => {
  const s = aggregate(events);
  assert.equal(s.volume, E(225));
  assert.equal(s.delivered, E(160));
  assert.equal(s.refundedAmount, E(20));
  assert.equal(s.openAmount, E(45));
});

test("unique senders and recipients (case-insensitive)", () => {
  const s = aggregate(events);
  assert.equal(s.uniqueSenders, 3); // alice, bob, carol
  assert.equal(s.uniqueRecipients, 2); // bob, carol
});

test("borrow-to-send: only the createFor tx (Created + RelayerPaid, no Claimed)", () => {
  assert.deepEqual([...createForTxs(events)], ["0x11"]);
  const s = aggregate(events);
  assert.equal(s.borrowToSend, 1);
  assert.equal(s.borrowToSendVolume, E(10));
});

test("self-funding gas: fees in, relayer payouts out, sweep, computed fund", () => {
  const s = aggregate(events);
  assert.equal(s.fees, E(0.5));
  assert.equal(s.relayerPaid, E(0.1));
  assert.equal(s.relayerPayouts, 3);
  assert.equal(s.swept, E(0.1));
  assert.equal(s.gasFundComputed, E(0.3));
});

test("claims into Mezo Pools: null until the option exists, then counted by tx", () => {
  assert.equal(aggregate(events).claimsIntoPools, null);
  assert.equal(aggregate(events, { claimOptionTxs: new Set() }).claimsIntoPools, 0);
  assert.equal(aggregate(events, { claimOptionTxs: new Set(["0x13"]) }).claimsIntoPools, 1);
});

test("duplicates (cache + fresh scan overlap) are counted once; order doesn't matter", () => {
  const s = aggregate([...events].reverse().concat(events));
  assert.equal(s.sent, 6);
  assert.equal(s.volume, E(225));
  assert.equal(s.fees, E(0.5));
});

test("empty input", () => {
  const s = aggregate([]);
  assert.equal(s.sent, 0);
  assert.equal(s.volume, 0n);
  assert.equal(s.firstBlock, null);
});

test("latest transactions: one row per tx, newest first, labelled", () => {
  const rows = latestTxs(events, 20);
  assert.equal(rows.length, 11); // 17 events in 11 txs
  assert.deepEqual(rows.slice(0, 4).map((r) => [r.tx, r.kind]), [
    ["0x15", "swept"], ["0x14", "sent"], ["0x13", "claimed"], ["0x12", "claimed"],
  ]);
  assert.equal(rows.find((r) => r.tx === "0x11").kind, "sent-bitcoin");
  assert.equal(rows.find((r) => r.tx === "0x05").kind, "refunded");
  assert.equal(rows.find((r) => r.tx === "0x13").amount, E(10));
  assert.equal(latestTxs(events, 3).length, 3);
});

test("block windows: 10k max, newest first, cover deploy..head exactly", () => {
  assert.equal(LOG_WINDOW, 10_000);
  const w = windows(16_380_327, 16_400_000);
  assert.deepEqual(w[0], [16_390_001, 16_400_000]);
  assert.deepEqual(w.at(-1), [16_380_327, 16_390_000]);
  let covered = 0;
  for (const [a, b] of w) { assert.ok(b - a + 1 <= 10_000); covered += b - a + 1; }
  assert.equal(covered, 16_400_000 - 16_380_327 + 1);
  assert.deepEqual(windows(5, 4), []);
  assert.deepEqual(windows(7, 7), [[7, 7]]);
});
