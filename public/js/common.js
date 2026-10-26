import { APPNAME, CHAIN, ESCROW_ADDRESS, MUSD, ESCROW_ABI, ERC20_ABI, STORE } from "./config.js";

export const ethers = globalThis.ethers;

export const ERRORS = {
  NotFound: "We couldn't find this link. Make sure you copied the whole thing.",
  AlreadyClaimed: "This money has already been claimed.",
  AlreadyRefunded: "This link expired and the money went back to the sender.",
  Expired: "This link has expired. The sender can take the money back. Ask them to send a new one.",
  BadSignature: "This link looks damaged. Ask the sender to share it again.",
  ZeroRecipient: "We couldn't set up your wallet. Please refresh and try again.",
  BadInput: "This link looks incomplete. Please open it again from the original message.",
  Network: "We couldn't reach the network. Check your connection and try again.",
  Cancelled: "You cancelled. Nothing was sent.",
  SendFailed: "That didn't go through. Your money hasn't moved. Please try again.",
  NotConfigured: `${APPNAME} isn't fully set up yet. Please try again a little later.`,
};

// ---------- DOM ----------
// Small element builder. Children that are strings become text nodes, so on-chain notes are never parsed as HTML.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function render(root, ...nodes) {
  root.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  const focusTarget = root.querySelector("[data-autofocus]") || root.querySelector("h1, h2");
  if (focusTarget) {
    if (!focusTarget.hasAttribute("tabindex") && /^H[12]$/.test(focusTarget.tagName)) focusTarget.setAttribute("tabindex", "-1");
    focusTarget.focus({ preventScroll: true });
  }
}

export const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });

export function busy(text) {
  return h("div", { class: "card center", role: "status", "aria-live": "polite" }, spinner(), h("p", { class: "lead" }, text));
}

export function notice(kind, text, ...extra) {
  return h("div", { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" }, h("p", {}, text), ...extra);
}

let toastTimer;
export function toast(text) {
  let t = document.getElementById("toast");
  if (!t) {
    t = h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(t);
  }
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

// Name the app everywhere from the single APPNAME constant.
export function applyAppName(pageTitle) {
  document.title = pageTitle ? `${pageTitle} · ${APPNAME}` : APPNAME;
  document.querySelectorAll("[data-appname]").forEach((el) => { el.textContent = APPNAME; });
}

// Copy with a fallback for in-app browsers that block the clipboard API.
export async function copyText(text, inputEl) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
    return true;
  } catch {
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
      try { if (document.execCommand("copy")) { toast("Copied"); return true; } } catch { /* ignore */ }
    }
    toast("Press and hold to copy");
    return false;
  }
}

// ---------- formatting ----------
export function toNumber(wei) {
  return Number(ethers.formatUnits(wei, 18));
}
export function fmtUsd(wei) {
  return "$" + toNumber(wei).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// "$50" for whole amounts, "$12.50" otherwise.
export function fmtUsdShort(wei) {
  const n = toNumber(wei);
  const whole = Math.round(n * 100) % 100 === 0;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}
export function fmtMusd(wei) {
  return toNumber(wei).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " MUSD";
}
export function fmtDate(sec) {
  return new Date(Number(sec) * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
export function timeLeft(expiresAt, nowSec) {
  const s = Number(expiresAt) - Number(nowSec);
  if (s <= 0) return "Expired";
  const d = Math.floor(s / 86400), hrs = Math.floor(s / 3600), m = Math.max(1, Math.floor(s / 60));
  if (d >= 1) return `Expires in ${d} day${d === 1 ? "" : "s"}`;
  if (hrs >= 1) return `Expires in ${hrs} hour${hrs === 1 ? "" : "s"}`;
  return `Expires in ${m} minute${m === 1 ? "" : "s"}`;
}
export const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
export const txUrl = (hash) => `${CHAIN.explorer}/tx/${hash}`;

// ---------- chain (reads) ----------
let _rp;
export function readProvider() {
  if (!_rp) _rp = new ethers.JsonRpcProvider(CHAIN.rpc, CHAIN.id, { staticNetwork: true });
  return _rp;
}
export const escrowConfigured = () => !!ESCROW_ADDRESS && ethers.isAddress(ESCROW_ADDRESS);
export const escrowRead = () => new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, readProvider());
export const musdRead = () => new ethers.Contract(MUSD, ERC20_ABI, readProvider());
export async function latestTimestamp() {
  const b = await readProvider().getBlock("latest");
  return BigInt(b.timestamp);
}

// ---------- browser wallet (sender writes only) ----------
export const hasWallet = () => typeof window.ethereum !== "undefined" && !!window.ethereum;

export async function connect() {
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  return accts[0] ? ethers.getAddress(accts[0]) : null;
}
export async function currentAccount() {
  const accts = await window.ethereum.request({ method: "eth_accounts" });
  return accts[0] ? ethers.getAddress(accts[0]) : null;
}
export async function onRightChain() {
  const id = await window.ethereum.request({ method: "eth_chainId" });
  return BigInt(id) === BigInt(CHAIN.id);
}
export async function ensureChain() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] });
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code !== 4902) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN.hex,
        chainName: CHAIN.name,
        nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
        rpcUrls: [CHAIN.rpc],
        blockExplorerUrls: [CHAIN.explorer],
      }],
    });
  }
}
export async function getSigner() {
  return new ethers.BrowserProvider(window.ethereum).getSigner();
}

export function isRejected(e) {
  return e?.code === 4001 || e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001 || e?.error?.code === 4001;
}

export function onWalletChange(fn) {
  if (!hasWallet() || !window.ethereum.on) return;
  window.ethereum.on("chainChanged", fn);
  window.ethereum.on("accountsChanged", fn);
}

/**
 * Shared connect/switch gate for Send and My links.
 * Renders the no-wallet / not-connected / wrong-network states, and calls onReady(account) when all is set.
 */
export async function walletGate(root, { intro, onReady }) {
  if (!hasWallet()) {
    return render(root, h("section", { class: "card" },
      h("h1", {}, intro),
      h("p", {}, "To send money you need a browser wallet like MetaMask. Receiving doesn't need one."),
      h("a", { class: "btn btn-primary", href: "https://metamask.io/download/", target: "_blank", rel: "noopener noreferrer" }, "Get MetaMask"),
    ));
  }
  let account;
  try { account = await currentAccount(); } catch { account = null; }
  if (!account) {
    return render(root, h("section", { class: "card" },
      h("h1", {}, intro),
      h("button", { class: "btn btn-primary", type: "button", onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await connect(); } catch (e) { if (!isRejected(e)) toast("Couldn't connect. Please try again."); }
        walletGate(root, { intro, onReady });
      } }, "Connect wallet"),
    ));
  }
  if (!(await onRightChain())) {
    return render(root, h("section", { class: "card" },
      h("h1", {}, "Let's switch you to Mezo Testnet."),
      h("p", { class: "muted" }, "Your wallet is on a different network."),
      h("button", { class: "btn btn-primary", type: "button", onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await ensureChain(); } catch (e) { if (!isRejected(e)) toast("Couldn't switch. Please try in your wallet."); }
        walletGate(root, { intro, onReady });
      } }, "Switch network"),
    ));
  }
  if (!escrowConfigured()) {
    return render(root, notice("error", ERRORS.NotConfigured));
  }
  return onReady(account);
}

// ---------- local storage (always wrapped: in-app browsers can block it) ----------
export function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function sentLinksFor(account) {
  const all = load(STORE.sentLinks, {});
  return all[account.toLowerCase()] || [];
}
export function saveSentLink(account, link) {
  const all = load(STORE.sentLinks, {});
  const k = account.toLowerCase();
  const list = (all[k] || []).filter((l) => String(l.id) !== String(link.id));
  list.push(link);
  all[k] = list;
  return save(STORE.sentLinks, all);
}

export function whatsappUrl(amountWei, note, url) {
  const text = `I've sent you ${fmtUsdShort(amountWei)} with ${APPNAME}` + (note ? ` for "${note}"` : "") +
    ". Tap to claim it, no app or fees needed: " + url;
  return "https://wa.me/?text=" + encodeURIComponent(text);
}

// Mark the active nav link.
export function markNav(name) {
  document.querySelectorAll(`[data-nav="${name}"]`).forEach((a) => a.setAttribute("aria-current", "page"));
}
