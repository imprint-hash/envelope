// The one place to rename the product.
export const APPNAME = "Envelope";

export const CHAIN = {
  id: 31611,
  hex: "0x7b7b",
  name: "Mezo Testnet",
  rpc: "https://rpc.test.mezo.org",
  explorer: "https://explorer.test.mezo.org",
};

// The deployed LinkEscrow (V1) on Mezo testnet (public, safe to commit). Kept forever so old links still work.
export const ESCROW_ADDRESS = "0x2330b264BF90E94F4926fD819c1281F799005c01";

// EnvelopeV2 (0.5% fee, createFor, "Pay from my Bitcoin").
// Deployed + verified on Mezo testnet 13 Nov 2026: https://explorer.test.mezo.org/address/0x06b4B5A507FDb61d6d082007ab48aD76B26dFa26
// Creation tx 0x731b43e5b7bfb45f940bd0970fd31bb565f5e6ed8386bc57c5b4b30936fc149c (block 16758217).
// The relayer reads its own copy from the ESCROW_ADDRESS_V2 env var.
export const ESCROW_ADDRESS_V2 = "0x06b4B5A507FDb61d6d082007ab48aD76B26dFa26";

// Blocks the contracts were deployed in. The Stats page reads events from here forward (Mezo's RPC caps
// eth_getLogs at 10,000 blocks per call, so it pages in 10k windows down to these blocks).
// V1: creation tx 0x26bdfdf759ead91c212a27786fb7fffde540fb5863b55f09f3e4d54edb11b1d3 (block 16380327).
export const ESCROW_DEPLOY_BLOCK = 16380327;
export const ESCROW_V2_DEPLOY_BLOCK = 16758217;
// "Claim into Mezo Pools / a little BTC" — the Stats page counts calls by this function selector.
export const CLAIM_OPTION_SIG = "claimWithOption(uint256,address,uint8,uint256,uint256,bytes)";

// Link format: V1 links are /c#<id>.<key>, V2 links are /c#v2-<id>.<key>.
// Unmarked links are looked up on V1 first, then V2 (the key must match the envelope's link address either way).
export const V2_LINK_PREFIX = "v2-";

// Mezo protocol contracts (testnet, proxies).
export const MEZO = {
  troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
  borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
  borrowerOpsSignatures: "0xD757e3646AF370b15f32EB557F0F8380Df7D639e",
  priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
};
export const MEZO_ABI = {
  troveManager: [
    "function getTroveStatus(address) view returns (uint8)",
    "function getCurrentICR(address, uint256 price) view returns (uint256)",
    "function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)",
    "function checkRecoveryMode(uint256 price) view returns (bool)",
  ],
  borrowerOperations: ["function getBorrowingFee(uint256) view returns (uint256)"],
  borrowerOpsSignatures: ["function getNonce(address) view returns (uint256)"],
  priceFeed: ["function fetchPrice() view returns (uint256)"],
};
export const WITHDRAW_MUSD_DOMAIN = { name: "BorrowerOperationsSignatures", version: "1", chainId: 31611, verifyingContract: MEZO.borrowerOpsSignatures };
export const WITHDRAW_MUSD_TYPES = {
  WithdrawMUSD: [
    { name: "amount", type: "uint256" },
    { name: "borrower", type: "address" },
    { name: "recipient", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
export const MUSD_DECIMALS = 18;
export const EXPIRY_DAYS = 7;
export const MAX_NOTE_BYTES = 140;

// Storage keys stay fixed even if APPNAME changes, so a rename keeps saved links and wallets.
export const STORE = {
  sentLinks: "appname.sentLinks.v1",
  pendingKey: "appname.pendingKey.v1",
  wallet: "appname.wallet.v1",
  claims: "appname.claims.v1",
};

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

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function nonces(address owner) view returns (uint256)",
];

// Status enum in LinkEscrow
export const STATUS = { None: 0, Open: 1, Claimed: 2, Refunded: 3 };

// EIP-712 domain name stays "LinkEscrow" forever; renaming the product never breaks signatures.
export const CLAIM_TYPES = { Claim: [{ name: "id", type: "uint256" }, { name: "recipient", type: "address" }] };
export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const MUSD_PERMIT_DOMAIN = { name: "Mezo USD", version: "1", chainId: 31611, verifyingContract: MUSD };
