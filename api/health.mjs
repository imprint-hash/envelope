// GET -> { ok, relayer, balance, escrow }. Never includes any key.
import { JsonRpcProvider, Wallet, formatEther, isAddress, getAddress } from "ethers";

let ctx = null;
function getCtx() {
  if (ctx) return ctx;
  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk) return null;
  const provider = new JsonRpcProvider(process.env.RPC_URL || "https://rpc.test.mezo.org", 31611, { staticNetwork: true });
  ctx = { provider, address: new Wallet(pk).address };
  return ctx;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.statusCode = 405; return res.end(JSON.stringify({ ok: false })); }
  const escrowEnv = process.env.ESCROW_ADDRESS;
  const escrow = escrowEnv && isAddress(escrowEnv) ? getAddress(escrowEnv) : null;
  const c = getCtx();
  if (!c) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, configured: false, escrow })); }
  try {
    const bal = await c.provider.getBalance(c.address);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, relayer: c.address, balance: formatEther(bal), escrow }));
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ ok: false, relayer: c.address, escrow, error: "rpc unreachable" }));
  }
}
