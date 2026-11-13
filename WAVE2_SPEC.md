# Envelope — Wave 2 spec (shared by all builders)

Goal: score 9–10 on every Mezo criterion. Deadline: Sun 15 Nov 2026, ~15:00 UTC. Mezo testnet, chain 31611.
All Wave 2 code is new work in this repo; Wave 1 code stays as the baseline (tag `wave1`).

## Mezo contracts (testnet, verified on chain)
- MUSD (EIP-2612 permit): `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`
- BorrowerOperations (proxy): `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5` — `withdrawMUSD`, `getBorrowingFee(uint256)`, `borrowingRate()`, `MCR()`=1.10e18, `CCR()`=1.50e18, `minNetDebt()`
- BorrowerOperationsSignatures (proxy): `0xD757e3646AF370b15f32EB557F0F8380Df7D639e`
  - EIP-712 domain: name `BorrowerOperationsSignatures`, version `1`, chainId 31611, verifyingContract = that address
  - `WithdrawMUSD(uint256 amount,address borrower,address recipient,uint256 nonce,uint256 deadline)`; nonce = `getNonce(borrower)`
  - `withdrawMUSDWithSignature(uint256 amount, address upperHint, address lowerHint, address borrower, address recipient, bytes signature, uint256 deadline)` — anyone may submit; MUSD goes to `recipient`; debt (+ borrowing fee) is added to the borrower's trove.
- TroveManager (proxy): `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0` — `getCurrentICR(address,uint256 price)`, `getEntireDebtAndColl(address)`, `getTroveStatus(address)` (1 = active), `checkRecoveryMode(uint256 price)`
- PriceFeed (proxy): `0x86bCF0841622a5dAC14A313a15f96A95421b9366` — `fetchPrice()` (BTC in MUSD, 1e18)
- Hints: passing `address(0)` for upper/lower hints is acceptable (more gas, still correct). Optional: HintHelpers.

## Contract: `contracts/EnvelopeV2.sol` (new; keep LinkEscrow.sol untouched)
Everything LinkEscrow does (create, createWithPermit, claimFor with EIP-712 link-key signature, refund after 7 days,
notes, idsOf, getDeposit, reentrancy guard, safe transfers, low-s checks), plus:

1. **Self-funding gas (fee).** `FEE_BPS = 50` (0.5%), immutable, hard cap 100 bps checked in constructor.
   On every create, `fee = amount * FEE_BPS / 10_000` stays in the contract's `gasFund`; the envelope holds `amount - fee`.
   `relayerReward` (immutable, e.g. 0.05 MUSD, ≤ 1 MUSD) is paid from `gasFund` to `msg.sender` on `claimFor` and on
   `createFor` when the fund can cover it (never touches envelope money). Surplus above a buffer can be withdrawn only
   to an immutable `treasury` via `sweepSurplus()` (anyone may call; it always pays `treasury`). No owner, no admin keys.
   Events: `FeeTaken(id, fee)`, `RelayerPaid(relayer, amount)`, `Swept(amount)`.
2. **Send from your Bitcoin, gasless: `createFor`.**
   `createFor(CreateForArgs a, bytes authSig, PermitArgs p)` where
   `CreateFor(address sender,address link,uint256 amount,bytes32 noteHash,uint256 nonce,uint256 deadline)` is an EIP-712
   message signed by `sender` (domain name `Envelope`, version `2`). It binds the link address, so a relayer can never
   swap in its own link key. Per-sender nonce in this contract. Then pull `amount` from `sender` with EIP-2612 `permit`
   (wrap permit in try/catch: if it was already used by a front-runner, continue when allowance is enough).
   The relayer flow is: (1) submit Mezo `withdrawMUSDWithSignature(..., borrower = sender, recipient = sender, ...)` so the
   borrowed MUSD lands in the sender's OWN wallet (no orphaned funds if anyone front-runs), then (2) `createFor`.
   The sender signs three typed messages and pays zero gas: Mezo WithdrawMUSD, MUSD Permit, Envelope CreateFor.
3. Views for the UI: `feeFor(amount)`, `quote(amount) returns (net, fee)`, `gasFund()`, `nonces(sender)`.

Tests (Foundry, no new installs; forge-std is vendored in lib/): unit tests for every path and revert, fuzz tests on
amounts/fees, an invariant that `token.balanceOf(this) == sum(open envelope amounts) + gasFund`, attack tests (wrong
signer, replayed authSig, swapped link, front-run permit, reentrancy), and a **fork test against Mezo testnet**
(`--fork-url https://rpc.test.mezo.org`) that opens a trove for a fresh key (vm.deal BTC, openTrove ≥ minNetDebt), signs a real
WithdrawMUSD for BorrowerOperationsSignatures, relays it, then createFor + claimFor end to end.

## Relayer and web
- `api/borrow-send.mjs`: input {sender, amount, link, noteHash, mezoSig, mezoDeadline, permit{v,r,s,deadline}, authSig, authDeadline, note}.
  Validate shape → read trove (status active), price, current ICR, borrowing fee → compute ICR after borrowing
  `amount` (+fee) → refuse below SAFETY_FLOOR = 1.20 or in recovery mode → simulate both calls (eth_call) → submit
  withdrawMUSDWithSignature, wait, submit createFor. Never holds user funds. Rate-limit like api/claim.mjs.
- `public/`: on Send, a **"Pay from my Bitcoin"** option when the connected wallet has an active trove: a loan-health
  meter (current ICR → after ICR, MCR 110% / CCR 150% / our floor 120%, colours safe/risky/blocked), borrowing fee,
  envelope fee (0.5%), "3 signatures, $0 gas". Existing "Pay with my MUSD" path stays (now with the 0.5% fee shown).
- Config: `ESCROW_ADDRESS_V2` added; keep V1 address for old links.
- Plain warm English, mobile-first, no secrets printed, ethers 6.13.4 as already used.

## Out of scope for the builders
Deploying, verifying, the deck, README, video and form (the lead does these).
