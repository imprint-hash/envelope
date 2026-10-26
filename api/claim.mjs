// Relayer: submits claimFor(id, recipient, sig) and pays the gas.
// It never holds user money. It never logs the request body or any key.
import {
  JsonRpcProvider, Wallet, Contract, isAddress, getAddress,
  verifyTypedData, Signature, parseEther,
} from "ethers";

const CHAIN_ID = 31611;
const EXPLORER_TX = "https://explorer.test.mezo.org/tx/";
const MAX_BODY = 2048;
const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
const MIN_GAS_BALANCE = parseEther("0.0005");
const MAX_GAS_LIMIT = 250000n;

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
};
const MIN_SPONSORED_AMOUNT = 10n ** 16n; // 0.01 MUSD
const STATUS_FOR = { NotFound: 404, AlreadyClaimed: 409, AlreadyRefunded: 410, Expired: 410, BadSignature: 400, ZeroRecipient: 400 };

// ---- lazy context (nothing is built at import time, so missing env never crashes) ----
let ctx = null;
function getCtx() {
  if (ctx) return ctx;
  const pk = process.env.RELAYER_PRIVATE_KEY;
  const escrowAddr = process.env.ESCROW_ADDRESS;
  if (!pk || !escrowAddr || !isAddress(escrowAddr)) return null;
  const provider = new JsonRpcProvider(process.env.RPC_URL || "https://rpc.test.mezo.org", CHAIN_ID, { staticNetwork: true });
  const wallet = new Wallet(pk, provider);
  const escrow = new Contract(getAddress(escrowAddr), ESCROW_ABI, wallet);
  ctx = { provider, wallet, escrow, escrowAddr: getAddress(escrowAddr) };
  return ctx;
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
  const idRaw = data && (typeof data.id === "string" || typeof data.id === "number") ? String(data.id) : "";
  const recipientRaw = data && typeof data.recipient === "string" ? data.recipient : "";
  const signature = data && typeof data.signature === "string" ? data.signature : "";
  if (!/^\d{1,12}$/.test(idRaw) || !isAddress(recipientRaw) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return fail(res, 400, "BadInput");
  }
  const id = BigInt(idRaw);
  const recipient = getAddress(recipientRaw);

  const c = getCtx();
  if (!c) return fail(res, 503, "NotConfigured");
  const { provider, wallet, escrow, escrowAddr } = c;

  // 4. in-flight lock
  const key = id.toString();
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
      const domain = { name: "LinkEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrowAddr };
      const signer = verifyTypedData(domain, TYPES, { id, recipient }, signature);
      const s = BigInt("0x" + signature.slice(66, 130));
      if (s > HALF_N || getAddress(signer) !== getAddress(d.link)) return fail(res, 400, "BadSignature");
      Signature.from(signature); // throws on a malformed v
    } catch {
      return fail(res, 400, "BadSignature");
    }

    // 7. simulate
    try {
      await escrow.claimFor.staticCall(id, recipient, signature);
    } catch (e) {
      const name = revertName(e, escrow.interface);
      console.error("claim simulate failed", { id: key, recipient, code: name || e?.code });
      if (name && STATUS_FOR[name]) return fail(res, STATUS_FOR[name], name);
      return fail(res, 500, "Internal");
    }

    // 8. gas tank
    if ((await provider.getBalance(wallet.address)) < MIN_GAS_BALANCE) return fail(res, 503, "GasEmpty");

    // 9. send
    const gas = await escrow.claimFor.estimateGas(id, recipient, signature);
    const gasLimit = (gas * 13n) / 10n;
    if (gasLimit > MAX_GAS_LIMIT) return fail(res, 500, "Internal");
    let tx;
    try {
      tx = await escrow.claimFor(id, recipient, signature, { gasLimit });
    } catch (e) {
      const m = String(e?.message || "").toLowerCase();
      if (!m.includes("nonce") && !m.includes("underpriced")) throw e;
      // The first send may have landed after all; simulate again so a retry never burns gas on a revert.
      await escrow.claimFor.staticCall(id, recipient, signature);
      tx = await escrow.claimFor(id, recipient, signature, { gasLimit });
    }
    console.log("claim sent", { id: key, recipient, txHash: tx.hash });
    return send(res, 200, { ok: true, txHash: tx.hash, explorerUrl: EXPLORER_TX + tx.hash });
  } catch (e) {
    // 10. anything unexpected
    console.error("claim error", { id: key, recipient, code: e?.code || "unknown" });
    return fail(res, 500, "Internal");
  } finally {
    inFlight.delete(key);
  }
}
