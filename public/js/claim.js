import { CHAIN, ESCROW_ADDRESS, STORE, STATUS, CLAIM_TYPES } from "./config.js";
import {
  ethers, h, render, busy, notice, applyAppName, escrowConfigured, escrowRead, musdRead, readProvider,
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

function parseHash() {
  const m = location.hash.slice(1).match(/^(\d{1,12})\.([0-9a-fA-F]{64})$/);
  return m ? { id: BigInt(m[1]), pk: "0x" + m[2] } : null;
}

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
  const idOnly = location.hash.slice(1).match(/^(\d{1,12})$/);
  if (!parsed && idOnly) return showAlreadyMine(BigInt(idOnly[1]));
  if (!parsed) return render(root, errorCard(ERRORS.BadInput));
  if (!escrowConfigured()) return render(root, errorCard(ERRORS.NotConfigured));

  render(root, busy("Opening your money..."));
  let d, note, now;
  try {
    const [[dep, n], ts] = await Promise.all([escrowRead().getDeposit(parsed.id), latestTimestamp()]);
    d = dep; note = n; now = ts;
  } catch {
    return render(root, errorCard(ERRORS.Network, start));
  }

  const status = Number(d.status);
  if (status === STATUS.None) return render(root, errorCard(ERRORS.NotFound));
  if (status === STATUS.Claimed) return showClaimed(parsed.id);
  if (status === STATUS.Refunded) return render(root, errorCard("This link has expired and the money went back to the sender."));
  if (now >= BigInt(d.expiresAt)) return render(root, errorCard("This link has expired. The sender can take the money back. Ask them to send a new one."));
  let linkAddr;
  try { linkAddr = new ethers.Wallet(parsed.pk).address; } catch { linkAddr = null; }
  if (!linkAddr || linkAddr !== ethers.getAddress(d.link)) return render(root, errorCard(ERRORS.BadSignature));

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

  render(root, busy("Claiming... this takes a few seconds."));
  let sig;
  try {
    const domain = { name: "LinkEscrow", version: "1", chainId: CHAIN.id, verifyingContract: ESCROW_ADDRESS };
    sig = await new ethers.Wallet(parsed.pk).signTypedData(domain, CLAIM_TYPES, { id: parsed.id, recipient });
  } catch {
    return showReady(parsed, d, note, now, ERRORS.BadSignature);
  }

  let res, body;
  try {
    res = await fetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: parsed.id.toString(), recipient, signature: sig }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    return showReady(parsed, d, note, now, ERRORS.Network);
  }
  if (!res.ok || !body.ok) {
    if (body.code === "AlreadyClaimed") return showClaimed(parsed.id);
    return showReady(parsed, d, note, now, body.error || "Something went wrong on our side. Your money is safe in the link. Please try again in a minute.");
  }

  // Remember this claim on this phone so reopening the link can say "It's in your wallet".
  const claims = load(STORE.claims, {});
  claims[parsed.id.toString()] = { recipient, txHash: body.txHash };
  save(STORE.claims, claims);

  render(root, busy("Almost there... confirming on the network."));
  try {
    const receipt = await readProvider().waitForTransaction(body.txHash, 1, 60000);
    if (receipt && receipt.status !== 1) {
      delete claims[parsed.id.toString()]; save(STORE.claims, claims);
      return showReady(parsed, d, note, now, "That didn't go through. Your money is safe in the link. Please try again.");
    }
  } catch { /* timed out: the tx was broadcast, show success with the explorer link */ }

  history.replaceState(null, "", "/c#" + parsed.id);
  showDone(d.amount, recipient, body.txHash || null, mode);
}

async function balanceLine(addr) {
  const p = h("p", { class: "balance" }, "Wallet balance: …");
  musdRead().balanceOf(addr)
    .then((b) => { p.replaceChildren("Wallet balance: ", h("strong", {}, fmtMusd(b))); })
    .catch(() => { p.textContent = "We couldn't load your balance right now."; });
  return p;
}

async function showDone(amount, recipient, txHash, mode) {
  render(root, h("section", { class: "card done" },
    h("p", { class: "big-amount", "aria-hidden": "true" }, fmtUsd(amount)),
    h("h1", {}, `${fmtUsdShort(amount)} is yours.`),
    await balanceLine(recipient),
    h("p", { class: "muted small" }, "Sent to ", h("code", {}, shortAddr(recipient))),
    txHash ? h("a", { class: "btn btn-secondary", href: `${CHAIN.explorer}/tx/${txHash}`, target: "_blank", rel: "noopener noreferrer" }, "View on explorer") : null,
  ));
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

async function showClaimed(id) {
  const rec = load(STORE.claims, {})[id.toString()];
  if (!rec) return render(root, errorCard(ERRORS.AlreadyClaimed));
  render(root, h("section", { class: "card done" },
    h("h1", {}, "This money has already been claimed."),
    h("p", { class: "lead" }, "It's in your wallet."),
    await balanceLine(rec.recipient),
    rec.txHash ? h("a", { class: "btn btn-secondary", href: `${CHAIN.explorer}/tx/${rec.txHash}`, target: "_blank", rel: "noopener noreferrer" }, "View on explorer") : null,
  ));
}

async function showAlreadyMine(id) {
  // URL is "/c#<id>" after a successful claim (key already removed).
  const rec = load(STORE.claims, {})[id.toString()];
  if (!rec) return render(root, errorCard(ERRORS.BadInput));
  return showClaimed(id);
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
