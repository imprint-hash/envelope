import { CHAIN, ESCROW_ADDRESS, ESCROW_ADDRESS_V2, MUSD, STORE, STATUS, CLAIM_TYPES, V2_LINK_PREFIX } from "./config.js";
import { MODE, CLAIM_WITH_OPTION_TYPES, envelopeV2Domain, quoteOptions, gasTipLocal } from "./abi-v2.js";
import {
  ethers, h, render, busy, notice, applyAppName, escrowConfigured, escrowReadFor, v2Configured, musdRead, readProvider,
  latestTimestamp, fmtUsd, fmtUsdShort, fmtMusd, timeLeft, shortAddr, copyText, load, save, hasWallet, connect,
  isRejected, ERRORS,
} from "./common.js";

const root = document.getElementById("app");
const walletRoot = document.getElementById("wallet");
applyAppName("Claim");

// "My wallet" in the footer scrolls instead of using #wallet, which would overwrite the link key in the URL.
document.getElementById("nav-wallet")?.addEventListener("click", () => {
  renderWallet(true);
  walletRoot.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

const getLocalWallet = () => load(STORE.wallet, null);
function getOrCreateLocalWallet() {
  const existing = getLocalWallet();
  if (existing?.address && existing?.mnemonic) return existing;
  const w = ethers.Wallet.createRandom();
  const rec = { address: w.address, mnemonic: w.mnemonic.phrase };
  if (!save(STORE.wallet, rec)) throw new Error("storage");
  return rec;
}

// Links: V1 "#<id>.<key>", V2 "#v2-<id>.<key>". v = 2 when marked, null when unmarked (V1 first, then V2).
function parseHash() {
  const m = location.hash.slice(1).match(/^(v2-)?(\d{1,12})\.([0-9a-fA-F]{64})$/);
  return m ? { v: m[1] ? 2 : null, id: BigInt(m[2]), pk: "0x" + m[3] } : null;
}
// Claims remembered on this phone. V1 keys stay "<id>" so older claims still show.
const claimKey = (v, id) => (v === 2 ? `v2:${id}` : String(id));
const claimedPath = (v, id) => `/c#${v === 2 ? V2_LINK_PREFIX : ""}${id}`;

function errorCard(text, retry) {
  return h("section", { class: "card" },
    notice("error", text),
    retry ? h("button", { class: "btn btn-secondary", type: "button", onclick: retry }, "Try again") : null,
    h("a", { class: "btn btn-ghost", href: "/" }, "Send money with a link"),
  );
}

async function start() {
  renderWallet(false);
  const parsed = parseHash();
  const idOnly = location.hash.slice(1).match(/^(v2-)?(\d{1,12})$/);
  if (!parsed && idOnly) return showAlreadyMine(idOnly[1] ? 2 : 1, BigInt(idOnly[2]));
  if (!parsed) return render(root, errorCard(ERRORS.BadInput));
  if (!escrowConfigured() || (parsed.v === 2 && !v2Configured())) return render(root, errorCard(ERRORS.NotConfigured));

  let linkAddr;
  try { linkAddr = new ethers.Wallet(parsed.pk).address; } catch { return render(root, errorCard(ERRORS.BadSignature)); }

  render(root, busy("Opening your money..."));
  // Which contract holds it: the marked one, or V1 then V2. The key must match the envelope's link either way.
  const versions = parsed.v === 2 ? [2] : v2Configured() ? [1, 2] : [1];
  let d, note, now, exists = false;
  try {
    now = await latestTimestamp();
    for (const v of versions) {
      const [dep, n] = await escrowReadFor(v).getDeposit(parsed.id);
      if (Number(dep.status) === STATUS.None) continue;
      exists = true;
      if (ethers.getAddress(dep.link) === linkAddr) { d = dep; note = n; parsed.v = v; break; }
    }
  } catch {
    return render(root, errorCard(ERRORS.Network, start));
  }
  if (!d) return render(root, errorCard(exists ? ERRORS.BadSignature : ERRORS.NotFound));

  const status = Number(d.status);
  if (status === STATUS.Claimed) return showClaimed(parsed.v, parsed.id);
  if (status === STATUS.Refunded) return render(root, errorCard("This link has expired and the money went back to the sender."));
  if (now >= BigInt(d.expiresAt)) return render(root, errorCard("This link has expired. The sender can take the money back. Ask them to send a new one."));

  showReady(parsed, d, note, now);
}

function showReady(parsed, d, note, now, errorText) {
  const amount = d.amount;
  const approx = h("p", { class: "approx" }, "Digital dollars · 1 MUSD = $1 · Zero fee to claim");
  fetch(`/api/cashout?amount=${ethers.formatUnits(amount, 18)}`).then((r) => r.json()).then((r) => {
    if (r?.receive != null && r.currency !== "USD") {
      const local = new Intl.NumberFormat(undefined, { style: "currency", currency: r.currency }).format(r.receive / (1 - r.feePct / 100));
      approx.replaceChildren("Approx. ", h("strong", {}, local), " · Zero fee to claim");
    }
  }).catch(() => {});
  const option = (title, sub, { onclick, soon, primary } = {}) => h(soon ? "div" : "button", {
    class: `recv${soon ? " soon" : ""}${primary ? " primary" : ""}`, type: soon ? undefined : "button", onclick,
  }, h("span", {}, h("b", {}, title, soon ? h("span", { class: "tag" }, "Soon") : null), h("small", {}, sub)), soon ? null : h("span", { class: "chev", "aria-hidden": "true" }, "›"));

  render(root,
    h("div", { class: "claim-pills" }, h("span", { class: "pill-soft" }, "🛡 Secured by the Envelope contract"), h("span", { class: "pill-warn" }, `⏱ ${timeLeft(d.expiresAt, now)}`)),
    h("section", { class: "card gift" },
      h("div", { class: "gift-head" },
        h("span", { class: "gift-ic", "aria-hidden": "true" }, "🎁"),
        h("div", {}, h("p", { class: "gift-title" }, "Someone sent you a gift"), h("p", { class: "muted small" }, "Dollars on Mezo, waiting for you")),
        h("span", { class: "pill-soft" }, "🔓 Unlocked")),
      h("div", { class: "gift-note" },
        h("p", { class: "note-big" }, note ? `“${note}”` : "“Here's something for you.”"),
        h("p", { class: "muted small" }, "Sent with love via Envelope")),
      h("div", { class: "tear" }),
      h("div", { class: "gift-money" },
        h("span", { class: "pill-ok" }, "Money secured and ready"),
        h("p", { class: "big-amount", "aria-label": `${fmtUsd(amount)} in digital dollars` }, fmtUsd(amount)),
        approx,
        feeLine(parsed.v, amount),
        errorText ? notice("error", errorText) : null,
        h("button", { class: "btn btn-primary btn-claim", type: "button", "data-autofocus": true,
          onclick: () => doClaim(parsed, d, note, now, "local") },
          h("span", {}, `Tap to claim ${fmtUsdShort(amount)}`), h("small", {}, "No sign-up · We pay the fee")),
        h("p", { class: "muted small center" }, "Behind the scenes: a secure wallet is made for you in this browser. No password or crypto knowledge needed."),
      ),
      h("div", { class: "recv-box" },
        h("p", { class: "step" }, "Choose where to receive"),
        option("Keep it in my Envelope wallet", "Instant · made for you right now", { primary: true, onclick: () => doClaim(parsed, d, note, now, "local") }),
        hasWallet() ? option("Send it to my MetaMask", "If you already have a wallet", { onclick: () => doClaim(parsed, d, note, now, "metamask") }) : null,
        option("Cash out to my bank", "Banxa in Europe, US, UK · Yellow Card in Africa", { soon: true }),
      ),
    ),
    h("p", { class: "claim-foot" }, "Free for you · 7-day claim window · Tip: open in Chrome or Safari to keep your wallet"),
  );
}

// Fee transparency: who paid what, in one plain line.
function feeLine(v, amount) {
  return h("p", { class: "fee-line-claim" }, v === 2
    ? `The sender paid a small 0.5% fee on top, so the full ${fmtUsd(amount)} is yours. Claiming is free.`
    : "No fees: the sender covered everything. Claiming is free.");
}

async function doClaim(parsed, d, note, now, mode) {
  let recipient;
  try {
    if (mode === "metamask") {
      recipient = await connect();
      if (!recipient) throw new Error("no account");
    } else {
      recipient = getOrCreateLocalWallet().address;
    }
  } catch (e) {
    return showReady(parsed, d, note, now, isRejected(e) ? "No problem. Tap Claim when you're ready." : ERRORS.ZeroRecipient);
  }

  // V2 links: the wallet is ready, now the recipient chooses how to keep the money.
  if (parsed.v === 2) return showChoices(parsed, d, note, now, mode, recipient);
  return claimPlain(parsed, d, note, now, mode, recipient);
}

async function claimPlain(parsed, d, note, now, mode, recipient) {
  render(root, busy("Claiming... this takes a few seconds."));
  let sig;
  try {
    if (parsed.v === 2) {
      // V2: sign the contract's own claim digest, so the EIP-712 domain can never drift from the contract.
      const digest = await escrowReadFor(2).claimDigest(parsed.id, recipient);
      sig = new ethers.Wallet(parsed.pk).signingKey.sign(digest).serialized;
    } else {
      const domain = { name: "LinkEscrow", version: "1", chainId: CHAIN.id, verifyingContract: ESCROW_ADDRESS };
      sig = await new ethers.Wallet(parsed.pk).signTypedData(domain, CLAIM_TYPES, { id: parsed.id, recipient });
    }
  } catch {
    return showReady(parsed, d, note, now, ERRORS.BadSignature);
  }

  const back = (text) => (parsed.v === 2 ? showChoices(parsed, d, note, now, mode, recipient, text) : showReady(parsed, d, note, now, text));
  const body = await postClaim({ id: parsed.id.toString(), recipient, signature: sig, v: parsed.v === 2 ? 2 : 1 }, parsed, back);
  if (!body) return;
  return finishClaim(parsed, d, note, now, mode, recipient, body, null, back);
}

// Sends the signed claim to our relayer. Returns the body on success, or null after showing the error.
async function postClaim(payload, parsed, back) {
  let res, body;
  try {
    res = await fetch("/api/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    body = await res.json().catch(() => ({}));
  } catch {
    back(ERRORS.Network);
    return null;
  }
  if (!res.ok || !body.ok) {
    if (body.code === "AlreadyClaimed") showClaimed(parsed.v, parsed.id);
    else back(body.error || "Something went wrong on our side. Your money is safe in the link. Please try again in a minute.");
    return null;
  }
  return body;
}

// option = null for a plain claim, or { mode, quote } for a Mezo Pools option.
async function finishClaim(parsed, d, note, now, mode, recipient, body, option, back) {
  // Remember this claim on this phone so reopening the link can say "It's in your wallet".
  const claims = load(STORE.claims, {});
  const ck = claimKey(parsed.v, parsed.id);
  claims[ck] = { recipient, txHash: body.txHash };
  save(STORE.claims, claims);

  render(root, busy("Almost there... confirming on the network."));
  try {
    const receipt = await readProvider().waitForTransaction(body.txHash, 1, 60000);
    if (receipt && receipt.status !== 1) {
      delete claims[ck]; save(STORE.claims, claims);
      return back("That didn't go through. Your money is safe in the link. Please try again.");
    }
  } catch { /* timed out: the tx was broadcast, show success with the explorer link */ }

  history.replaceState(null, "", claimedPath(parsed.v, parsed.id));
  if (option) return showOptionDone(d.amount, recipient, body.txHash || null, mode, option);
  showDone(d.amount, recipient, body.txHash || null, mode, parsed.v);
}

// ---------- Mezo Pools choices (V2 links) ----------
const at = (addr, abi) => new ethers.Contract(addr, abi, readProvider());
const fmtBtc = (wei) => {
  const n = Number(ethers.formatUnits(wei, 18));
  return n === 0 ? "0" : n.toLocaleString(undefined, { maximumSignificantDigits: 3 });
};

function showChoices(parsed, d, note, now, mode, recipient, errorText) {
  const amount = d.amount;
  const choice = (title, sub, extra, onclick, { primary, disabled } = {}) => h("button", {
    class: `recv choice${primary ? " primary" : ""}`, type: "button", onclick, disabled: disabled || undefined,
  }, h("span", {}, h("b", {}, title), h("small", {}, sub), extra || null), h("span", { class: "chev", "aria-hidden": "true" }, "›"));

  const earnQuote = h("small", { class: "quote" }, "Checking today's rates…");
  const tipQuote = h("small", { class: "quote" }, "Checking today's rates…");
  let quotes = null;
  const earnBtn = choice("Keep it earning",
    "It goes into a Mezo Pools savings spot (dollars paired with USDC). It earns a share of trading fees, and you can take it out any time.",
    earnQuote, () => quotes && claimOption(parsed, d, note, now, mode, recipient, MODE.EARN, quotes.earn), { disabled: true });
  const tipBtn = choice("Get a little Bitcoin for fees",
    `We swap ${fmtUsd(gasTipLocal(amount))} into BTC, so you can pay network fees yourself later. The rest stays as dollars.`,
    tipQuote, () => quotes && claimOption(parsed, d, note, now, mode, recipient, MODE.GAS_TIP, quotes.gasTip), { disabled: true });

  render(root, h("section", { class: "card choices" },
    h("p", { class: "eyebrow" }, "Your wallet is ready"),
    h("h1", {}, `How would you like to keep your ${fmtUsdShort(amount)}?`),
    h("p", { class: "muted small" }, "Sent to ", h("code", {}, shortAddr(recipient)), " · We pay the network fee for every choice"),
    errorText ? notice("error", errorText) : null,
    h("div", { class: "recv-box" },
      choice("Keep it as dollars", `The full ${fmtUsd(amount)} lands in your wallet as digital dollars, ready to spend or send.`,
        null, () => claimPlain(parsed, d, note, now, mode, recipient), { primary: true }),
      earnBtn,
      tipBtn,
    ),
    h("p", { class: "muted small" }, "If prices move more than 1% before it goes through, nothing happens and your money stays safe in the link."),
  ));

  quoteOptions({ env: escrowReadFor(2), at, musd: MUSD, amount }).then((q) => {
    if (!q) throw new Error("off");
    quotes = q;
    if (q.earn.lp > 0n) {
      earnQuote.textContent = `Worth about ${fmtUsd(q.earn.valueUsd)} in the pool today`;
      earnBtn.disabled = false;
    } else earnQuote.textContent = "Not available for this amount right now.";
    if (q.gasTip.btcOut > 0n) {
      tipQuote.textContent = `About ${fmtBtc(q.gasTip.btcOut)} BTC (from ${fmtUsd(q.gasTip.tip)}) + ${fmtUsd(q.gasTip.musdRest)} as dollars`;
      tipBtn.disabled = false;
    } else tipQuote.textContent = "Not available for this amount right now.";
  }).catch(() => {
    earnQuote.textContent = "Not available right now.";
    tipQuote.textContent = "Not available right now.";
  });
}

async function claimOption(parsed, d, note, now, mode, recipient, optMode, quote) {
  const back = (text) => showChoices(parsed, d, note, now, mode, recipient, text);
  render(root, busy(optMode === MODE.EARN ? "Putting your money to work... this takes a few seconds." : "Getting your Bitcoin... this takes a few seconds."));
  let sig, deadline;
  try {
    deadline = (await latestTimestamp()) + 600n; // 10 minutes to land
    const value = { id: parsed.id, recipient, mode: optMode, minOut: quote.minOut, deadline };
    const domain = envelopeV2Domain(ESCROW_ADDRESS_V2, CHAIN.id);
    // The link key signs the typed message here in the browser. Check our digest against the
    // contract's own first, so a mismatch can never reach the relayer.
    const onChain = await escrowReadFor(2).claimWithOptionDigest(parsed.id, recipient, optMode, quote.minOut, deadline);
    if (ethers.TypedDataEncoder.hash(domain, CLAIM_WITH_OPTION_TYPES, value) !== onChain) throw new Error("digest");
    sig = await new ethers.Wallet(parsed.pk).signTypedData(domain, CLAIM_WITH_OPTION_TYPES, value);
  } catch {
    return back(ERRORS.BadSignature);
  }
  const body = await postClaim({
    id: parsed.id.toString(), recipient, mode: optMode, minOut: quote.minOut.toString(), deadline: deadline.toString(), sig, v: 2,
  }, parsed, back);
  if (!body) return;
  return finishClaim(parsed, d, note, now, mode, recipient, body, { mode: optMode, quote }, back);
}

async function showOptionDone(amount, recipient, txHash, mode, option) {
  const earn = option.mode === MODE.EARN;
  const q = option.quote;
  render(root, h("section", { class: "card done" },
    h("p", { class: "big-amount", "aria-hidden": "true" }, fmtUsd(amount)),
    h("h1", {}, earn ? `Your ${fmtUsdShort(amount)} is now earning.` : `${fmtUsdShort(q.musdRest)} is yours, plus a little Bitcoin.`),
    earn
      ? h("p", { class: "lead" }, "It's in a Mezo Pools savings spot owned by your wallet. It earns a share of trading fees, and you can take it out any time.")
      : h("p", { class: "lead" }, `About ${fmtBtc(q.btcOut)} BTC is in your wallet for network fees.`),
    await balanceLine(recipient),
    h("p", { class: "muted small" }, "Sent to ", h("code", {}, shortAddr(recipient))),
    txHash ? h("a", { class: "btn btn-secondary", href: `${CHAIN.explorer}/tx/${txHash}`, target: "_blank", rel: "noopener noreferrer" }, "See it on the explorer") : null,
  ), sendForwardCard());
  confetti();
  if (!earn) root.append(await cashOutCard(q.musdRest));
  if (mode === "local") renderWallet(true, "Keep this money safe: save your recovery phrase.");
}

async function balanceLine(addr) {
  const p = h("p", { class: "balance" }, "Wallet balance: …");
  musdRead().balanceOf(addr)
    .then((b) => { p.replaceChildren("Wallet balance: ", h("strong", {}, fmtMusd(b))); })
    .catch(() => { p.textContent = "We couldn't load your balance right now."; });
  return p;
}

// Growth loop: the person who just got money is the best next sender.
function sendForwardCard() {
  return h("section", { class: "card forward-card" },
    h("h2", {}, "Know someone who'd love this?"),
    h("p", { class: "muted" }, "Send dollars to anyone with a link, the same way you just got yours. They don't need an app either."),
    h("a", { class: "btn btn-primary", href: "/?from=claim" }, "Send it forward"),
  );
}

async function showDone(amount, recipient, txHash, mode, v) {
  render(root, h("section", { class: "card done" },
    h("p", { class: "big-amount", "aria-hidden": "true" }, fmtUsd(amount)),
    h("h1", {}, `${fmtUsdShort(amount)} is yours.`),
    await balanceLine(recipient),
    h("p", { class: "muted small" }, "Sent to ", h("code", {}, shortAddr(recipient))),
    feeLine(v, amount),
    txHash ? h("a", { class: "btn btn-secondary", href: `${CHAIN.explorer}/tx/${txHash}`, target: "_blank", rel: "noopener noreferrer" }, "View on explorer") : null,
  ), sendForwardCard());
  confetti();
  root.append(await cashOutCard(amount));
  if (mode === "local") renderWallet(true, "Keep this money safe: save your recovery phrase.");
}

// ---------- Cash out to a bank (route chosen by the recipient's country) ----------
async function cashOutCard(amount) {
  const usd = Number(ethers.formatUnits(amount, 18));
  let r;
  try {
    r = await (await fetch(`/api/cashout?amount=${usd}`)).json();
  } catch { return h("span"); }
  if (!r?.ok) return h("span");
  if (!r.supported) return h("section", { class: "card cashout" }, h("h2", {}, "Cash out to your bank"), h("p", { class: "muted" }, r.message));
  const money = r.receive != null
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: r.currency }).format(r.receive)
    : r.currency;
  return h("section", { class: "card cashout" },
    h("h2", {}, "Cash out to your bank"),
    h("p", { class: "lead" }, "About ", h("strong", {}, money), ` to your account by ${r.rail}.`),
    h("ol", { class: "steps" }, ...r.steps.map((s) => h("li", {}, s))),
    h("p", { class: "muted small" }, `Paid out by ${r.partner} (${r.partnerWhy}). Estimate includes about ${r.feePct}% in fees.`),
    h("button", { class: "btn btn-secondary", type: "button", disabled: !r.live }, r.live ? `Cash out with ${r.partner}` : "Available with mainnet MUSD"),
    r.live ? null : h("p", { class: "muted small" }, r.message),
  );
}

async function showClaimed(v, id) {
  const rec = load(STORE.claims, {})[claimKey(v, id)];
  if (!rec) return render(root, errorCard(ERRORS.AlreadyClaimed));
  render(root, h("section", { class: "card done" },
    h("h1", {}, "This money has already been claimed."),
    h("p", { class: "lead" }, "It's in your wallet."),
    await balanceLine(rec.recipient),
    rec.txHash ? h("a", { class: "btn btn-secondary", href: `${CHAIN.explorer}/tx/${rec.txHash}`, target: "_blank", rel: "noopener noreferrer" }, "View on explorer") : null,
  ), sendForwardCard());
}

async function showAlreadyMine(v, id) {
  // URL is "/c#<id>" (or "/c#v2-<id>") after a successful claim (key already removed).
  const rec = load(STORE.claims, {})[claimKey(v, id)];
  if (!rec) return render(root, errorCard(ERRORS.BadInput));
  return showClaimed(v, id);
}

// ---------- My wallet (only when a local wallet exists) ----------
function renderWallet(open, headline) {
  const w = getLocalWallet();
  if (!w) {
    walletRoot.replaceChildren(open ? h("section", { class: "card" },
      h("h2", {}, "My wallet"),
      h("p", { class: "muted" }, "You don't have a wallet on this phone yet. One is made for you the first time you claim money."),
    ) : "");
    return;
  }
  const body = h("div", {});
  const showPhrase = () => {
    body.replaceChildren(
      notice("warn", "Anyone who sees these 12 words can take your money. Write them down somewhere private."),
      h("button", { class: "btn btn-primary", type: "button", "data-autofocus": true, onclick: () => {
        const words = w.mnemonic.split(" ");
        const list = h("ol", { class: "phrase" }, words.map((word) => h("li", {}, word)));
        body.replaceChildren(
          list,
          h("button", { class: "btn btn-secondary", type: "button", onclick: () => {
            const pk = ethers.Wallet.fromPhrase(w.mnemonic).privateKey;
            copyText(pk);
          } }, "Copy private key"),
          h("p", { class: "hint" }, "Paste the private key into MetaMask (Import account) to use this money there."),
          h("button", { class: "btn btn-ghost", type: "button", onclick: () => renderWallet(true) }, "Hide"),
        );
      } }, "I understand, show me"),
      h("button", { class: "btn btn-ghost", type: "button", onclick: () => renderWallet(true) }, "Not now"),
    );
  };
  body.append(h("button", { class: "btn btn-secondary", type: "button", onclick: showPhrase }, "Show my recovery phrase"));
  const bal = h("p", { class: "balance" }, "Balance: …");
  musdRead().balanceOf(w.address).then((b) => bal.replaceChildren("Balance: ", h("strong", {}, fmtMusd(b)))).catch(() => { bal.textContent = "Balance unavailable right now."; });
  walletRoot.replaceChildren(h("section", { class: "card wallet-card" },
    h("h2", {}, headline || "My wallet"),
    bal,
    h("p", { class: "muted small" }, "Address ", h("code", {}, shortAddr(w.address))),
    body,
  ));
}

window.addEventListener("hashchange", start);
start();

// A short burst of Mezo-pink confetti when the money lands.
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.className = "confetti";
  c.setAttribute("aria-hidden", "true");
  document.body.append(c);
  const ctx = c.getContext("2d");
  const W = (c.width = innerWidth), H = (c.height = innerHeight);
  const colours = ["#ff0a5c", "#ff5c93", "#ffffff", "#ffd1e1", "#ffb870"];
  const bits = Array.from({ length: 160 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    c: colours[(Math.random() * colours.length) | 0],
  }));
  const end = performance.now() + 3200;
  (function frame(t) {
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.35; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    }
    if (t < end) requestAnimationFrame(frame); else c.remove();
  })(performance.now());
}
