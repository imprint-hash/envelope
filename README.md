# Envelope

**Send dollars to anyone's WhatsApp, even if they have never used crypto.**

Your cousin in Houston sends $50 in MUSD. Your mum gets a WhatsApp message with a link, taps it, and the $50 is hers. She does not install an app, sign up, or pay a fee. If nobody claims it within 7 days, the money goes back to the sender.

- **Live (Mezo testnet):** https://envelope.vercel.app
- **Track:** Access & Distribution, Mezo Buildathon Wave 1
- **Escrow contract:** [`0x2330b264BF90E94F4926fD819c1281F799005c01`](https://explorer.test.mezo.org/address/0x2330b264BF90E94F4926fD819c1281F799005c01) on Mezo testnet (chain 31611)
- **Token:** testnet MUSD [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503)

## Proof it works (Mezo testnet)

A real envelope, sent from MetaMask on a laptop and claimed on a phone from WhatsApp, with the fee paid by the relayer:

- Envelope #1 created (100 MUSD, permit + create in one transaction): [`0xf6f3b976…`](https://explorer.test.mezo.org/tx/0xf6f3b97655d491f7075631c9317bf2cb457932c4bb926c72cdc5bcb4f59eff5c)
- Envelope #1 claimed by a brand-new phone wallet, gas paid by the relayer: [`0x120b9ca5…`](https://explorer.test.mezo.org/tx/0x120b9ca57a235ab7432f89164956139f0e675f6406aa2e7d7e45d98a48addcb3)

## Why

Most people who could use a Bitcoin-backed dollar will first meet it as a payment from someone else. Today that only works if they already have a wallet, know what network they are on, and hold BTC for fees. Envelope removes all three: the person receiving needs nothing but a phone and a link. Every claimed envelope is a new MUSD holder on Mezo.

Existing MUSD payment apps (usernames, requests, tabs) assume both people already have wallets. Envelope is for the person who has nothing yet.

## How it works

```
Sender (MetaMask)                     Envelope contract                 Recipient (phone)
  │ 1. browser makes a one-time         │                                  │
  │    "link key"; only its ADDRESS     │                                  │
  │    goes on-chain                    │                                  │
  │ 2. permit + createWithPermit ─────► │ holds the MUSD                   │
  │ 3. link = /c#<id>.<link key>        │                                  │
  │    shared on WhatsApp ─────────────────────────────────────────────►   │
  │                                     │      4. page reads the envelope  │
  │                                     │         makes a wallet in the    │
  │                                     │         browser (or MetaMask)    │
  │                                     │      5. link key signs           │
  │                                     │         Claim(id, recipient)     │
  │                                     │ ◄── 6. relayer calls claimFor,   │
  │                                     │        pays the gas              │
  │                                     │ ── MUSD ───────────────────────► │
  │ 7. not claimed in 7 days: refund(id) sends it back to the sender       │
```

- The link key lives only in the URL **fragment** (`#...`), which browsers never send to a server. The page removes it from the address bar after a successful claim.
- The sender pays once, in one transaction, using MUSD's EIP-2612 `permit` (with an `approve` fallback).
- The recipient pays nothing: our relayer (`api/claim.mjs`) submits the claim and pays the BTC gas. It never holds user money.

## Security model

**Contract** (`contracts/LinkEscrow.sol`, no external libraries):
- The claim signature is EIP-712, bound to this contract, chain id, envelope id and recipient. A relayer or front-runner cannot redirect the money, and a signature cannot be replayed on another envelope, chain or contract.
- Low-s and `v` checks reject malleable signatures; a zero recovered address is rejected.
- Each envelope moves once: Open → Claimed or Open → Refunded. No claim at or after expiry, no refund before it. There is no moment when both are possible.
- Reentrancy guard on every state change, checks-effects-interactions, and checked token transfers.
- Refunds can be triggered by anyone, but always pay the original sender.

**Relayer** (`api/claim.mjs`):
- Checks input shape, then on-chain state, then the signature, then simulates the call before spending any gas, so junk requests cost us nothing.
- Per-IP rate limit, an in-flight lock per envelope, a gas limit cap, and a 0.01 MUSD minimum so tiny envelopes cannot drain the fee wallet.
- Never logs request bodies or keys.

**Known limit:** anyone who has the link can claim it, like cash in an envelope. The send page says so before you share it.

## Tests

```bash
forge test                                                   # 58 tests
forge test --fork-url https://rpc.test.mezo.org --match-contract Fork   # real MUSD permit
```

- `test/LinkEscrow.t.sol`: 35 tests covering create, permit, claim, refund, every revert, events, fuzzing, and a digest computed with ethers to prove the browser and contract agree.
- `test/Attack.t.sol`: 23 attack tests written by a separate tester: relayer redirect, cross-envelope, cross-chain and cross-contract replay, malleable signatures, expiry edges, reentrancy, permit front-running, solvency fuzzing.
- `test/LinkEscrow.fork.t.sol`: runs MUSD's real `permit` on a Mezo testnet fork.

## Run it yourself

1. Get test BTC from https://faucet.test.mezo.org and borrow test MUSD at https://testnet.mezo.org.
2. `cp .env.example .env` and set `RELAYER_PRIVATE_KEY` (a test-only key with a little test BTC) and `RPC_URL=https://rpc.test.mezo.org`.
3. Deploy: `set -a; . ./.env; set +a; forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast`
4. Put the address in `ESCROW_ADDRESS` (`.env`) and in `public/js/config.js`.
5. `npm install`, then deploy to Vercel with `RELAYER_PRIVATE_KEY`, `ESCROW_ADDRESS` and `RPC_URL` set as environment variables.

## Wave 2

- **Send from your Bitcoin:** borrow MUSD against BTC on Mezo and fund the envelope in the same flow, so the sender never needs to hold dollars first.
- **Keep it saving:** after claiming, the recipient can move the money into Mezo savings with one tap.
- A gentler wallet backup for first-time users, and claiming to a phone number.
