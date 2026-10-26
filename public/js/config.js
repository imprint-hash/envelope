// The one place to rename the product.
export const APPNAME = "APPNAME";

export const CHAIN = {
  id: 31611,
  hex: "0x7b7b",
  name: "Mezo Testnet",
  rpc: "https://rpc.test.mezo.org",
  explorer: "https://explorer.test.mezo.org",
};

// TODO(after deploy): paste the deployed LinkEscrow address here (public, safe to commit).
export const ESCROW_ADDRESS = "0x2330b264BF90E94F4926fD819c1281F799005c01";

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
