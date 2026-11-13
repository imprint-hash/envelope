# EnvelopeV2 threat model

Contract: `contracts/EnvelopeV2.sol`. Token: MUSD on Mezo (`0x1189…c503`), EIP-2612 permit.
No owner, no admin keys, no upgrade path, no external libraries.

## Assets

| Asset | Where it lives | Who may move it |
|---|---|---|
| Envelope money | `deposits[id].amount` (Open) | the link-key holder (to any recipient, before expiry) or, after 7 days, back to `deposits[id].sender` |
| Gas fund | `gasFund` | relayers, via a capped reward on `createFor` / `claimFor`; `sweepSurplus()` above `sweepBuffer`, always to `treasury` |
| Sender's wallet MUSD | sender's wallet | only via a sender-signed permit/approval plus (for `createFor`) a sender-signed `CreateFor` |
| Borrower's trove | Mezo TroveManager | Mezo's own `withdrawMUSDWithSignature` (sender-signed). EnvelopeV2 never touches troves. |
| Envelope money on its way through Mezo Pools | inside one `claimWithOption` tx only | the link-key holder, via a signed `ClaimWithOption(id, recipient, mode, minOut, deadline)`; the router gets an exact, single-use approval |

Accounting rule (checked by an invariant test across random create / createFor / claim / refund / sweep / warp sequences):
`MUSD.balanceOf(envelope) == sum(open envelope amounts) + gasFund`.

## Actors and trust

- **Sender**: signs. Trusted only for their own money.
- **Link holder**: anyone with the link key in the URL. Trusted by design: the link *is* the bearer instrument.
- **Relayer** (our API, or anyone): untrusted. Pays gas, earns a capped reward. Can only submit what was signed.
- **Treasury**: fixed at deploy. Receives sweeps; has no power over the contract.
- **MUSD token**: trusted to be a standard ERC-20 with permit (no fee-on-transfer, no callbacks).
- **Mezo protocol** (BorrowerOperationsSignatures, TroveManager, price feed): trusted for the borrow step; outside this contract.
- **Mezo Pools** (Router `0x9a1f…E7E9`, PoolFactory `0x4947…3Ce1A`, MUSD/mUSDC stable pool `0x525F…Dc3e`, MUSD/BTC pool `0xd16A…6AA9`, mUSDC `0xe1a2…3A59`, BTC `0x7b7C…0000`): immutable constructor args. Trusted to execute swaps/adds as their verified code says, **not** trusted with any money beyond the exact approval for the envelope being claimed. The constructor checks both pools against `router.poolFor(...)`. All-zero config = options off (`PoolsDisabled`).

## Fees

The sender pays `fee = ceil(amount * FEE_BPS / 10_000)` **on top**; the recipient gets exactly `amount`.
`FEE_BPS` is immutable (deployed at 50 = 0.5%, constructor rejects > 100). `relayerReward` is immutable (0.05 MUSD, constructor rejects > 1 MUSD).
A refund returns `amount`; the fee is kept (it already paid for gas).

## Attacks and mitigations

| # | Attack | Mitigation | Test |
|---|---|---|---|
| 1 | Relayer redirects a claim to itself | Claim signature binds `id` and `recipient` | `test_RevertWhen_Claim_RelayerRedirects` |
| 2 | Relayer swaps in its own link key on `createFor` | `CreateFor` signature binds `link` (and amount, note hash, deadline, nonce) | `test_RevertWhen_CreateFor_RelayerSwapsLink`, `…ChangesAmount`, `…ChangesNote`, `…ExtendsDeadline` |
| 3 | Wrong signer / forged `createFor` | `ecrecover(digest) == a.sender`, zero sender rejected | `test_RevertWhen_CreateFor_WrongSigner`, `testFuzz_CreateForOnlyBySender` |
| 4 | Replay a `CreateFor` authSig | per-sender `nonces`, incremented before any external call | `test_RevertWhen_CreateFor_ReplayedAuthSig` |
| 5 | Replay across contracts / chains / V1 | EIP-712 domain `Envelope` v`2`, chainId, verifyingContract | `…SigFromOtherContract`, `…SigForOtherChain`, `test_ClaimSig_FromV1DomainDoesNotWorkOnV2` |
| 6 | Stale signature | `deadline` checked (`block.timestamp > deadline` reverts) | `test_RevertWhen_CreateFor_Expired`, `test_CreateFor_DeadlineInclusive` |
| 7 | Front-run the permit to grief `createFor` | permit in `try/catch`; on failure continue if allowance ≥ amount + fee, else `PermitFailed` | `test_CreateFor_FrontRunPermitThenCreateForStillWorks` |
| 8 | Front-run the whole `createFor` | Produces the exact envelope the sender signed; the copier only takes the relayer reward | `test_CreateFor_FrontRunWholeCallOnlyMovesTheReward` |
| 9 | Front-run Mezo `withdrawMUSDWithSignature` | Relayer always uses `recipient = sender`, so borrowed MUSD lands in the sender's own wallet whoever submits it | fork test (balance asserts) |
| 10 | Signature malleability | low-s enforced, v ∈ {27,28} (0/1 accepted), 65-byte length, ecrecover ≠ 0 | `…MalleableHighS`, `…BadSigShapes` |
| 11 | Reentrancy via token callbacks | single `nonReentrant` lock on every state-changing function; checks-effects-interactions (all state, including `gasFund` and rewards, is written before any transfer) | `test_Reentrancy_*` (claim-in-claim, sweep-in-claim, refund-in-createFor, createFor-in-payout) |
| 12 | Relayer reward drains envelope money | Rewards are booked only out of `gasFund` and capped at `gasFund` | `test_RelayerReward_NeverExceedsGasFund`, invariant |
| 13 | Self-relay farming (create tiny envelopes, claim them yourself to milk rewards) | Each envelope pays at most its own fee in rewards: `fee/2` on `createFor`, `fee/2` on `claimFor` | `test_RelayerReward_SelfRelayCannotDrainFund`, `invariant_EachEnvelopePaysOutAtMostItsFee`, `testFuzz_CreateForClaim_ExactAmountsAndRewardsBounded` |
| 14 | Sweep steals envelope money / goes elsewhere | `sweepSurplus` only moves `gasFund - sweepBuffer`, only to immutable `treasury` | `test_Sweep_*`, `invariant_TreasuryOnlyGetsSweeps` |
| 15 | Fee-on-transfer or short-paying token breaks accounting | balance-delta check on every pull: `WrongAmountReceived` | `test_RevertWhen_Create_FeeOnTransferToken` |
| 16 | Token returning `false` | `_safeTransfer*` checks return data | `test_RevertWhen_Create_TokenReturnsFalse` |
| 17 | Overflow / truncation into `uint96` | `amount` and `amount + fee` must fit `uint96` | `test_RevertWhen_Create_AmountTooLarge`, `test_Create_LargestAmountThatFits` |
| 18 | Admin rug / parameter change | no owner, all parameters immutable | — |
| 19 | Relayer changes the option, recipient or slippage | `ClaimWithOption` binds `id, recipient, mode, minOut, deadline` (EIP-712, link key). A plain `Claim` signature is not accepted for options and vice versa | `test_RevertWhen_Option_RelayerChangesAnything`, `…PlainClaimSigNotAccepted`, `testFuzz_Option_OnlyLinkKey` |
| 20 | Slippage / sandwich (someone moves the pool just before the claim) | The page quotes live and signs `minOut` = quote − 1%. EARN checks the recipient's LP balance delta ≥ `minOut`; GAS_TIP passes `minOut` to the router and re-checks the recipient's BTC delta. Short `deadline` (page: 10 min; API refuses > 1 h). On a miss the whole tx reverts: the envelope stays **Open** and a plain claim still works. Worst case a sandwicher takes ≤ 1% of the swapped part | `test_RevertWhen_Earn_SlippageThenPlainClaimWorks`, `…GasTip_SlippageThenPlainClaimWorks`, fork `test_Fork_Earn_SlippageRevertsAndPlainClaimStillWorks` |
| 21 | Pool manipulation of the EARN split | The swap share comes from `router.quoteStableLiquidityRatio` at execution time; if a manipulated ratio wastes value, LP minted falls and the `minOut` check reverts. Unused MUSD/mUSDC always goes to the recipient, never stays in the contract. `swapIn` must be strictly between 0 and the amount (`AmountTooSmall`) | `test_Earn_PartnerDustGoesToRecipient`, `test_RevertWhen_Earn_Ratio*`, `testFuzz_Earn_EnvelopeFullyAccounted` |
| 22 | Router takes more than this envelope (other envelopes / gas fund) | Approvals are exact and reset to 0 after every call. After the pools step the contract checks its MUSD balance is still ≥ everything that isn't this envelope (`RouterMisbehaved`), and pays only the remainder to the recipient | `test_Option_RouterTakesLess_AllowanceStillReset`, `invariant_NoRouterAllowanceLeft`, `invariant_BalanceEqualsOpenEnvelopesPlusGasFund` (handler includes `claimWithOption`) |
| 23 | Reentrancy through the router or a pool token | Same `nonReentrant` lock; status = Claimed and the relayer reward booked before any external call | `test_Reentrancy_RouterCallsBackIntoClaim`, `…IntoSweep` |
| 24 | Pools paused / broken / empty | The call reverts; the envelope stays Open; the page falls back to "Keep it as dollars" (quotes failing disable the two pool options) | `test_RevertWhen_Option_PoolsDown_MoneyStaysInEnvelope` |
| 25 | Recipient set to a pools contract (funds stuck) | `recipient` may not be the router, partner, BTC, either pool, MUSD, or this contract | `test_RevertWhen_Option_RecipientIsPoolsContract` |
| 26 | Relayer-reward farming via options | Same reward rule as `claimFor` (≤ fee/2 from `gasFund`) | `test_Option_RelayerRewardSameAsPlainClaim`, invariant |

## Known limitations

- **The link is a bearer secret.** Anyone who sees the link before the recipient can claim. Same as V1.
- **Sender wallets must be EOAs.** `createFor` uses `ecrecover`; EIP-1271 smart wallets are not supported (they can still use `create`).
- **Relayer reward can be front-run.** A copier of a pending `createFor`/`claimFor` gets the reward instead of our relayer. The user is never harmed.
- **Fees on sweepable envelopes.** After a sweep, later claims are rewarded only while `gasFund` (≥ the buffer of 100 rewards) lasts; claims always succeed, the relayer may just earn less.
- **Donations are stuck.** MUSD sent to the contract directly is not counted in `gasFund` and cannot be swept.
- **Loan safety is off-chain.** The ICR floor (120%) and recovery-mode refusal are enforced by the relayer API, not by this contract. A sender could sign a `WithdrawMUSD` that a third party submits; Mezo's own MCR/CCR checks still apply.
- **EARN is a liquidity position, not a fixed-value deposit.** Its value moves with the pool (impermanent loss is small in a stable pool but not zero; testnet mUSDC trades below $1 in the MUSD/mUSDC pool today). The page shows "worth about $X today" from live quotes, and the recipient can withdraw any time from Mezo Pools.
- **mUSDT is not used.** The MUSD/mUSDT stable pool (`0x2741…494e`) had zero reserves on testnet on 13 Nov, so EARN pairs MUSD with mUSDC.
- **The split is not exactly half.** The MUSD/mUSDC pool is unbalanced on testnet (≈ 2.8 MUSD per mUSDC in reserves), so swapping half would leave most of the swapped mUSDC unused. The contract swaps the router's own `quoteStableLiquidityRatio` share instead (≈ 31% today); on the fork, unused dust was 0 MUSD and 0.002327 mUSDC for a $50 envelope.
- **Pools fork test note.** Mezo's BTC token (`0x7b7c…0000`) is a chain precompile whose balance is the native BTC balance. Forge can't run it, so `EnvelopeV2Pools.fork.t.sol` puts a stand-in at that address with exactly that behaviour (`balanceOf(a) == a.balance`, transfers move native BTC); the MUSD/BTC pool's reserves are its real forked balance. The router, factory, both pools, MUSD and mUSDC run their real testnet code. The sender's MUSD there comes from `deal` (the borrow path is covered by `EnvelopeV2.fork.t.sol`).
- **Fork test note.** Mezo's BTC price oracle is a chain precompile (`0x7b7c…0015`) that Forge's EVM cannot execute. The fork test fetches the oracle's real `latestRoundData()`/`decimals()` answer from the Mezo RPC at the fork block (`vm.rpc`) and serves that exact answer locally. Every other call, and every signature (Mezo WithdrawMUSD, MUSD permit, Envelope CreateFor, Claim), is real.
