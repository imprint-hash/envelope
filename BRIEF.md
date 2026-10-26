# Brief: MUSD claim links (Mezo Buildathon, Wave 1)

**Deadline: today, Mon 26 Oct 2026, 16:00 WAT (15:00 UTC). Hard stop. Code freeze 15:00 WAT.**
Product name: TBD by the user. Use the placeholder `APPNAME` in UI copy and keep it in one constant so it is a one-line rename.

## The product in one line
Send dollars (MUSD) to anyone as a link they open on WhatsApp. They claim it with no wallet, no sign-up, no fee. Unclaimed money goes back to the sender after 7 days.

## Flow
1. Sender opens the site, connects a browser wallet (MetaMask) on Mezo testnet, types an amount (e.g. 50 MUSD), optional note ("For mum's groceries"), taps Send.
   - Page generates a random one-time "link key" (a fresh secp256k1 keypair) in the browser. Only its ADDRESS goes on-chain.
   - Sender approves MUSD and calls `create(linkAddress, amount)` on the escrow contract (or uses permit if MUSD supports EIP-2612; check on-chain).
   - Page shows the link: `https://<site>/c#<id>.<linkPrivateKey>` (the secret lives in the URL FRAGMENT, never sent to any server), plus a "Share on WhatsApp" button (`https://wa.me/?text=...`).
2. Recipient taps the link. The claim page:
   - reads the deposit (amount, note, expiry, claimed?) from chain,
   - creates a wallet for the recipient in the browser if they have none (stored in localStorage; show "save your recovery phrase" later, not blocking), or lets them use MetaMask,
   - signs `claim(id, recipient)` authorisation with the LINK key (EIP-712 or eth_sign over (contract, chainId, id, recipient)),
   - POSTs {id, recipient, signature} to our relayer API; the relayer submits `claimFor(id, recipient, sig)` and pays gas from its own testnet wallet. The recipient pays nothing.
   - Shows "$50 is yours" with the tx link on the explorer and the wallet balance.
3. After 7 days unclaimed, sender (or anyone) calls `refund(id)` and the MUSD goes back to the sender. Sender's page lists their links with status: waiting / claimed / refunded / refundable.

## Security must-haves (the tester will try to break these)
- Signature binds contract address + chainId + id + recipient, so a relayer or a front-runner cannot redirect funds, and a sig cannot be replayed on another deposit/chain/contract.
- Each deposit claims once. No claim after refund, no refund after claim, no refund before expiry.
- Relayer never holds user funds; it only pays gas. Relayer rate-limits and validates before sending (deposit exists, unclaimed, sig recovers to linkAddress) so it can't be drained by junk txs.
- Link key never leaves the browser except inside the fragment; never logged; never sent to the server.
- Use SafeERC20 / check return values. Reentrancy guard on state-changing functions. Checks-effects-interactions.
- Zero amount rejected; linkAddress != 0.

## Chain facts (verified)
- Mezo testnet: chainId 31611, RPC https://rpc.test.mezo.org, explorer https://explorer.test.mezo.org, gas token BTC (18 decimals).
- Testnet MUSD: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 (symbol() returns "MUSD", verified via eth_call).
- Faucet (captcha, user does it): https://faucet.test.mezo.org ; test MUSD by borrowing on https://testnet.mezo.org .

## Stack and constraints
- Contracts: Foundry (forge is installed at ~/.foundry/bin). Solidity ^0.8.24. Keep the contract small and readable. OpenZeppelin via `forge install` is allowed ONLY if the user approves installs; prefer writing a minimal ECDSA recover + SafeERC20-style call inline to avoid installs. Ask the manager (main session) before installing anything.
- Web: plain HTML/CSS/JS (no framework, no build step). For chain calls use ethers v6 from cdnjs (`https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js`) or esm.sh-free alternative; pin the exact version.
- Relayer: one Vercel serverless function `api/claim.mjs` (Node 22, ESM). It needs ethers on the server: plan for either a tiny raw-JSON-RPC signer or adding `ethers` as a dependency (needs user approval; flag it).
- Hosting: Vercel via GitHub (repo under imprint-hash). Env vars: RELAYER_PRIVATE_KEY, ESCROW_ADDRESS, RPC_URL. Keys only in `.env` (gitignored), never committed, never printed.
- No AI attribution in commits/PRs. Plain, warm English in UI. No Pidgin.
- Mobile first: the claim page is opened from WhatsApp on a phone.

## Judging (Mezo engineers): working demo quality, code, testnet deployment, protocol integration.
Track: Access & Distribution ("Telegram or WhatsApp tools", "simpler wallet interfaces").
Wave 2 plan (README only, do not build now): sender pays from BTC by borrowing MUSD on Mezo first; recipient "keep it saving" into Mezo savings.

## Out of scope today
Phone-number verification, naira off-ramp, mainnet, recovery-phrase backup UX beyond a simple "show my key" button.
