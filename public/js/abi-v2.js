// EnvelopeV2: the ABI and EIP-712 shapes the web app and the relayer code against.
//
// Checked against the compiled ABI (docs/abi/EnvelopeV2.json) by test/node/claim-option.test.mjs:
// every entry here must exist there with the same selector. Struct field ORDER matters:
// all createFor encoding lives in encodeCreateFor() below, so a change there is a one-place fix.
//
// Pure module (no imports, no browser globals): it is shared by public/js/*.js and api/borrow-send.mjs.

// Fee model: the SENDER pays 0.5% ON TOP; the recipient gets exactly the envelope amount.
// The contract pulls amount + fee (fee rounded UP) and keeps the fee in gasFund.
export const FEE_BPS = 50n; // 0.5%. Matches the contract's immutable FEE_BPS; signing flows read feeFor() on chain.

export const ESCROW_V2_ABI = [
  "function create(address link, uint256 amount, string note) returns (uint256 id)",
  "function createWithPermit(address link, uint256 amount, string note, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 id)",
  // CreateForArgs = (sender, link, amount, deadline, note); PermitArgs = (deadline, v, r, s).
  // amount = envelope amount (what the recipient gets). Permit value = amount + feeFor(amount).
  "function createFor((address sender, address link, uint256 amount, uint256 deadline, string note) a, bytes authSig, (uint256 deadline, uint8 v, bytes32 r, bytes32 s) p) returns (uint256 id)",
  "function claimFor(uint256 id, address recipient, bytes sig)",
  // Mezo Pools claim options, signed by the link key (ClaimWithOption below). mode 1 = EARN, 2 = GAS_TIP.
  "function claimWithOption(uint256 id, address recipient, uint8 mode, uint256 minOut, uint256 deadline, bytes sig)",
  "function claimWithOptionDigest(uint256 id, address recipient, uint8 mode, uint256 minOut, uint256 deadline) view returns (bytes32)",
  "function gasTipFor(uint256 amount) pure returns (uint256 tip)",
  "function router() view returns (address)",
  "function factory() view returns (address)",
  "function partner() view returns (address)",
  "function btc() view returns (address)",
  "function earnPool() view returns (address)",
  "function btcPool() view returns (address)",
  "function refund(uint256 id)",
  "function feeFor(uint256 amount) view returns (uint256)",
  "function quote(uint256 amount) view returns (uint256 total, uint256 fee)", // total = amount + fee, paid by the sender
  "function gasFund() view returns (uint256)",
  "function nonces(address sender) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function claimDigest(uint256 id, address recipient) view returns (bytes32)",
  "function getDeposit(uint256 id) view returns (tuple(address sender, uint64 expiresAt, uint8 status, address link, uint96 amount) d, string note)",
  "function idsOf(address sender) view returns (uint256[])",
  "event Created(uint256 indexed id, address indexed sender, address indexed link, uint256 amount, uint64 expiresAt, string note)",
  "event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount)",
  "event Refunded(uint256 indexed id, address indexed sender, uint256 amount)",
  "event FeeTaken(uint256 indexed id, uint256 fee)",
  "event RelayerPaid(address indexed relayer, uint256 amount)",
  "event Swept(uint256 amount)",
  "event ClaimedWithOption(uint256 indexed id, address indexed recipient, uint8 mode, uint256 musdSent, uint256 out)",
  "error ZeroAmount()", "error AmountTooLarge()", "error ZeroLink()", "error ZeroRecipient()", "error ZeroAddress()",
  "error NoteTooLong()", "error NotFound()", "error AlreadyClaimed()", "error AlreadyRefunded()",
  "error Expired()", "error NotExpired()", "error BadSignature()", "error SignatureExpired()", "error PermitFailed()",
  "error Reentrancy()", "error TransferFailed()", "error WrongAmountReceived()", "error NotAContract()",
  "error PoolsDisabled()", "error BadMode()", "error AmountTooSmall()", "error InsufficientOutput()", "error RouterMisbehaved()",
];

// ---------- Mezo Pools claim options ----------
export const MODE = { EARN: 1, GAS_TIP: 2 };
export const SLIPPAGE_BPS = 100n; // 1%: minOut = quote * 99%

// EIP-712, signed in the browser by the LINK KEY (domain = envelopeV2Domain).
export const CLAIM_WITH_OPTION_TYPES = {
  ClaimWithOption: [
    { name: "id", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "mode", type: "uint8" },
    { name: "minOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// Mezo Pools router (testnet 0x9a1f…E7E9), signatures from the verified ABI on the Mezo explorer.
export const POOLS_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
  "function getReserves(address tokenA, address tokenB, bool stable, address factory) view returns (uint256 reserveA, uint256 reserveB)",
  "function quoteAddLiquidity(address tokenA, address tokenB, bool stable, address factory, uint256 amountADesired, uint256 amountBDesired) view returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function quoteStableLiquidityRatio(address tokenA, address tokenB, address factory) view returns (uint256 ratio)",
];
export const POOL_ABI = ["function totalSupply() view returns (uint256)"];

/** MUSD that GAS_TIP turns into BTC: min(1 MUSD, 5%). Same as the contract's gasTipFor(). */
export function gasTipLocal(amount) {
  const tip = (amount * 500n) / 10_000n;
  return tip > 10n ** 18n ? 10n ** 18n : tip;
}

export const withSlippage = (quote) => (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;

/**
 * LP tokens EARN should mint, mirroring the contract: swap `ratio` of the amount to the partner,
 * then add liquidity at the reserves AFTER our own swap (Velodrome mint maths: the smaller side wins).
 * All inputs are bigints read from the router/pool.
 */
export function earnLpLocal({ amount, ratio, partnerOut, reserveMusd, reservePartner, lpSupply }) {
  const swapIn = (amount * ratio) / 10n ** 18n;
  const rA = reserveMusd + swapIn;
  const rB = reservePartner - partnerOut;
  if (swapIn === 0n || partnerOut === 0n || rB <= 0n || lpSupply === 0n) return { swapIn, lp: 0n, musdShare: 0n, partnerShare: 0n };
  const keep = amount - swapIn;
  let a = keep, b = (keep * rB) / rA;
  if (b > partnerOut) { a = (partnerOut * rA) / rB; b = partnerOut; }
  const la = (a * lpSupply) / rA, lb = (b * lpSupply) / rB;
  const lp = la < lb ? la : lb;
  // The pool tokens behind those LP tokens at the post-swap reserves.
  return { swapIn, lp, musdShare: (lp * rA) / lpSupply, partnerShare: (lp * rB) / lpSupply };
}

/**
 * Read live quotes for both options from the envelope's own router and pools.
 * env = EnvelopeV2 contract (read-only); at(address, abi) builds a read-only contract.
 */
export async function quoteOptions({ env, at, musd, amount }) {
  const [routerAddr, factory, partner, btc, earnPool] = await Promise.all([
    env.router(), env.factory(), env.partner(), env.btc(), env.earnPool(),
  ]);
  if (BigInt(routerAddr) === 0n) return null; // options switched off in this deployment
  const router = at(routerAddr, POOLS_ROUTER_ABI);
  const pool = at(earnPool, POOL_ABI);
  const tip = gasTipLocal(amount);
  const ratio = await router.quoteStableLiquidityRatio(musd, partner, factory);
  const swapIn = (amount * ratio) / 10n ** 18n;
  const [[, partnerOut], [, btcOut], [reserveMusd, reservePartner], lpSupply] = await Promise.all([
    router.getAmountsOut(swapIn, [{ from: musd, to: partner, stable: true, factory }]),
    tip > 0n ? router.getAmountsOut(tip, [{ from: musd, to: btc, stable: false, factory }]) : [0n, 0n],
    router.getReserves(musd, partner, true, factory),
    pool.totalSupply(),
  ]);
  const { lp, musdShare, partnerShare } = earnLpLocal({ amount, ratio, partnerOut, reserveMusd, reservePartner, lpSupply });
  // "Worth about": the MUSD side plus what the partner side would swap back to in MUSD today.
  const [, partnerBack] = partnerShare > 0n
    ? await router.getAmountsOut(partnerShare, [{ from: partner, to: musd, stable: true, factory }])
    : [0n, 0n];
  const valueUsd = musdShare + partnerBack;
  return {
    earn: { lp, minOut: withSlippage(lp), swapIn, partnerOut, valueUsd },
    gasTip: { tip, btcOut, minOut: withSlippage(btcOut), musdRest: amount - tip },
  };
}

// EIP-712 for createFor, signed by the sender in their wallet.
export const envelopeV2Domain = (verifyingContract, chainId = 31611) =>
  ({ name: "Envelope", version: "2", chainId, verifyingContract });

export const CREATE_FOR_TYPES = {
  CreateFor: [
    { name: "sender", type: "address" },
    { name: "link", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "noteHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * The ONLY place that turns our plain request into createFor's arguments.
 * amount = envelope amount. permit = { v, r, s, deadline }; its value is always amount + fee.
 * Returns the argument list for contract.createFor(...args).
 */
export function encodeCreateFor({ sender, link, amount, note, authDeadline, authSig, permit }) {
  const a = { sender, link, amount, deadline: authDeadline, note };
  const p = { deadline: permit.deadline, v: permit.v, r: permit.r, s: permit.s };
  return [a, authSig, p];
}

// What the sender pays for an envelope of `amount`: fee = ceil(amount * 0.5%), total = amount + fee.
// Same rounding as the contract (rounded up). The recipient always gets exactly `amount`.
export function quoteLocal(amount) {
  const fee = (amount * FEE_BPS + 9_999n) / 10_000n;
  return { total: amount + fee, fee };
}
