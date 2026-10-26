// GET /api/cashout?amount=<usd>[&country=XX]
// Picks the cash-out route for where the recipient is: which partner pays out,
// in which currency, over which bank rail, and roughly how much lands.
// MUSD is swapped to USDC on Base first (MUSD/USDC trades there), then the
// partner pays the bank. Testnet MUSD has no cash value, so `live` is false.

const BANXA = { partner: "Banxa", why: "Mezo's fiat partner" };
const YELLOW_CARD = { partner: "Yellow Card", why: "pays out across Africa" };

// country -> [currency, rail, partner]
const ROUTES = {
  US: ["USD", "ACH bank transfer", BANXA],
  GB: ["GBP", "Faster Payments", BANXA],
  AU: ["AUD", "bank transfer", BANXA],
  CA: ["CAD", "bank transfer", BANXA],
  NG: ["NGN", "bank transfer", YELLOW_CARD],
  GH: ["GHS", "mobile money or bank", YELLOW_CARD],
  KE: ["KES", "M-Pesa or bank", YELLOW_CARD],
  ZA: ["ZAR", "bank transfer", YELLOW_CARD],
  UG: ["UGX", "mobile money", YELLOW_CARD],
  TZ: ["TZS", "mobile money", YELLOW_CARD],
  CM: ["XAF", "mobile money", YELLOW_CARD],
  SN: ["XOF", "mobile money", YELLOW_CARD],
  CI: ["XOF", "mobile money", YELLOW_CARD],
};
const EUROZONE = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" ");
for (const c of EUROZONE) ROUTES[c] = ["EUR", "SEPA bank transfer", BANXA];

// Swap plus partner fees, kept deliberately round: an estimate, not a quote.
const FEE = 0.02;

let rates = null, ratesAt = 0;
async function usdRates() {
  if (rates && Date.now() - ratesAt < 3_600_000) return rates;
  const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  if (j.result !== "success") throw new Error("no rates");
  rates = j.rates;
  ratesAt = Date.now();
  return rates;
}

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (req.method !== "GET") return res.status(405).end(JSON.stringify({ ok: false, error: "Use GET." }));

  const asked = String(req.query?.country || "").toUpperCase();
  const country = /^[A-Z]{2}$/.test(asked) ? asked : String(req.headers["x-vercel-ip-country"] || "US").toUpperCase();
  const amount = Math.min(Math.max(Number(req.query?.amount) || 0, 0), 1_000_000);

  const route = ROUTES[country];
  if (!route) {
    return res.status(200).end(JSON.stringify({
      ok: true, country, supported: false, live: false,
      message: "Cash-out isn't available in your country yet. Your dollars stay safe in your wallet.",
    }));
  }
  const [currency, rail, { partner, why }] = route;

  let receive = null, rate = null;
  try {
    rate = (await usdRates())[currency] ?? null;
    if (rate && amount) receive = Math.floor(amount * (1 - FEE) * rate * 100) / 100;
  } catch {}

  return res.status(200).end(JSON.stringify({
    ok: true, country, supported: true, live: false,
    currency, rail, partner, partnerWhy: why,
    rate, feePct: FEE * 100, receive,
    steps: ["Swap MUSD to USDC on Base", `${partner} pays ${currency} to your account by ${rail}`],
    message: "Cash-out turns on with mainnet MUSD. This demo runs on Mezo testnet, where dollars are for testing.",
  }));
}
