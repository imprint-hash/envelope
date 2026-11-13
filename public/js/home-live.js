// Home page: one live line from the contracts (no server). Three cheap eth_calls; falls back to a plain label.
import { CHAIN, ESCROW_ADDRESS, ESCROW_ADDRESS_V2 } from "./config.js";

const NEXT_ID = "0x61b8ce8c"; // nextId()
const GAS_FUND = "0xc714999e"; // gasFund()

async function call(to, data) {
  const r = await fetch(CHAIN.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await r.json();
  if (!j.result) throw new Error("no result");
  return BigInt(j.result);
}

async function run() {
  const el = document.getElementById("live-text");
  if (!el) return;
  try {
    const hasV2 = ESCROW_ADDRESS_V2 && BigInt(ESCROW_ADDRESS_V2) !== 0n;
    const [n1, n2, fund] = await Promise.all([
      call(ESCROW_ADDRESS, NEXT_ID),
      hasV2 ? call(ESCROW_ADDRESS_V2, NEXT_ID) : Promise.resolve(1n),
      hasV2 ? call(ESCROW_ADDRESS_V2, GAS_FUND) : Promise.resolve(0n),
    ]);
    const sent = Number(n1 - 1n + (n2 - 1n));
    const fundUsd = (Number(fund / 10n ** 14n) / 10_000).toLocaleString("en-US", { style: "currency", currency: "USD" });
    el.textContent = `${sent} envelope${sent === 1 ? "" : "s"} sent on Mezo testnet · gas fund ${fundUsd}, paid for by fees`;
  } catch {
    /* keep the plain label */
  }
}
run();
