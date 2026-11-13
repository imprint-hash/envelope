// Relayer: "Pay from my Bitcoin". The sender signed three typed messages and pays no gas.
// `amount` is the envelope amount (what the recipient gets); the sender pays total = amount + 0.5% fee on top.
//   1. Mezo WithdrawMUSD  -> borrow `total` against their Bitcoin, paid to their OWN wallet
//   2. MUSD Permit        -> let EnvelopeV2 pull exactly `total`
//   3. Envelope CreateFor -> lock `amount` into a link (binds the link address, so we can't swap it)
// We check the loan stays healthy, simulate, then submit (1) and (2+3) and wait for both.
// It never holds user money (the borrowed MUSD lands in the sender's wallet first).
// It never logs the request body, signatures or any key.
import {
  JsonRpcProvider, Wallet, Contract, isAddress, getAddress, ZeroAddress,
  verifyTypedData, Signature, parseEther, keccak256, toUtf8Bytes, formatUnits,
} from "ethers";
import { ESCROW_V2_ABI, CREATE_FOR_TYPES, envelopeV2Domain, encodeCreateFor } from "../public/js/abi-v2.js";
import { loanHealth, pct, SAFETY_FLOOR } from "../public/js/loan-math.js";

const CHAIN_ID = 31611;
const EXPLORER_TX = "https://explorer.test.mezo.org/tx/";
const MAX_BODY = 4096;
const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
const MIN_GAS_BALANCE = parseEther("0.001");
const MAX_GAS_BORROW = 3_000_000n;   // zero hints walk the sorted trove list: heavier, still correct
const MAX_GAS_CREATE = 400_000n;
const MIN_AMOUNT = 10n ** 18n;               // $1
const MAX_AMOUNT = 100_000n * 10n ** 18n;    // $100,000
const MAX_NOTE_BYTES = 140;
const MAX_DEADLINE_AHEAD = 86_400;           // signatures may live at most a day
const MIN_DEADLINE_AHEAD = 60;               // and must leave us a minute to land both txs
const WAIT_BORROW_MS = 40_000;
const WAIT_CREATE_MS = 15_000;

export const SAFETY_FLOOR_ICR = SAFETY_FLOOR; // 1.20e18, re-exported for tests

const MEZO = {
  troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
  borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
  borrowerOpsSignatures: "0xD757e3646AF370b15f32EB557F0F8380Df7D639e",
  priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
  musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
};
const TROVE_ABI = [
  "function getTroveStatus(address) view returns (uint8)",
  "function getCurrentICR(address, uint256 price) view returns (uint256)",
  "function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)",
  "function checkRecoveryMode(uint256 price) view returns (bool)",
];
const BO_ABI = ["function getBorrowingFee(uint256) view returns (uint256)"];
const BOS_ABI = [
  "function getNonce(address) view returns (uint256)",
  "function withdrawMUSDWithSignature(uint256 _amount, address _upperHint, address _lowerHint, address _borrower, address _recipient, bytes _signature, uint256 _deadline)",
];
const PRICE_ABI = ["function fetchPrice() view returns (uint256)"];
const MUSD_ABI = [
  "function nonces(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const WITHDRAW_DOMAIN = { name: "BorrowerOperationsSignatures", version: "1", chainId: CHAIN_ID, verifyingContract: MEZO.borrowerOpsSignatures };
const WITHDRAW_TYPES = {
  WithdrawMUSD: [
    { name: "amount", type: "uint256" }, { name: "borrower", type: "address" }, { name: "recipient", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};
const PERMIT_DOMAIN = { name: "Mezo USD", version: "1", chainId: CHAIN_ID, verifyingContract: MEZO.musd };
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

const MSG = {
  BadInput: "Something in that request didn't look right. Please refresh the page and try again.",
  TooSmall: "Please send at least $1 from your Bitcoin.",
  TooBig: "That's more than we can send in one envelope. Please try a smaller amount.",
  NoteTooLong: "Your note is a little too long. Please keep it under 140 characters.",
  SignatureExpired: "Your signatures expired. Please try again: it only takes a few seconds.",
  BadSignature: "Those signatures don't match your wallet. Please start again from the Send page.",
  NoTrove: "We couldn't find an open Mezo loan for this wallet. Open one at mezo.org, or pay with MUSD instead.",
  RecoveryMode: "Mezo is in recovery mode right now, so borrowing is paused to keep everyone's Bitcoin safe. Pay with MUSD instead, or try again later.",
  TooRisky: "Blocked: this would put your Bitcoin at risk. Please try a smaller amount.",
  BorrowRejected: "Mezo didn't accept this loan, so nothing was borrowed. Please try a smaller amount, or try again in a minute.",
  CreateFailedAfterBorrow: "We borrowed the money for you and it's safe in your own wallet, but the envelope wasn't created. Nothing is lost: you can send it now with \"Pay with my MUSD\".",
  RateLimited: "Too many tries. Please wait a minute and try again.",
  InFlight: "Your last envelope is still on its way. Give it a few seconds.",
  GasEmpty: "Our network-fee wallet is empty right now. Nothing was borrowed. Please try again later.",
  MethodNotAllowed: "Please use the Send page.",
  TooLarge: "That request was too big. Please try again.",
  NotConfigured: "Paying from Bitcoin isn't switched on yet. You can pay with MUSD for now.",
  Internal: "Something went wrong on our side. Nothing was borrowed. Please try again in a minute.",
};

// ---------------------------------------------------------------------------------------------
// Input validation (pure, exported for tests). `now` is the chain time in seconds.
// Returns { value } or { code, status }.
// ---------------------------------------------------------------------------------------------
const isHex = (s, bytes) => typeof s === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(s);
const isUint = (x, maxDigits = 30) => (typeof x === "string" && new RegExp(`^\\d{1,${maxDigits}}$`).test(x)) ||
  (typeof x === "number" && Number.isSafeInteger(x) && x >= 0);
const lowS = (sHex) => BigInt(sHex) <= HALF_N;
const sigOk = (sig) => isHex(sig, 65) && lowS("0x" + sig.slice(66, 130)) && [27, 28, 0, 1].includes(parseInt(sig.slice(130, 132), 16));

export function validateInput(data, now) {
  const bad = (code = "BadInput", status = 400) => ({ code, status });
  if (!data || typeof data !== "object" || Array.isArray(data)) return bad();
  const { sender, link, amount, note, noteHash, mezoSig, mezoDeadline, permit, authSig, authDeadline } = data;

  if (typeof sender !== "string" || !isAddress(sender)) return bad();
  if (typeof link !== "string" || !isAddress(link) || BigInt(link) === 0n) return bad();
  if (!isUint(amount)) return bad();
  const amt = BigInt(amount);
  if (amt < MIN_AMOUNT) return bad("TooSmall");
  if (amt > MAX_AMOUNT) return bad("TooBig");

  if (typeof note !== "string") return bad();
  if (Buffer.byteLength(note, "utf8") > MAX_NOTE_BYTES) return bad("NoteTooLong");
  if (!isHex(noteHash, 32) || noteHash.toLowerCase() !== keccak256(toUtf8Bytes(note)).toLowerCase()) return bad();

  if (!sigOk(mezoSig) || !sigOk(authSig)) return bad("BadSignature");
  if (!permit || typeof permit !== "object") return bad();
  const pv = Number(permit.v);
  if (![27, 28].includes(pv) || !isHex(permit.r, 32) || !isHex(permit.s, 32) || !lowS(permit.s)) return bad("BadSignature");

  for (const d of [mezoDeadline, authDeadline, permit.deadline]) if (!isUint(d, 12)) return bad();
  const deadlines = [BigInt(mezoDeadline), BigInt(authDeadline), BigInt(permit.deadline)];
  const t = BigInt(now);
  if (deadlines.some((d) => d < t + BigInt(MIN_DEADLINE_AHEAD))) return bad("SignatureExpired");
  if (deadlines.some((d) => d > t + BigInt(MAX_DEADLINE_AHEAD))) return bad();

  return {
    value: {
      sender: getAddress(sender), link: getAddress(link), amount: amt, note, noteHash: noteHash.toLowerCase(),
      mezoSig, mezoDeadline: deadlines[0], authSig, authDeadline: deadlines[1],
      permit: { v: pv, r: permit.r, s: permit.s, deadline: deadlines[2] },
    },
  };
}

// Off-chain signature checks with the live nonces: cheap, and saves gas on bad requests.
// total = amount + envelope fee: what Mezo lends and what the permit lets EnvelopeV2 pull.
export function checkSignatures(v, { escrowAddr, mezoNonce, envNonce, musdNonce, total }) {
  try {
    const m = verifyTypedData(WITHDRAW_DOMAIN, WITHDRAW_TYPES,
      { amount: total, borrower: v.sender, recipient: v.sender, nonce: mezoNonce, deadline: v.mezoDeadline }, v.mezoSig);
    if (getAddress(m) !== v.sender) return false;
    const a = verifyTypedData(envelopeV2Domain(escrowAddr, CHAIN_ID), CREATE_FOR_TYPES,
      { sender: v.sender, link: v.link, amount: v.amount, noteHash: v.noteHash, nonce: envNonce, deadline: v.authDeadline }, v.authSig);
    if (getAddress(a) !== v.sender) return false;
    const p = verifyTypedData(PERMIT_DOMAIN, PERMIT_TYPES,
      { owner: v.sender, spender: escrowAddr, value: total, nonce: musdNonce, deadline: v.permit.deadline },
      Signature.from({ r: v.permit.r, s: v.permit.s, v: v.permit.v }));
    return getAddress(p) === v.sender;
  } catch {
    return false;
  }
}

// ---- lazy context (nothing is built at import time, so missing env never crashes) ----
let ctx = null;
function getCtx() {
  if (ctx) return ctx;
  const pk = process.env.RELAYER_PRIVATE_KEY;
  const v2 = process.env.ESCROW_ADDRESS_V2;
  if (!pk || !v2 || !isAddress(v2) || BigInt(v2) === 0n) return null;
  const provider = new JsonRpcProvider(process.env.RPC_URL || "https://rpc.test.mezo.org", CHAIN_ID, { staticNetwork: true });
  const wallet = new Wallet(pk, provider);
  const escrowAddr = getAddress(v2);
  ctx = {
    provider, wallet, escrowAddr,
    escrow: new Contract(escrowAddr, ESCROW_V2_ABI, wallet),
    trove: new Contract(MEZO.troveManager, TROVE_ABI, provider),
    bo: new Contract(MEZO.borrowerOperations, BO_ABI, provider),
    bos: new Contract(MEZO.borrowerOpsSignatures, BOS_ABI, wallet),
    price: new Contract(MEZO.priceFeed, PRICE_ABI, provider),
    musd: new Contract(MEZO.musd, MUSD_ABI, provider),
  };
  return ctx;
}

// ---- rate limit: 5 / 60s per IP, 60 / 60s per instance (best effort), same as api/claim.mjs ----
const WINDOW = 60_000;
const ipHits = new Map();
let allHits = [];
const inFlight = new Set();

function rateLimited(ip, now) {
  allHits = allHits.filter((t) => now - t < WINDOW);
  const mine = (ipHits.get(ip) || []).filter((t) => now - t < WINDOW);
  if (mine.length >= 5 || allHits.length >= 60) { ipHits.set(ip, mine); return true; }
  mine.push(now); allHits.push(now); ipHits.set(ip, mine);
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < WINDOW)) ipHits.delete(k);
  return false;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
const fail = (res, status, code, extra = {}) => send(res, status, { ok: false, code, error: MSG[code] || MSG.Internal, ...extra });

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
      const s = req.body.toString();
      if (Buffer.byteLength(s) > MAX_BODY) return { tooBig: true };
      try { return { data: JSON.parse(s) }; } catch { return { data: null }; }
    }
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY) return { tooBig: true };
    return { data: req.body };
  }
  if (typeof req.on !== "function") return { data: null };
  return new Promise((resolve) => {
    let size = 0; const chunks = []; let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { done = true; resolve({ tooBig: true }); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return; done = true;
      try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString() || "null") }); } catch { resolve({ data: null }); }
    });
    req.on("error", () => { if (!done) { done = true; resolve({ data: null }); } });
  });
}

// A short, key-free reason for logs: custom error name or revert string, never calldata.
function reason(e, iface) {
  if (e?.revert?.name) return e.revert.name;
  if (typeof e?.reason === "string") return e.reason.slice(0, 120);
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (iface && typeof data === "string" && data.startsWith("0x")) {
    try { return iface.parseError(data)?.name || null; } catch { return null; }
  }
  return e?.code || null;
}

const usd = (wei) => "$" + Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 });

// Send with one retry on nonce trouble (two relayer calls racing), re-simulating first so a retry never burns gas.
async function sendTx(fn, args, gasLimit) {
  try {
    return await fn(...args, { gasLimit });
  } catch (e) {
    const m = String(e?.message || "").toLowerCase();
    if (!m.includes("nonce") && !m.includes("underpriced")) throw e;
    await fn.staticCall(...args);
    return fn(...args, { gasLimit });
  }
}

export default async function handler(req, res) {
  // 1. method + size
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return fail(res, 405, "MethodNotAllowed"); }
  const len = Number(req.headers?.["content-length"] || 0);
  if (len > MAX_BODY) return fail(res, 413, "TooLarge");

  // 2. rate limit
  const ip = String(req.headers?.["x-real-ip"] || req.headers?.["x-vercel-forwarded-for"] || req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip, Date.now())) return fail(res, 429, "RateLimited");

  const { data, tooBig } = await readBody(req);
  if (tooBig) return fail(res, 413, "TooLarge");

  const c = getCtx();
  if (!c) return fail(res, 503, "NotConfigured");
  const { provider, wallet, escrow, escrowAddr, trove, bo, bos, price: priceFeed, musd } = c;

  // 3. input shape (deadlines checked against chain time)
  let block;
  try { block = await provider.getBlock("latest"); } catch { return fail(res, 502, "Internal"); }
  const checked = validateInput(data, block.timestamp);
  if (checked.code) return fail(res, checked.status, checked.code);
  const v = checked.value;

  // 4. one envelope per sender at a time
  const key = v.sender;
  if (inFlight.has(key)) return fail(res, 409, "InFlight");
  inFlight.add(key);
  let borrowTx = null;
  try {
    // 5. the loan, read live from Mezo
    const [status, price, mezoNonce, envNonce, musdNonce, envFee] = await Promise.all([
      trove.getTroveStatus(v.sender), priceFeed.fetchPrice(),
      bos.getNonce(v.sender), escrow.nonces(v.sender), musd.nonces(v.sender), escrow.feeFor(v.amount),
    ]);
    if (Number(status) !== 1) return fail(res, 409, "NoTrove");
    const total = v.amount + envFee; // the sender pays the 0.5% on top; the recipient gets exactly v.amount

    // 6. signatures (off-chain, with live nonces)
    if (!checkSignatures(v, { escrowAddr, mezoNonce, envNonce, musdNonce, total })) return fail(res, 400, "BadSignature");

    const [recovery, icrNow, dc, fee] = await Promise.all([
      trove.checkRecoveryMode(price), trove.getCurrentICR(v.sender, price),
      trove.getEntireDebtAndColl(v.sender), bo.getBorrowingFee(total),
    ]);
    // New debt = total borrowed (amount + envelope fee) + Mezo's borrowing fee on it.
    const health = loanHealth({ coll: dc.coll, debt: dc.principal + dc.interest, price, amount: total, fee, recoveryMode: recovery });
    const loan = {
      icrNow: pct(icrNow), icrAfter: pct(health.icrAfter), floor: 120,
      borrowed: formatUnits(total, 18), envelopeFee: formatUnits(envFee, 18), borrowingFee: formatUnits(fee, 18),
    };
    if (recovery) return fail(res, 409, "RecoveryMode", { loan });
    if (health.icrAfter < SAFETY_FLOOR) {
      return fail(res, 422, "TooRisky", {
        loan,
        error: `Blocked: this would put your Bitcoin at risk. Borrowing ${usd(total)} would take your loan to ${loan.icrAfter}%, below our 120% safety floor. Please try a smaller amount.`,
      });
    }

    // 7. gas tank
    if ((await provider.getBalance(wallet.address)) < MIN_GAS_BALANCE) return fail(res, 503, "GasEmpty");

    // 8. simulate the borrow (and the envelope too, when the sender already holds enough MUSD).
    //    Before the borrow lands the sender usually can't fund createFor yet, so its signature and
    //    permit were checked off-chain above and createFor is simulated again right after step 9.
    const borrowArgs = [total, ZeroAddress, ZeroAddress, v.sender, v.sender, v.mezoSig, v.mezoDeadline];
    const createArgs = encodeCreateFor(v);
    let borrowGas;
    try {
      borrowGas = await bos.withdrawMUSDWithSignature.estimateGas(...borrowArgs);
    } catch (e) {
      console.error("borrow simulate failed", { sender: v.sender, reason: reason(e) });
      return fail(res, 400, "BorrowRejected", { loan });
    }
    if ((await musd.balanceOf(v.sender)) >= total) {
      try { await escrow.createFor.staticCall(...createArgs); } catch (e) {
        console.error("createFor pre-simulate failed", { sender: v.sender, reason: reason(e, escrow.interface) });
        return fail(res, 400, "BadSignature");
      }
    }
    const borrowLimit = (borrowGas * 13n) / 10n;
    if (borrowLimit > MAX_GAS_BORROW) return fail(res, 500, "Internal");

    // 9. borrow `total`: MUSD goes to the sender's own wallet
    const btx = await sendTx(bos.withdrawMUSDWithSignature, borrowArgs, borrowLimit);
    borrowTx = btx.hash;
    console.log("borrow sent", { sender: v.sender, txHash: borrowTx });
    const brc = await provider.waitForTransaction(borrowTx, 1, WAIT_BORROW_MS);
    if (!brc || brc.status !== 1) {
      console.error("borrow failed on chain", { sender: v.sender, txHash: borrowTx });
      return fail(res, 502, "BorrowRejected", { borrowTx });
    }

    // 10. simulate then send createFor
    let createGas;
    try {
      createGas = await escrow.createFor.estimateGas(...createArgs);
    } catch (e) {
      console.error("createFor simulate failed after borrow", { sender: v.sender, reason: reason(e, escrow.interface) });
      return fail(res, 502, "CreateFailedAfterBorrow", { borrowTx, borrowExplorerUrl: EXPLORER_TX + borrowTx });
    }
    const createLimit = (createGas * 13n) / 10n;
    if (createLimit > MAX_GAS_CREATE) return fail(res, 502, "CreateFailedAfterBorrow", { borrowTx });
    const ctx2 = await sendTx(escrow.createFor, createArgs, createLimit);
    console.log("createFor sent", { sender: v.sender, txHash: ctx2.hash });

    // 11. wait briefly for the envelope id; if it's slow, the page waits for the receipt itself.
    let id = null, net = null, pending = false;
    try {
      const crc = await provider.waitForTransaction(ctx2.hash, 1, WAIT_CREATE_MS);
      if (!crc) pending = true;
      else if (crc.status !== 1) return fail(res, 502, "CreateFailedAfterBorrow", { borrowTx, createTx: ctx2.hash });
      else {
        for (const log of crc.logs) {
          if (getAddress(log.address) !== escrowAddr) continue;
          try {
            const p = escrow.interface.parseLog(log);
            if (p?.name === "Created") { id = p.args.id.toString(); net = p.args.amount.toString(); break; }
          } catch { /* not ours */ }
        }
      }
    } catch { pending = true; }

    return send(res, 200, {
      ok: true, pending, id, net, total: total.toString(), fee: envFee.toString(), borrowTx, createTx: ctx2.hash,
      borrowExplorerUrl: EXPLORER_TX + borrowTx, explorerUrl: EXPLORER_TX + ctx2.hash, loan,
    });
  } catch (e) {
    console.error("borrow-send error", { sender: v.sender, code: e?.code || "unknown", borrowed: !!borrowTx });
    if (borrowTx) return fail(res, 502, "CreateFailedAfterBorrow", { borrowTx });
    return fail(res, 500, "Internal");
  } finally {
    inFlight.delete(key);
  }
}
