// Node 22 built-in test runner, no installs:  node --test test/node/
// Checks api/borrow-send.mjs input validation and signatures, and the loan-health (ICR) maths.
// Offline: no RPC calls, no keys from .env (throwaway random wallets only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, parseUnits, keccak256, toUtf8Bytes, Signature } from "ethers";
import { validateInput, checkSignatures, SAFETY_FLOOR_ICR } from "../../api/borrow-send.mjs";
import handler from "../../api/borrow-send.mjs";
import { loanHealth, computeICR, pct } from "../../public/js/loan-math.js";
import { quoteLocal, CREATE_FOR_TYPES, envelopeV2Domain, encodeCreateFor } from "../../public/js/abi-v2.js";

const E = (s) => parseUnits(String(s), 18);
const near = (icr, want, tol = 0.0005) => assert.ok(Math.abs(Number(icr) / 1e18 - want) < tol, `${Number(icr) / 1e18} ≉ ${want}`);

// Fixed trove from the brief.
const coll = E("0.038"), debt = E("2002.79"), price = E("68805.13");

test("current ICR = coll * price / debt ≈ 1.3055", () => {
  near(computeICR(coll, debt, price), 1.3055);
});

test("brief example: borrowing 50 + 0.05 Mezo fee → ≈ 1.2738 (risky)", () => {
  const h = loanHealth({ coll, debt, price, amount: E(50), fee: E("0.05") });
  near(h.icrNow, 1.3055);
  near(h.icrAfter, 1.2738);
  assert.equal(h.level, "risky");
});

test("fee on top: $50 envelope → borrow 50.25, Mezo fee 0.05025 → ≈ 1.2735", () => {
  const { total, fee } = quoteLocal(E(50));
  assert.equal(fee, E("0.25"));
  assert.equal(total, E("50.25"));
  const mezoFee = (total * 10n) / 10_000n; // Mezo testnet borrowing rate is 0.1% (getBorrowingFee(50) = 0.05 on chain)
  assert.equal(mezoFee, E("0.05025"));
  const h = loanHealth({ coll, debt, price, amount: total, fee: mezoFee });
  assert.equal(h.debtAfter, E("2053.09025"));
  near(h.icrAfter, 1.2735);
  assert.equal(h.level, "risky");
  assert.equal(pct(h.icrAfter), 127.3);
  // BTC could fall ~13.6% before this loan reaches 110%.
  assert.equal(Math.round(h.dropToLiquidation / 10), 136);
});

test("envelope fee rounds up and the recipient keeps the exact amount", () => {
  assert.deepEqual(quoteLocal(1n), { total: 2n, fee: 1n });
  assert.deepEqual(quoteLocal(E(1)), { total: E("1.005"), fee: E("0.005") });
  assert.deepEqual(quoteLocal(199n), { total: 200n, fee: 1n });
  assert.deepEqual(quoteLocal(200n), { total: 201n, fee: 1n });
  assert.deepEqual(quoteLocal(201n), { total: 203n, fee: 2n });
});

test("levels: safe ≥ 150%, blocked < 120%, blocked in recovery mode", () => {
  assert.equal(loanHealth({ coll, debt: E(1000), price, amount: E(50), fee: 0n }).level, "safe");
  const big = loanHealth({ coll, debt, price, amount: E(200), fee: E("0.2") }); // ≈ 1.1868
  near(big.icrAfter, 1.1868);
  assert.ok(big.icrAfter < SAFETY_FLOOR_ICR);
  assert.equal(big.level, "blocked");
  assert.equal(loanHealth({ coll, debt: E(1000), price, amount: E(1), fee: 0n, recoveryMode: true }).level, "blocked");
  assert.equal(SAFETY_FLOOR_ICR, E("1.2"));
});

// ---------------------------------------------------------------- input validation + signatures
const ESCROW = "0x00000000000000000000000000000000000000E2";
const NOW = 1_800_000_000;
const sender = Wallet.createRandom();
const link = Wallet.createRandom().address;
const amount = E(50);
const envFee = quoteLocal(amount).fee;
const total = amount + envFee;
const note = "Happy birthday Mum! 🎂";
const deadline = BigInt(NOW + 1800);
const nonces = { mezoNonce: 3n, envNonce: 0n, musdNonce: 7n };

async function payload() {
  const mezoSig = await sender.signTypedData(
    { name: "BorrowerOperationsSignatures", version: "1", chainId: 31611, verifyingContract: "0xD757e3646AF370b15f32EB557F0F8380Df7D639e" },
    { WithdrawMUSD: [{ name: "amount", type: "uint256" }, { name: "borrower", type: "address" }, { name: "recipient", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { amount: total, borrower: sender.address, recipient: sender.address, nonce: nonces.mezoNonce, deadline });
  const permitSig = Signature.from(await sender.signTypedData(
    { name: "Mezo USD", version: "1", chainId: 31611, verifyingContract: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" },
    { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { owner: sender.address, spender: ESCROW, value: total, nonce: nonces.musdNonce, deadline }));
  const noteHash = keccak256(toUtf8Bytes(note));
  const authSig = await sender.signTypedData(envelopeV2Domain(ESCROW), CREATE_FOR_TYPES,
    { sender: sender.address, link, amount, noteHash, nonce: nonces.envNonce, deadline });
  return {
    sender: sender.address, amount: amount.toString(), link, note, noteHash,
    mezoSig, mezoDeadline: deadline.toString(),
    permit: { v: permitSig.v, r: permitSig.r, s: permitSig.s, deadline: deadline.toString() },
    authSig, authDeadline: deadline.toString(),
  };
}

test("a well-formed request passes validation and all three signatures check out", async () => {
  const r = validateInput(await payload(), NOW);
  assert.ok(r.value, r.code);
  assert.equal(r.value.amount, amount);
  assert.equal(checkSignatures(r.value, { escrowAddr: ESCROW, ...nonces, total }), true);
  // createFor gets the envelope amount (not the total)
  const [a, , p] = encodeCreateFor(r.value);
  assert.equal(a.amount, amount);
  assert.equal(a.sender, sender.address);
  assert.equal(p.deadline, deadline);
});

test("signatures fail on wrong total, wrong nonce, swapped link, or another signer", async () => {
  const v = validateInput(await payload(), NOW).value;
  assert.equal(checkSignatures(v, { escrowAddr: ESCROW, ...nonces, total: amount }), false); // fee not included
  assert.equal(checkSignatures(v, { escrowAddr: ESCROW, ...nonces, mezoNonce: 4n, total }), false);
  assert.equal(checkSignatures({ ...v, link: Wallet.createRandom().address }, { escrowAddr: ESCROW, ...nonces, total }), false);
  assert.equal(checkSignatures({ ...v, sender: Wallet.createRandom().address }, { escrowAddr: ESCROW, ...nonces, total }), false);
});

test("validation rejects bad shapes with clear codes", async () => {
  const good = await payload();
  const code = (mut) => validateInput(mut(structuredClone(good)), NOW).code || "ok";
  assert.equal(code((d) => d), "ok");
  assert.equal(validateInput(null, NOW).code, "BadInput");
  assert.equal(validateInput([good], NOW).code, "BadInput");
  assert.equal(code((d) => ({ ...d, sender: "0x123" })), "BadInput");
  assert.equal(code((d) => ({ ...d, link: "0x0000000000000000000000000000000000000000" })), "BadInput");
  assert.equal(code((d) => ({ ...d, amount: "-5" })), "BadInput");
  assert.equal(code((d) => ({ ...d, amount: "1.5" })), "BadInput");
  assert.equal(code((d) => ({ ...d, amount: E("0.5").toString() })), "TooSmall");
  assert.equal(code((d) => ({ ...d, amount: E(100001).toString() })), "TooBig");
  assert.equal(code((d) => ({ ...d, note: "x".repeat(141) })), "NoteTooLong");
  assert.equal(code((d) => ({ ...d, note: "changed" })), "BadInput"); // noteHash no longer matches
  assert.equal(code((d) => ({ ...d, mezoSig: "0x1234" })), "BadSignature");
  // high-s signature (malleable) is refused
  const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const sig = Signature.from(good.authSig);
  const highS = "0x" + (n - BigInt(sig.s)).toString(16).padStart(64, "0");
  assert.equal(code((d) => ({ ...d, authSig: sig.r + highS.slice(2) + (sig.v === 27 ? "1c" : "1b") })), "BadSignature");
  assert.equal(code((d) => ({ ...d, permit: { ...d.permit, v: 29 } })), "BadSignature");
  assert.equal(code((d) => ({ ...d, permit: null })), "BadInput");
  assert.equal(code((d) => ({ ...d, mezoDeadline: String(NOW + 30) })), "SignatureExpired");
  assert.equal(code((d) => ({ ...d, authDeadline: String(NOW + 2 * 86400) })), "BadInput");
  assert.equal(code((d) => ({ ...d, permit: { ...d.permit, deadline: "soon" } })), "BadInput");
});

// ---------------------------------------------------------------- handler edges (no network needed)
function mockRes() {
  const r = { statusCode: 0, headers: {}, body: "" };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = b; };
  return r;
}

test("handler: GET is refused, oversized bodies are refused, missing config is a clear 503", async () => {
  delete process.env.ESCROW_ADDRESS_V2;
  let res = mockRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 405);

  res = mockRes();
  await handler({ method: "POST", headers: { "content-length": "99999", "x-real-ip": "10.0.0.1" } }, res);
  assert.equal(res.statusCode, 413);

  res = mockRes();
  const p = await payload();
  await handler({ method: "POST", headers: { "x-real-ip": "10.0.0.2" }, body: p }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).code, "NotConfigured");
  assert.ok(!res.body.includes(p.mezoSig.slice(2, 20)), "no signatures echoed back");
});

test("handler: rate limit kicks in after 5 tries a minute from one IP", async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const res = mockRes();
    await handler({ method: "POST", headers: { "x-real-ip": "10.9.9.9" }, body: {} }, res);
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes.slice(5), [429, 429]);
});
