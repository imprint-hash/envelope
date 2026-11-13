// Node 22 built-in test runner, no installs:  node --test test/node/
// Mezo Pools claim options: ABI matches the compiled contract, EIP-712 type matches the contract's
// typehash, quote maths, and api/claim.mjs input checks. Offline: no RPC, throwaway keys only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Interface, Wallet, TypedDataEncoder, keccak256, toUtf8Bytes, AbiCoder, concat, recoverAddress, getAddress } from "ethers";
import {
  ESCROW_V2_ABI, CLAIM_WITH_OPTION_TYPES, envelopeV2Domain, MODE, gasTipLocal, withSlippage, earnLpLocal, quoteOptions,
} from "../../public/js/abi-v2.js";
import handler, { parseClaimInput } from "../../api/claim.mjs";

const compiled = new Interface(JSON.parse(readFileSync(new URL("../../docs/abi/EnvelopeV2.json", import.meta.url))));
const ours = new Interface(ESCROW_V2_ABI);
const E = (n) => BigInt(n) * 10n ** 18n;

test("every function, event and error in abi-v2.js exists in the compiled EnvelopeV2 ABI", () => {
  for (const f of ours.fragments) {
    if (f.type === "function") assert.ok(compiled.getFunction(f.selector), `missing function ${f.format()}`);
    else if (f.type === "event") assert.ok(compiled.getEvent(f.topicHash), `missing event ${f.format()}`);
    else if (f.type === "error") assert.ok(compiled.getError(f.selector), `missing error ${f.format()}`);
  }
  // and the claim-option surface is all there
  for (const name of ["claimWithOption", "claimWithOptionDigest", "gasTipFor", "router", "factory", "partner", "btc", "earnPool", "btcPool"]) {
    assert.equal(ours.getFunction(name).selector, compiled.getFunction(name).selector, name);
  }
  assert.equal(ours.getEvent("ClaimedWithOption").topicHash, compiled.getEvent("ClaimedWithOption").topicHash);
});

test("ClaimWithOption typed data = the contract's typehash and digest formula", () => {
  const enc = TypedDataEncoder.from(CLAIM_WITH_OPTION_TYPES);
  assert.equal(enc.encodeType("ClaimWithOption"),
    "ClaimWithOption(uint256 id,address recipient,uint8 mode,uint256 minOut,uint256 deadline)");
  const verifying = "0x00000000000000000000000000000000000000E1";
  const domain = envelopeV2Domain(verifying);
  const value = { id: 7n, recipient: "0x00000000000000000000000000000000000000A1", mode: MODE.EARN, minOut: 123n, deadline: 1_700_000_600n };
  // contract: keccak256("\x19\x01" || DOMAIN_SEPARATOR || keccak256(abi.encode(TYPEHASH, id, recipient, mode, minOut, deadline)))
  const coder = AbiCoder.defaultAbiCoder();
  const domainSep = keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "uint256", "address"], [
    keccak256(toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak256(toUtf8Bytes("Envelope")), keccak256(toUtf8Bytes("2")), 31611n, verifying]));
  const structHash = keccak256(coder.encode(["bytes32", "uint256", "address", "uint8", "uint256", "uint256"], [
    keccak256(toUtf8Bytes("ClaimWithOption(uint256 id,address recipient,uint8 mode,uint256 minOut,uint256 deadline)")),
    value.id, value.recipient, value.mode, value.minOut, value.deadline]));
  const digest = keccak256(concat(["0x1901", domainSep, structHash]));
  assert.equal(TypedDataEncoder.hash(domain, CLAIM_WITH_OPTION_TYPES, value), digest);
});

test("link key signs ClaimWithOption in the browser; the signature recovers to the link", async () => {
  const link = Wallet.createRandom();
  const domain = envelopeV2Domain("0x00000000000000000000000000000000000000E1");
  const value = { id: 1n, recipient: Wallet.createRandom().address, mode: MODE.GAS_TIP, minOut: 99n, deadline: 2_000_000_000n };
  const sig = await link.signTypedData(domain, CLAIM_WITH_OPTION_TYPES, value);
  assert.equal(recoverAddress(TypedDataEncoder.hash(domain, CLAIM_WITH_OPTION_TYPES, value), sig), link.address);
});

test("gas tip = min(1 MUSD, 5%), same as the contract's gasTipFor", () => {
  assert.equal(gasTipLocal(E(100)), E(1));
  assert.equal(gasTipLocal(E(20)), E(1));
  assert.equal(gasTipLocal(E(10)), E(1) / 2n);
  assert.equal(gasTipLocal(19n), 0n);
});

test("1% slippage", () => {
  assert.equal(withSlippage(1000n), 990n);
  assert.equal(withSlippage(329136352371n), 325844988847n);
});

test("EARN quote: Velodrome mint maths at the reserves after our own swap", () => {
  // swap 50 of 100; reserves 1000/1000 -> 1050/951; 50 MUSD needs 45 partner (< 49); LP = min(47, 47)
  const q = earnLpLocal({ amount: 100n, ratio: E(1) / 2n, partnerOut: 49n, reserveMusd: 1000n, reservePartner: 1000n, lpSupply: 1000n });
  assert.equal(q.swapIn, 50n);
  assert.equal(q.lp, 47n);
  // nothing to quote when the swap gives nothing
  assert.equal(earnLpLocal({ amount: 1n, ratio: E(1) / 2n, partnerOut: 0n, reserveMusd: 1000n, reservePartner: 1000n, lpSupply: 1000n }).lp, 0n);
});

test("quoteOptions returns null when the deployment has no pools", async () => {
  const zero = "0x0000000000000000000000000000000000000000";
  const env = { router: async () => zero, factory: async () => zero, partner: async () => zero, btc: async () => zero, earnPool: async () => zero };
  assert.equal(await quoteOptions({ env, at: () => { throw new Error("no calls"); }, musd: zero, amount: E(1) }), null);
});

// ---------------------------------------------------------------- api/claim.mjs input
const NOW = 1_700_000_000;
const sig = "0x" + "11".repeat(64) + "1b";
const rcpt = "0x00000000000000000000000000000000000000a1";
const opt = (extra = {}) => ({ id: "5", recipient: rcpt, mode: 1, minOut: "1000", deadline: String(NOW + 600), sig, v: 2, ...extra });

test("plain claims still parse for V1 and V2", () => {
  const v1 = parseClaimInput({ id: "5", recipient: rcpt, signature: sig }, NOW).value;
  assert.equal(v1.version, 1);
  assert.equal(v1.option, null);
  const v2 = parseClaimInput({ id: 5, recipient: rcpt, signature: sig, v: 2 }, NOW).value;
  assert.equal(v2.version, 2);
  assert.equal(v2.recipient, getAddress(rcpt));
  assert.equal(v2.option, null);
});

test("option claims parse: mode, minOut, deadline, sig (or signature)", () => {
  const v = parseClaimInput(opt(), NOW).value;
  assert.deepEqual(v.option, { mode: 1, minOut: 1000n, deadline: BigInt(NOW + 600) });
  assert.equal(v.signature, sig);
  assert.equal(parseClaimInput(opt({ mode: "2", sig: undefined, signature: sig }), NOW).value.option.mode, 2);
});

test("option claims are refused when anything is off", () => {
  const code = (body) => parseClaimInput(body, NOW).code;
  assert.equal(code(opt({ v: 1 })), "BadInput"); // V1 has no options
  assert.equal(code(opt({ v: undefined })), "BadInput");
  for (const mode of [0, 3, 255, "1.0", "x", -1, 1.5]) assert.equal(code(opt({ mode })), "BadInput", `mode ${mode}`);
  assert.equal(code(opt({ minOut: "0" })), "BadInput");
  assert.equal(code(opt({ minOut: "-1" })), "BadInput");
  assert.equal(code(opt({ minOut: "1".repeat(41) })), "BadInput");
  assert.equal(code(opt({ minOut: undefined })), "BadInput");
  assert.equal(code(opt({ deadline: String(NOW - 1) })), "SignatureExpired");
  assert.equal(code(opt({ deadline: String(NOW + 3601) })), "BadInput");
  assert.equal(code(opt({ deadline: "soon" })), "BadInput");
  assert.equal(code(opt({ sig: "0x1234" })), "BadInput");
  assert.equal(code(opt({ recipient: "0x123" })), "BadInput");
  assert.equal(code(null), "BadInput");
  assert.equal(code([]), "BadInput");
});

function mockRes() {
  return {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = JSON.parse(s); },
  };
}

test("handler: a valid option request without relayer config is a clear 503, bad ones a 400", async () => {
  const saved = { pk: process.env.RELAYER_PRIVATE_KEY, v2: process.env.ESCROW_ADDRESS_V2 };
  delete process.env.RELAYER_PRIVATE_KEY;
  delete process.env.ESCROW_ADDRESS_V2;
  try {
    const now = Math.floor(Date.now() / 1000);
    let res = mockRes();
    await handler({ method: "POST", headers: { "x-real-ip": "10.1.0.1" }, body: opt({ deadline: String(now + 600) }) }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "NotConfigured");
    res = mockRes();
    await handler({ method: "POST", headers: { "x-real-ip": "10.1.0.2" }, body: opt({ mode: 9 }) }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "BadInput");
    res = mockRes();
    await handler({ method: "POST", headers: { "x-real-ip": "10.1.0.3" }, body: opt({ deadline: "1" }) }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "SignatureExpired");
  } finally {
    if (saved.pk !== undefined) process.env.RELAYER_PRIVATE_KEY = saved.pk;
    if (saved.v2 !== undefined) process.env.ESCROW_ADDRESS_V2 = saved.v2;
  }
});
