// "Envelope in numbers": live stats read straight from Mezo testnet (no server, no indexer).
// Reads every event of LinkEscrow (V1) and EnvelopeV2 from the deploy block to now, in 10k-block windows
// (the RPC's eth_getLogs cap), newest first. Results are cached in sessionStorage; a revisit only reads new blocks.
import {
  APPNAME, CHAIN, ESCROW_ADDRESS, ESCROW_ADDRESS_V2, ESCROW_DEPLOY_BLOCK, ESCROW_V2_DEPLOY_BLOCK, CLAIM_OPTION_SIG,
} from "./config.js";
import { ESCROW_V2_ABI } from "./abi-v2.js";
import {
  ethers, h, render, notice, applyAppName, markNav, v2Configured, escrowV2Read,
  fmtUsd, fmtUsdShort, shortAddr, txUrl, spinner,
} from "./common.js";
import { aggregate, latestTxs, windows, dedupe } from "./stats-core.js";

const root = document.getElementById("app");
applyAppName("Stats");
markNav("stats");

const CACHE_KEY = "appname.stats.v1";
const FRESH_MS = 60_000; // re-read the chain at most once a minute per tab
const PARALLEL = 8; // measured: 8 unbatched calls in flight read ~380k blocks in ~9 s; batching made it 3x slower
const iface = new ethers.Interface(ESCROW_V2_ABI.filter((f) => f.startsWith("event ")));
const TOPICS = ["Created", "Claimed", "Refunded", "FeeTaken", "RelayerPaid", "Swept"].map((n) => iface.getEvent(n).topicHash);
const CLAIM_OPTION_SELECTOR = CLAIM_OPTION_SIG ? ethers.id(CLAIM_OPTION_SIG).slice(0, 10) : null;

const V1 = ESCROW_ADDRESS.toLowerCase();
const hasV2 = v2Configured();
const V2 = hasV2 ? ESCROW_ADDRESS_V2.toLowerCase() : null;
const ADDRS = hasV2 ? [V1, V2] : [V1];
const FLOOR = Math.min(ESCROW_DEPLOY_BLOCK, hasV2 && ESCROW_V2_DEPLOY_BLOCK > 0 ? ESCROW_V2_DEPLOY_BLOCK : ESCROW_DEPLOY_BLOCK);
const SCOPE = ADDRS.join(",") + "@" + FLOOR + (CLAIM_OPTION_SELECTOR || "");

// ---------- cache (sessionStorage can be blocked in in-app browsers: always wrapped) ----------
function loadCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    return c && c.scope === SCOPE && Array.isArray(c.events) ? c : null;
  } catch { return null; }
}
function saveCache(c) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* full or blocked: fine, we just re-read */ }
}

// ---------- chain reads ----------
// Own provider with JSON-RPC batching off: Mezo's RPC answers batched getLogs one by one, parallel calls are much faster.
let _logsProvider;
const rpc = (method, params) => {
  if (!_logsProvider) _logsProvider = new ethers.JsonRpcProvider(CHAIN.rpc, CHAIN.id, { staticNetwork: true, batchMaxCount: 1 });
  return _logsProvider.send(method, params);
};
const hex = (n) => "0x" + n.toString(16);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(log) {
  let p;
  try { p = iface.parseLog(log); } catch { return null; }
  if (!p) return null;
  const a = {};
  for (const name of ["id", "sender", "recipient", "relayer", "amount", "fee"]) {
    if (p.fragment.inputs.some((i) => i.name === name)) a[name] = String(p.args[name]);
  }
  return {
    v: log.address.toLowerCase() === V1 ? 1 : 2, name: p.name, tx: log.transactionHash,
    block: Number(log.blockNumber), logIndex: Number(log.logIndex), args: a,
  };
}

// One window; on an error, split it in two (in case a node's cap is lower), then retry small ones.
async function getLogs(from, to, tries = 0) {
  try {
    return await rpc("eth_getLogs", [{ address: ADDRS, topics: [TOPICS], fromBlock: hex(from), toBlock: hex(to) }]);
  } catch (e) {
    if (to - from > 1000) {
      const mid = Math.floor((from + to) / 2);
      return [...(await getLogs(from, mid)), ...(await getLogs(mid + 1, to))];
    }
    if (tries >= 3) throw e;
    await pause(500 * 2 ** tries);
    return getLogs(from, to, tries + 1);
  }
}

async function scan(from, head, onProgress) {
  const wins = windows(from, head);
  const out = [];
  let done = 0, next = 0;
  async function worker() {
    while (next < wins.length) {
      const [a, b] = wins[next++];
      const logs = await getLogs(a, b);
      for (const l of logs) { const e = decode(l); if (e) out.push(e); }
      onProgress(++done / wins.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, wins.length) }, worker));
  return out;
}

// For the future claim-into-Mezo-Pools mode: which V2 claim txs called that function.
async function checkClaimOptions(events, cache) {
  if (!CLAIM_OPTION_SELECTOR) return null;
  const checked = new Set(cache.checkedTxs || []);
  const hits = new Set(cache.optionTxs || []);
  const todo = [...new Set(events.filter((e) => e.v === 2 && e.name === "Claimed" && !checked.has(e.tx)).map((e) => e.tx))];
  for (const tx of todo) {
    const t = await rpc("eth_getTransactionByHash", [tx]);
    if (t?.input?.slice(0, 10).toLowerCase() === CLAIM_OPTION_SELECTOR) hits.add(tx);
    checked.add(tx);
  }
  cache.checkedTxs = [...checked];
  cache.optionTxs = [...hits];
  return hits;
}

async function blockTimes(rows, times) {
  const need = [...new Set(rows.map((r) => r.block))].filter((b) => !times[b]);
  await Promise.all(need.map(async (b) => {
    try { const blk = await rpc("eth_getBlockByNumber", [hex(b), false]); times[b] = Number(blk.timestamp); } catch { /* shown as "—" */ }
  }));
  return times;
}

// ---------- view ----------
const n = (x) => Number(x).toLocaleString("en-US");
const ago = (sec) => {
  if (!sec) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const KIND = {
  "sent": ["Sent", "chip-wait"],
  "sent-bitcoin": ["Sent from Bitcoin", "chip-alert"],
  "claimed": ["Claimed", "chip-ok"],
  "refunded": ["Refunded", "chip-muted"],
  "swept": ["Surplus to treasury", "chip-muted"],
};

function tile(label, value, sub, extra = "") {
  return h("div", { class: `stat ${extra}` },
    h("p", { class: "stat-label" }, label),
    h("p", { class: "stat-value" }, value),
    sub ? h("p", { class: "stat-sub" }, sub) : null);
}

function loadingView(pct, cachedNote) {
  return h("section", { class: "card center", role: "status", "aria-live": "polite" },
    spinner(),
    h("p", { class: "lead" }, "Reading every envelope from Mezo testnet..."),
    h("div", { class: "stat-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct * 100)) },
      h("span", { style: `width:${Math.max(3, Math.round(pct * 100))}%` })),
    h("p", { class: "muted small" }, cachedNote || `${Math.round(pct * 100)}% of blocks read`));
}

function view(s, rows, times, meta) {
  const gasFund = meta.gasFund ?? s.gasFundComputed;
  const cover = s.relayerPaid > 0n ? Number((s.fees * 100n) / s.relayerPaid) / 100 : null;
  const pctPaid = s.fees > 0n ? Math.min(100, Number((s.relayerPaid * 1000n) / s.fees) / 10) : 0;

  const hero = h("section", { class: "stat-hero" },
    h("p", { class: "v-label" }, "Total MUSD moved"),
    h("p", { class: "stat-hero-amount" }, fmtUsd(s.volume).replace("$", ""), h("span", {}, "MUSD")),
    h("p", { class: "v-meta" }, `${fmtUsdShort(s.delivered)} already in recipients' hands · ${fmtUsdShort(s.openAmount)} waiting in open links`));

  const counts = h("section", { class: "stat-grid", "aria-label": "Envelopes" },
    tile("Envelopes sent", n(s.sent), hasV2 ? `${n(s.sentV1)} on V1 · ${n(s.sentV2)} on V2` : "All on V1 so far"),
    tile("Claimed", n(s.claimed), s.sent ? `${Math.round((s.claimed / s.sent) * 100)}% of all links` : null),
    tile("Refunded", n(s.refunded), "Unclaimed after 7 days, sent back"),
    tile("Still open", n(s.open), `${fmtUsdShort(s.openAmount)} waiting to be claimed`),
  );

  const reach = h("section", { class: "stat-grid", "aria-label": "Reach" },
    tile("Unique senders", n(s.uniqueSenders), "Wallets that sent a link"),
    tile("New MUSD holders reached", n(s.uniqueRecipients), "Unique wallets that claimed"),
    hasV2
      ? tile("Borrow-to-send envelopes", n(s.borrowToSend), `${fmtUsdShort(s.borrowToSendVolume)} sent straight from a Bitcoin loan, gasless`)
      : tile("Borrow-to-send envelopes", "Soon", "Starts when EnvelopeV2 goes live", "stat-soon"),
    s.claimsIntoPools === null
      ? tile("Claims into Mezo Pools", "Soon", "Coming with claim options", "stat-soon")
      : tile("Claims into Mezo Pools", n(s.claimsIntoPools), "Claimed straight into a Mezo Pools position"),
  );

  const gas = h("section", { class: "card stat-gas" },
    h("div", { class: "row-between" },
      h("h2", {}, "Pays its own gas"),
      h("span", { class: "tag tag-ink" }, "V2 gas fund")),
    h("p", { class: "loan-hint" }, "Senders pay 0.5% on top. That fee goes into a gas fund inside the contract, which pays relayers back for the gas they spend. Recipients never pay a cent."),
    h("div", { class: "loan-stats stat-gas-stats" },
      h("div", {}, h("small", {}, "Fees collected"), h("b", {}, fmtUsd(s.fees))),
      h("div", {}, h("small", {}, `Paid to relayers (${n(s.relayerPayouts)})`), h("b", {}, fmtUsd(s.relayerPaid))),
      h("div", {}, h("small", {}, "Swept to treasury"), h("b", {}, fmtUsd(s.swept))),
      h("div", {}, h("small", {}, meta.gasFund === null ? "Gas fund now (from events)" : "Gas fund now"), h("b", {}, fmtUsd(gasFund))),
    ),
    h("div", { class: "stat-cover" },
      h("div", { class: "stat-cover-bar", "aria-hidden": "true" }, h("span", { style: `width:${pctPaid}%` })),
      h("p", { class: "stat-cover-text" },
        !hasV2 ? "Starts counting when EnvelopeV2 goes live."
          : cover === null ? "No relayer payouts yet."
          : `Fees cover relayer gas ${cover.toLocaleString("en-US", { maximumFractionDigits: 2 })}× over (${pctPaid}% of fees paid back out).`)),
  );

  const table = rows.length === 0 ? h("p", { class: "muted" }, "No transactions yet.") : h("table", { class: "stat-table" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "What"), h("th", { scope: "col" }, "Amount"), h("th", { scope: "col" }, "Link"), h("th", { scope: "col" }, "When"), h("th", { scope: "col" }, "Transaction"))),
    h("tbody", {}, rows.map((r) => {
      const [label, chip] = KIND[r.kind];
      return h("tr", {},
        h("td", { "data-th": "What" }, h("span", { class: `chip ${chip}` }, label)),
        h("td", { "data-th": "Amount", class: "num" }, r.amount > 0n ? fmtUsd(r.amount) : "—"),
        h("td", { "data-th": "Link" }, r.id ? `V${r.v} #${r.id}` : `V${r.v}`),
        h("td", { "data-th": "When" }, ago(times[r.block])),
        h("td", { "data-th": "Transaction" }, h("a", { href: txUrl(r.tx), target: "_blank", rel: "noopener noreferrer" }, shortAddr(r.tx), " ↗")));
    })));

  const latest = h("section", { class: "card stat-latest" },
    h("h2", {}, "Latest 20 transactions"),
    h("p", { class: "muted small" }, "Every row opens on the Mezo explorer."),
    table);

  const foot = h("p", { class: "muted small stat-foot" },
    `Read live from blocks ${n(FLOOR)}–${n(meta.head)} on ${CHAIN.name}. Updated ${new Date(meta.at).toLocaleTimeString()}. `,
    h("button", { class: "btn-link stat-refresh", type: "button", onclick: () => start(true) }, "Refresh"));

  return [
    h("section", { class: "stat-head" },
      h("p", { class: "eyebrow" }, "Live from Mezo testnet"),
      h("h1", {}, `${APPNAME} in numbers`),
      h("p", { class: "muted" }, "Every number here is read straight from the contracts on Mezo, not from our server.")),
    hero, counts, reach, gas, latest, foot,
  ];
}

// ---------- flow ----------
let running = false;
async function start(force = false) {
  if (running) return;
  running = true;
  const cache = loadCache() || { scope: SCOPE, scannedTo: FLOOR - 1, events: [], times: {} };
  const showCached = !!cache.stats;
  if (showCached) paint(cache);
  try {
    if (!force && cache.at && Date.now() - cache.at < FRESH_MS) return;
    const head = Number(await rpc("eth_blockNumber", []));
    if (!showCached) render(root, loadingView(0));
    const fresh = head > cache.scannedTo
      ? await scan(cache.scannedTo + 1, head, (p) => { if (!showCached) render(root, loadingView(p)); })
      : [];
    cache.events = dedupe([...cache.events, ...fresh]);
    cache.scannedTo = head;
    const optionTxs = await checkClaimOptions(cache.events, cache);
    const s = aggregate(cache.events, { claimOptionTxs: optionTxs });
    const rows = latestTxs(cache.events, 20);
    cache.times = await blockTimes(rows, cache.times || {});
    let gasFund = null;
    if (hasV2) { try { gasFund = String(await escrowV2Read().gasFund()); } catch { /* fall back to events */ } }
    cache.stats = true;
    cache.gasFund = gasFund;
    cache.head = head;
    cache.at = Date.now();
    saveCache(cache);
    paint(cache);
  } catch {
    if (!showCached) {
      render(root, notice("error", "We couldn't reach the Mezo network. Check your connection and try again.",
        h("button", { class: "btn btn-secondary", type: "button", onclick: () => start(true) }, "Try again")));
    }
  } finally {
    running = false;
  }
}

function paint(cache) {
  const optionTxs = CLAIM_OPTION_SELECTOR ? new Set(cache.optionTxs || []) : null;
  const s = aggregate(cache.events, { claimOptionTxs: optionTxs });
  const rows = latestTxs(cache.events, 20);
  const gasFund = cache.gasFund === null || cache.gasFund === undefined ? null : BigInt(cache.gasFund);
  // Keep focus where it is on a background refresh: render() focuses the h1, which is fine on first paint only.
  const firstPaint = !root.querySelector(".stat-head");
  if (firstPaint) render(root, view(s, rows, cache.times || {}, { gasFund, head: cache.head ?? cache.scannedTo, at: cache.at || Date.now() }));
  else root.replaceChildren(...view(s, rows, cache.times || {}, { gasFund, head: cache.head ?? cache.scannedTo, at: cache.at || Date.now() }));
}

start();
