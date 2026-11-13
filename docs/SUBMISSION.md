# Envelope: Mezo Buildathon Wave 2 submission

**Project:** Envelope
**One line:** Send dollars to anyone's WhatsApp, even if they've never used crypto. Now funded straight from your Bitcoin on Mezo.
**Track:** Access & Distribution
**Status:** Live on Mezo testnet (chain 31611). Contracts verified.

## Links
- Live app: https://envelope.vercel.app
- Live stats (read from the contracts): https://envelope.vercel.app/stats
- Pitch deck: https://envelope.vercel.app/deck/ · PDF: https://github.com/imprint-hash/envelope/blob/master/docs/Envelope-deck.pdf
- Code: https://github.com/imprint-hash/envelope
- Demo video: [YOUTUBE LINK]
- EnvelopeV2 (verified): https://explorer.test.mezo.org/address/0x06b4B5A507FDb61d6d082007ab48aD76B26dFa26
- LinkEscrow, Wave 1 (verified): https://explorer.test.mezo.org/address/0x2330b264BF90E94F4926fD819c1281F799005c01

## What we built this wave (answers to the Wave 1 feedback)
Wave 1 feedback said our integration was plain ERC-20/permit, the contract wasn't verified, there was no deck, and asked how relayer gas gets paid. Wave 2 answers each one:

1. **Send from your Bitcoin (deep Mezo integration).** A sender with a Mezo loan borrows MUSD against their BTC and sends it as an envelope in one flow: 3 signatures, $0 gas. We use Mezo's own `BorrowerOperationsSignatures.withdrawMUSDWithSignature` (the relayer submits, the MUSD lands in the sender's own wallet), then `createFor` locks it into a link. We pass SortedTroves insert hints, which cuts the borrow from ~6.5M to ~400k gas.
2. **Loan-health guard.** Before any borrow we read TroveManager (`getCurrentICR`, `getEntireDebtAndColl`, `checkRecoveryMode`), PriceFeed (`fetchPrice`) and BorrowerOperations (`getBorrowingFee`, `MCR`, `CCR`). We show the ratio before and after, and block any send that would go below 120% or happen in recovery mode.
3. **Claim into Mezo Pools.** The recipient chooses how to keep the money: plain MUSD, "Keep it earning" (straight into a MUSD/mUSDC LP position via the Mezo Pools router), or "A little BTC for fees" (a small MUSD→BTC swap). Both are slippage-protected and gasless.
4. **Gas that pays for itself (business model).** The sender pays 0.5% on top, so the recipient gets exactly what was promised. The fee goes into an on-chain gas fund that pays the relayer back on every relayed transaction. Surplus can only go to a fixed treasury. There is no owner and no admin key.
5. **Verified and tested.** Both contracts are verified. 220+ passing tests: unit, fuzz, an invariant, attack tests, and fork tests against Mezo's live contracts (a real trove, a real WithdrawMUSD signature, real Pools). Plus CI on every push, a threat model, and an independent pressure test with fixes shipped.
6. **Materials.** An 11-slide deck, a live stats page, a "Judges, start here" README, and a demo video.

## Proof on-chain (Mezo testnet)
- Mezo borrow via `withdrawMUSDWithSignature`: https://explorer.test.mezo.org/tx/0x1dcd6c488bde2e988effd742ff0137a6ee91367dc883cf6e39493dbd99d8905f
- "Pay from my Bitcoin" envelope via `createFor`: https://explorer.test.mezo.org/tx/0x0103df33cf59763c010dff9b09b6833d5c6622224a6240b54a3be08c45724fa6
- Claim into a Mezo Pools position ("Keep it earning"): https://explorer.test.mezo.org/tx/0xccc8266439135fc8bee0046bb1d91a12c5063934f17b48c5e10051100a1eb7fb
- Envelope with the 0.5% fee into the gas fund: https://explorer.test.mezo.org/tx/0xccff6b05b52011c02268086a7e1affe806c2143018a6ab34a804bdf2d5b8246d
- Gasless claim with the relayer paid back from the gas fund: https://explorer.test.mezo.org/tx/0xe9eb48df7d509afc4f4d87a56a856896898dfff2bf7e2867ad328c62610ca093

## Business model
- 0.5% per envelope, paid by the sender on top. The average cost of sending money to Sub-Saharan Africa is 8.46% (World Bank RPW, Q3 2025).
- On Mezo a relayed transaction costs a tiny fraction of a cent in BTC gas. The fee covers it and the rest is revenue, swept only to a fixed treasury. Live: https://envelope.vercel.app/stats
- Next: an off-ramp revenue share from cash-out partners (naira, cedis, shillings).

## Why it matters for Mezo
Most products on Mezo serve people who already hold Bitcoin. Envelope reaches the people who don't have crypto yet. Every claimed envelope is a brand-new MUSD holder, reached through WhatsApp. Every "Pay from my Bitcoin" envelope adds BTC-backed MUSD supply, and every "Keep it earning" claim adds liquidity to Mezo Pools.

## Known limits (honest)
- **Testnet only this wave.** Mainnet is next; the contract is built for it (fixed fee, no admin keys).
- **MetaMask warning.** MetaMask's scanner currently flags every free `*.vercel.app` address as a "drainer", including made-up addresses that don't exist. Own-domain sites pass. A custom domain removes the warning.
- Contract-level notes from the pressure test that need a redeploy are listed in `docs/THREAT_MODEL.md`.

## Next
Mainnet with real MUSD (claim into the MUSD Savings Vault), cash-out partners, a custom domain, group envelopes (weddings, birthdays), and monthly family support borrowed against BTC you keep.

## Team
imprint (solo builder): product, contracts, frontend, relayer, design.
