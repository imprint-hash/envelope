# Wave 2 on-chain proof (Mezo testnet, chain 31611)

| What | Tx |
|---|---|
| EnvelopeV2 deployed + verified | [0x731b43e5…149c](https://explorer.test.mezo.org/tx/0x731b43e5b7bfb45f940bd0970fd31bb565f5e6ed8386bc57c5b4b30936fc149c) · contract [0x06b4…Fa26](https://explorer.test.mezo.org/address/0x06b4B5A507FDb61d6d082007ab48aD76B26dFa26) |
| Envelope sent with "Pay with my MUSD" (permit, 0.5% fee on top → gas fund) | [0xccff6b05…246d](https://explorer.test.mezo.org/tx/0xccff6b05b52011c02268086a7e1affe806c2143018a6ab34a804bdf2d5b8246d) |
| Claimed gaslessly; relayer paid back from the gas fund | [0xe9eb48df…a093](https://explorer.test.mezo.org/tx/0xe9eb48df7d509afc4f4d87a56a856896898dfff2bf7e2867ad328c62610ca093) |
| Mezo loan: borrowed 20.1 MUSD against BTC via `withdrawMUSDWithSignature` (relayer paid gas, sender signed) | [0x1dcd6c48…905f](https://explorer.test.mezo.org/tx/0x1dcd6c488bde2e988effd742ff0137a6ee91367dc883cf6e39493dbd99d8905f) |
| "Pay from my Bitcoin": $20 envelope via `createFor` (permit + CreateFor signature, fee to gas fund, relayer paid back) | [0x0103df33…4fa6](https://explorer.test.mezo.org/tx/0x0103df33cf59763c010dff9b09b6833d5c6622224a6240b54a3be08c45724fa6) |
| "Keep it earning": claimed straight into a Mezo Pools MUSD/mUSDC LP position via `claimWithOption` (mode EARN) | [0xccc82664…b7fb](https://explorer.test.mezo.org/tx/0xccc8266439135fc8bee0046bb1d91a12c5063934f17b48c5e10051100a1eb7fb) |
