# Envelope — Wave 2 pitch deck (content draft)

1. **Envelope** — Send dollars to anyone's WhatsApp. Even if they've never used crypto.
   Built on Mezo · MUSD · Bitcoin-backed. Live on Mezo testnet.

2. **The problem**
   - Sending $200 to Sub-Saharan Africa costs **8.46%** on average — the most expensive region in the world (World Bank RPW, Q3 2025). Global average 6.36%. UN SDG target: under 3% by 2030.
   - Crypto could fix this, but the person receiving needs a wallet, the right network, and BTC for gas. Most of the people we want to reach have none of these.

3. **The solution**
   - Sender locks MUSD in Envelope. Recipient gets a WhatsApp link. One tap, the dollars are theirs.
   - No app, no sign-up, no gas for the recipient. Unclaimed after 7 days → back to the sender automatically.

4. **New in Wave 2: Send from your Bitcoin**
   - Hold BTC on Mezo? Borrow MUSD against it and send it as an envelope — **3 signatures, $0 gas**.
   - Uses Mezo's own BorrowerOperationsSignatures (`withdrawMUSDWithSignature`) — the relayer submits, Mezo lends against your BTC, Envelope locks it.
   - **Loan-health guard**: live BTC price, your collateral ratio before → after, Mezo's 110% liquidation line and 150% safety line, recovery mode. We block sends that would push you below 120%.

5. **Deep Mezo integration (what we call)**
   - MUSD: EIP-2612 permit, transfers
   - BorrowerOperationsSignatures: withdrawMUSDWithSignature, getNonce
   - BorrowerOperations: getBorrowingFee, borrowingRate, MCR, CCR
   - TroveManager: getTroveStatus, getEntireDebtAndColl, getCurrentICR, checkRecoveryMode
   - PriceFeed: fetchPrice
   - Gas in BTC on Mezo; contracts verified on the Mezo explorer.

6. **Business model: gas that pays for itself**
   - **0.5% fee, paid by the sender on top** — the recipient always gets exactly what was promised.
   - The fee lands in an on-chain gas fund; the relayer is paid back automatically per transaction. No outside sponsor.
   - On Mezo a claim costs a tiny fraction of a cent in BTC gas — the rest is revenue.
   - vs 8.46% average remittance cost to Sub-Saharan Africa.
   - Next: off-ramp revenue share (referral share from partners who turn MUSD into naira, cedis, shillings).

7. **Growth loop**
   - Every claimed envelope = a new MUSD holder on Mezo, reached through WhatsApp (2bn+ users).
   - "Send it forward": after claiming, one tap to send your own envelope.
   - Every borrow-to-send adds MUSD supply backed by BTC.

8. **Proof (on-chain)** — [fill with real tx links after deploy: V2 contract verified, borrow-and-send tx, claim tx, refund tx, friends' claims]

9. **Built safely**
   - EIP-712 signatures bound to contract, chain, envelope and recipient; link key never leaves the URL fragment.
   - No admin keys; fee capped in code; surplus can only go to the fixed treasury.
   - [N] tests incl. fuzz, invariant and a fork test against Mezo's real contracts; threat model in docs/.

10. **Roadmap**
   - Mainnet with real MUSD · cash-out partners (off-ramp revenue share) · phone-number claims · group envelopes (owambe/weddings) · recurring family support.

11. **Team** — imprint.

Sources: World Bank Remittance Prices Worldwide, Issue 54 (Q3 2025).
