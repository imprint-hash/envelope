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

Accounting rule (checked by an invariant test across random create / createFor / claim / refund / sweep / warp sequences):
`MUSD.balanceOf(envelope) == sum(open envelope amounts) + gasFund`.

## Actors and trust

- **Sender**: signs. Trusted only for their own money.
- **Link holder**: anyone with the link key in the URL. Trusted by design: the link *is* the bearer instrument.
- **Relayer** (our API, or anyone): untrusted. Pays gas, earns a capped reward. Can only submit what was signed.
- **Treasury**: fixed at deploy. Receives sweeps; has no power over the contract.
- **MUSD token**: trusted to be a standard ERC-20 with permit (no fee-on-transfer, no callbacks).
- **Mezo protocol** (BorrowerOperationsSignatures, TroveManager, price feed): trusted for the borrow step; outside this contract.

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

## Known limitations

- **The link is a bearer secret.** Anyone who sees the link before the recipient can claim. Same as V1.
- **Sender wallets must be EOAs.** `createFor` uses `ecrecover`; EIP-1271 smart wallets are not supported (they can still use `create`).
- **Relayer reward can be front-run.** A copier of a pending `createFor`/`claimFor` gets the reward instead of our relayer. The user is never harmed.
- **Fees on sweepable envelopes.** After a sweep, later claims are rewarded only while `gasFund` (≥ the buffer of 100 rewards) lasts; claims always succeed, the relayer may just earn less.
- **Donations are stuck.** MUSD sent to the contract directly is not counted in `gasFund` and cannot be swept.
- **Loan safety is off-chain.** The ICR floor (120%) and recovery-mode refusal are enforced by the relayer API, not by this contract. A sender could sign a `WithdrawMUSD` that a third party submits; Mezo's own MCR/CCR checks still apply.
- **Fork test note.** Mezo's BTC price oracle is a chain precompile (`0x7b7c…0015`) that Forge's EVM cannot execute. The fork test fetches the oracle's real `latestRoundData()`/`decimals()` answer from the Mezo RPC at the fork block (`vm.rpc`) and serves that exact answer locally. Every other call, and every signature (Mezo WithdrawMUSD, MUSD permit, Envelope CreateFor, Claim), is real.
