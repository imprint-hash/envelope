// Relayer: submits claimFor(id, recipient, sig) and pays the gas.
// Body: { id, recipient, signature, v? }. v = 2 claims from EnvelopeV2 (ESCROW_ADDRESS_V2), otherwise LinkEscrow (V1).
// Mezo Pools options (V2 only): { id, recipient, mode, minOut, deadline, sig, v: 2 } -> claimWithOption.
//   mode 1 = EARN (MUSD/mUSDC Mezo Pools position), 2 = GAS_TIP (a little BTC for gas, rest as MUSD).
// It never holds user money. It never logs the request body or any key.
import {
  JsonRpcProvider, Wallet, Contract, isAddress, getAddress,
  verifyTypedData, Signature, parseEther, recoverAddress,
} from "ethers";
import { ESCROW_V2_ABI } from "../public/js/abi-v2.js";

const CHAIN_ID = 31611;
const EXPLORER_TX = "https://explorer.test.mezo.org/tx/";
const MAX_BODY = 2048;
const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
const MIN_GAS_BALANCE = parseEther("0.0005");
const MAX_GAS_LIMIT = 250000n;
const MAX_GAS_LIMIT_V2 = 300000n; // V2 also pays the relayer reward from gasFund
const MAX_GAS_LIMIT_OPTION = 1000000n; // swap (+ addLiquidity) through the Mezo Pools router
const MAX_OPTION_DEADLINE_AHEAD = 60 * 60; // the page signs ~10 minutes ahead; refuse anything over an hour

export const ESCROW_ABI = [
  "function create(address link, uint256 amount, string note) returns (uint256 id)",
  "function createWithPermit(address link, uint256 amount, string note, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 id)",
  "function claimFor(uint256 id, address recipient, bytes sig)",
  "function refund(uint256 id)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function claimDigest(uint256 id, address recipient) view returns (bytes32)",
  "function getDeposit(uint256 id) view returns (tuple(address sender, uint64 expiresAt, uint8 status, address link, uint96 amount) d, string note)",
  "function idsOf(address sender) view returns (uint256[])",
  "event Created(uint256 indexed id, address indexed sender, address indexed link, uint256 amount, uint64 expiresAt, string note)",
  "event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount)",
  "event Refunded(uint256 indexed id, address indexed sender, uint256 amount)",
  "error ZeroAmount()", "error AmountTooLarge()", "error ZeroLink()", "error ZeroRecipient()",
  "error NoteTooLong()", "error NotFound()", "error AlreadyClaimed()", "error AlreadyRefunded()",
  "error Expired()", "error NotExpired()", "error BadSignature()", "error Reentrancy()",
  "error TransferFailed()", "error NotAContract()",
];

const TYPES = { Claim: [{ name: "id", type: "uint256" }, { name: "recipient", type: "address" }] };

const MSG = {
  NotFound: "We couldn't find this link. Make sure you copied the whole thing.",
  AlreadyClaimed: "This money has already been claimed.",
  AlreadyRefunded: "This link expired and the money went back to the sender.",
  TooSmall: "This link is too small for us to cover the fee. The sender can claim it back after 7 days.",
  Expired: "This link has expired. The sender can take the money back. Ask them to send a new one.",
  BadSignature: "This link looks damaged. Ask the sender to share it again.",
  ZeroRecipient: "We couldn't set up your wallet. Please refresh and try again.",
  BadInput: "This link looks incomplete. Please open it again from the original message.",
  RateLimited: "Too many tries. Please wait a minute and try again.",
  InFlight: "This claim is already on its way. Give it a few seconds.",
  GasEmpty: "Our network-fee wallet is empty right now. Please try again later.",
  MethodNotAllowed: "Please open your link in the app to claim.",
  TooLarge: "That request was too big. Please open your link again.",
  NotConfigured: "Claims aren't switched on yet. Please try again a little later.",
  Internal: "Something went wrong on our side. Your money is safe in the link. Please try again in a minute.",
  SignatureExpired: "That took a little too long. Please tap your choice again.",
  PriceMoved: "Prices moved a little since we checked. Your money is safe in the link. Tap again for a fresh quote, or keep it as dollars.",
  OptionTooSmall: "This link is too small for that option. You can still keep it as dollars.",
  OptionsOff: "That option isn't switched on yet. You can still keep it as dollars.",
};
const MIN_SPONSORED_AMOUNT = 10n ** 16n; // 0.01 MUSD
const STATUS_FOR = { NotFound: 404, AlreadyClaimed: 409, AlreadyRefunded: 410, Expired: 410, BadSignature: 400, ZeroRecipient: 400 };
// Contract errors from claimWithOption -> our codes.
const OPTION_ERRORS = {
  InsufficientOutput: ["PriceMoved", 409], SignatureExpired: ["SignatureExpired", 400], AmountTooSmall: ["OptionTooSmall", 400],
  PoolsDisabled: ["OptionsOff", 503], BadMode: ["BadInput", 400],
};

/**
 * Pure input check (no network). Returns { value } or { code, status }.
 * value = { version, id, recipient, signature, option: null | { mode, minOut, deadline } }.
 */
export function parseClaimInput(data, nowSec) {
  const bad = (code = "BadInput", status = 400) => ({ code, status });
  if (!data || typeof data !== "object" || Array.isArray(data)) return bad();
  const idRaw = typeof data.id === "string" || typeof data.id === "number" ? String(data.id) : "";
  const recipientRaw = typeof data.recipient === "string" ? data.recipient : "";
  const signature = typeof data.signature === "string" ? data.signature : typeof data.sig === "string" ? data.sig : "";
  const vRaw = data.v ?? 1;
  if (vRaw !== 1 && vRaw !== 2 && vRaw !== "1" && vRaw !== "2") return bad();
  const version = Number(vRaw);
  if (!/^\d{1,12}$/.test(idRaw) || !isAddress(recipientRaw) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return bad();
  const value = { version, id: BigInt(idRaw), recipient: getAddress(recipientRaw), signature, option: null };
  if (data.mode === undefined || data.mode === null) return { value };

  // Mezo Pools option: V2 only, every field present and in range.
  const mode = Number(data.mode);
  if (version !== 2 || (mode !== 1 && mode !== 2) || String(data.mode) !== String(mode)) return bad();
  const minOutRaw = typeof data.minOut === "string" || typeof data.minOut === "number" ? String(data.minOut) : "";
  const deadlineRaw = typeof data.deadline === "string" || typeof data.deadline === "number" ? String(data.deadline) : "";
  if (!/^\d{1,40}$/.test(minOutRaw) || !/^\d{1,12}$/.test(deadlineRaw)) return bad();
  const minOut = BigInt(minOutRaw), deadline = BigInt(deadlineRaw);
  if (minOut === 0n) return bad(); // the page always sends a real quote minus 1%
  const now = BigInt(nowSec);
  if (deadline < now) return bad("SignatureExpired");
  if (deadline > now + BigInt(MAX_OPTION_DEADLINE_AHEAD)) return bad();
  value.option = { mode, minOut, deadline };
  return { value };
}

// ---- lazy context (nothing is built at import time, so missing env never crashes) ----
const ctxs = {};
function getCtx(version) {
  if (ctxs[version]) return ctxs[version];
  const pk = process.env.RELAYER_PRIVATE_KEY;
  const escrowAddr = version === 2 ? process.env.ESCROW_ADDRESS_V2 : process.env.ESCROW_ADDRESS;
  if (!pk || !escrowAddr || !isAddress(escrowAddr) || BigInt(escrowAddr) === 0n) return null;
  const provider = new JsonRpcProvider(process.env.RPC_URL || "https://rpc.test.mezo.org", CHAIN_ID, { staticNetwork: true });
  const wallet = new Wallet(pk, provider);
  const escrow = new Contract(getAddress(escrowAddr), version === 2 ? ESCROW_V2_ABI : ESCROW_ABI, wallet);
  ctxs[version] = { provider, wallet, escrow, escrowAddr: getAddress(escrowAddr) };
  return ctxs[version];
}

// ---- rate limit: 5 / 60s per IP, 60 / 60s per instance (best effort) ----
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
const fail = (res, status, code) => send(res, status, { ok: false, code, error: MSG[code] || MSG.Internal });

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

function revertName(e, iface) {
  if (e?.revert?.name) return e.revert.name;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data === "string" && data.startsWith("0x")) {
    try { return iface.parseError(data)?.name || null; } catch { return null; }
  }
  return null;
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

  // 3. input shape
  const parsed = parseClaimInput(data, Math.floor(Date.now() / 1000));
  if (!parsed.value) return fail(res, parsed.status, parsed.code);
  const { version, id, recipient, signature, option } = parsed.value;
  // What we submit: a plain claim, or a Mezo Pools option (V2 only).
  const fn = option ? "claimWithOption" : "claimFor";
  const args = option
    ? [id, recipient, option.mode, option.minOut, option.deadline, signature]
    : [id, recipient, signature];

  const c = getCtx(version);
  if (!c) return fail(res, 503, "NotConfigured");
  const { provider, wallet, escrow, escrowAddr } = c;

  // 4. in-flight lock
  const key = `${version}:${id}`;
  if (inFlight.has(key)) return fail(res, 409, "InFlight");
  inFlight.add(key);
  try {
    // 5. on-chain prechecks
    const [[d], block] = await Promise.all([escrow.getDeposit(id), provider.getBlock("latest")]);
    const status = Number(d.status);
    if (status === 0) return fail(res, 404, "NotFound");
    if (status === 2) return fail(res, 409, "AlreadyClaimed");
    if (status === 3) return fail(res, 410, "AlreadyRefunded");
    if (BigInt(block.timestamp) >= BigInt(d.expiresAt)) return fail(res, 410, "Expired");
    // Dust links would let anyone drain the fee wallet one tiny claim at a time.
    if (BigInt(d.amount) < MIN_SPONSORED_AMOUNT) return fail(res, 400, "TooSmall");

    // 6. signature precheck (same rules as the contract)
    try {
      // V1: the known LinkEscrow domain. V2: the contract's own claimDigest, so its domain can't drift from ours.
      const signer = option
        ? recoverAddress(await escrow.claimWithOptionDigest(id, recipient, option.mode, option.minOut, option.deadline), signature)
        : version === 2
        ? recoverAddress(await escrow.claimDigest(id, recipient), signature)
        : verifyTypedData({ name: "LinkEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrowAddr }, TYPES, { id, recipient }, signature);
      const s = BigInt("0x" + signature.slice(66, 130));
      if (s > HALF_N || getAddress(signer) !== getAddress(d.link)) return fail(res, 400, "BadSignature");
      Signature.from(signature); // throws on a malformed v
    } catch {
      return fail(res, 400, "BadSignature");
    }

    // 7. simulate
    try {
      await escrow[fn].staticCall(...args);
    } catch (e) {
      const name = revertName(e, escrow.interface);
      console.error("claim simulate failed", { id: key, recipient, mode: option?.mode ?? 0, code: name || e?.code });
      if (name && STATUS_FOR[name]) return fail(res, STATUS_FOR[name], name);
      if (option && name && OPTION_ERRORS[name]) return fail(res, OPTION_ERRORS[name][1], OPTION_ERRORS[name][0]);
      // Any other revert inside the pools (e.g. the router's own minimum-out check) = the price moved.
      if (option && e?.code === "CALL_EXCEPTION") return fail(res, 409, "PriceMoved");
      return fail(res, 500, "Internal");
    }

    // 8. gas tank
    if ((await provider.getBalance(wallet.address)) < MIN_GAS_BALANCE) return fail(res, 503, "GasEmpty");

    // 9. send
    const gas = await escrow[fn].estimateGas(...args);
    const gasLimit = (gas * 13n) / 10n;
    const cap = option ? MAX_GAS_LIMIT_OPTION : version === 2 ? MAX_GAS_LIMIT_V2 : MAX_GAS_LIMIT;
    if (gasLimit > cap) return fail(res, 500, "Internal");
    let tx;
    try {
      tx = await escrow[fn](...args, { gasLimit });
    } catch (e) {
      const m = String(e?.message || "").toLowerCase();
      if (!m.includes("nonce") && !m.includes("underpriced")) throw e;
      // The first send may have landed after all; simulate again so a retry never burns gas on a revert.
      await escrow[fn].staticCall(...args);
      tx = await escrow[fn](...args, { gasLimit });
    }
    console.log("claim sent", { id: key, version, mode: option?.mode ?? 0, recipient, txHash: tx.hash });
    return send(res, 200, { ok: true, txHash: tx.hash, explorerUrl: EXPLORER_TX + tx.hash });
  } catch (e) {
    // 10. anything unexpected
    console.error("claim error", { id: key, recipient, code: e?.code || "unknown" });
    return fail(res, 500, "Internal");
  } finally {
    inFlight.delete(key);
  }
}
