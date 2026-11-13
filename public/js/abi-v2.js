// EnvelopeV2: the ABI and EIP-712 shapes the web app and the relayer code against.
//
// ASSUMED ABI. Written in parallel with contracts/EnvelopeV2.sol, from WAVE2_SPEC.md and the
// contract draft as of 13 Nov. Before deploy, compare this file with the compiled ABI
// (out/EnvelopeV2.sol/EnvelopeV2.json) and fix anything that differs. Struct field ORDER matters:
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
  "error ZeroAmount()", "error AmountTooLarge()", "error ZeroLink()", "error ZeroRecipient()", "error ZeroAddress()",
  "error NoteTooLong()", "error NotFound()", "error AlreadyClaimed()", "error AlreadyRefunded()",
  "error Expired()", "error NotExpired()", "error BadSignature()", "error SignatureExpired()", "error PermitFailed()",
  "error Reentrancy()", "error TransferFailed()", "error WrongAmountReceived()", "error NotAContract()",
];

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
