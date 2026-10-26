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
  render(root, h("section", { class: "card ticket" },
    h("div", { class: "ticket-top" },
      h("p", { class: "eyebrow" }, "Someone sent you"),
      h("p", { class: "big-amount", "aria-label": `${fmtUsd(amount)} in digital dollars` }, fmtUsd(amount)),
      h("p", { class: "muted small" }, "in digital dollars (MUSD, 1 MUSD = $1)"),
      note ? h("p", { class: "note-quote" }, `“${note}”`) : null,
      h("p", { class: "chip chip-wait" }, timeLeft(d.expiresAt, now)),
    ),
    h("div", { class: "ticket-bottom" },
      errorText ? notice("error", errorText) : null,
      h("button", { class: "btn btn-primary btn-big", type: "button", "data-autofocus": true,
        onclick: () => doClaim(parsed, d, note, now, "local") }, `Claim my ${fmtUsdShort(amount)}`),
      h("p", { class: "hint center" }, "No app, no sign-up, no fees."),
      hasWallet()
        ? h("button", { class: "btn btn-link", type: "button", onclick: () => doClaim(parsed, d, note, now, "metamask") }, "I already have a wallet (MetaMask)")
        : null,
    ),
  ), h("p", { class: "hint center" }, "Tip: open in Chrome or Safari to keep your wallet."));
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
  if (mode === "local") renderWallet(true, "Keep this money safe: save your recovery phrase.");
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
