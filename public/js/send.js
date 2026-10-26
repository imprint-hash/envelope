import { APPNAME, ESCROW_ADDRESS, MUSD, ESCROW_ABI, ERC20_ABI, STORE, STATUS, MAX_NOTE_BYTES, PERMIT_TYPES, MUSD_PERMIT_DOMAIN } from "./config.js";
import {
  ethers, h, render, busy, notice, applyAppName, markNav, walletGate, onWalletChange, ensureChain, getSigner,
  isRejected, musdRead, escrowRead, readProvider, fmtMusd, fmtUsdShort, copyText, whatsappUrl, save, remove, saveSentLink, ERRORS,
} from "./common.js";

const root = document.getElementById("app");
applyAppName("Send");
markNav("send");

const INTRO = "Send dollars to anyone with just a link.";
let draft = { amount: "", note: "", name: "" };

function start() {
  stopWatch();
  preview.replaceChildren(voucher({ amount: "$50.00", name: "Mum", note: "Happy birthday Mum! Buy yourself something nice.", label: "What they'll see" }));
  walletGate(root, { intro: INTRO, onReady: showForm });
}

function parseAmount(v) {
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s) && !/^\.\d{1,18}$/.test(s)) return null;
  try { const w = ethers.parseUnits(s.startsWith(".") ? "0" + s : s, 18); return w > 0n ? w : null; } catch { return null; }
}
const noteBytes = (s) => new TextEncoder().encode(s).length;

const preview = document.getElementById("preview");

// The voucher the recipient will see, updated as the sender types.
function voucher({ amount, name, note, label = "Live recipient preview", status = "Ready to claim" }) {
  return h("section", { class: "card voucher-card" },
    h("div", { class: "row-between voucher-head" }, h("p", { class: "label-sm" }, label), h("span", { class: "dot-ok" }, "Synced")),
    h("div", { class: "voucher" },
      h("div", { class: "row-between" }, h("span", { class: "v-tag" }, "Dollar envelope"), h("span", { class: "v-tag v-tag-light" }, status)),
      h("p", { class: "v-label" }, "Ready to claim"),
      h("p", { class: "v-amount" }, amount, h("span", {}, "USD")),
      h("p", { class: "v-meta" }, "7 days to claim · No fee to receive"),
    ),
    h("div", { class: "voucher-body" },
      h("p", { class: "label-sm" }, "Recipient"),
      h("p", { class: "v-name" }, name || "Someone special"),
      h("p", { class: "note-quote" }, note ? `“${note}”` : "Your note shows here."),
      h("p", { class: "v-tap" }, "They tap the link to claim instantly"),
    ),
  );
}

async function showForm(account, errorText) {
  render(root, busy("Checking your balance..."));
  let musdBal, btcBal;
  try {
    [musdBal, btcBal] = await Promise.all([musdRead().balanceOf(account), readProvider().getBalance(account)]);
  } catch {
    return render(root, notice("error", ERRORS.Network,
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => showForm(account) }, "Try again")));
  }

  const amountIn = h("input", {
    id: "amount", name: "amount", type: "text", inputmode: "decimal", autocomplete: "off",
    placeholder: "0.00", value: draft.amount, "aria-label": "Amount in US dollars", class: "amount-input",
  });
  const nameIn = h("input", { id: "who", name: "who", type: "text", maxlength: "40", autocomplete: "off", placeholder: "Mum", value: draft.name || "" });
  const noteIn = h("textarea", {
    id: "note", name: "note", maxlength: String(MAX_NOTE_BYTES), rows: "3", autocomplete: "off",
    placeholder: "Happy birthday Mum! Buy yourself something nice.",
  });
  noteIn.value = draft.note;
  const counter = h("span", { class: "counter", "aria-live": "polite" });
  const msg = h("div", { class: "form-msg" });
  const sendBtn = h("button", { class: "btn btn-primary btn-big", type: "submit" }, "Create link");
  const receives = h("strong", { class: "sum-big" }, "$0.00");
  const total = h("strong", { class: "sum-total" }, "$0.00");
  const chips = [5, 20, 50, 100, 250].map((v) => h("button", { class: "amt-chip", type: "button", onclick: () => { amountIn.value = String(v); validate(); } }, `$${v}`));

  function validate() {
    draft = { amount: amountIn.value, note: noteIn.value, name: nameIn.value };
    const nb = noteBytes(noteIn.value);
    counter.textContent = `${nb} / ${MAX_NOTE_BYTES}`;
    counter.classList.toggle("over", nb > MAX_NOTE_BYTES);
    const amt = parseAmount(amountIn.value);
    chips.forEach((c) => c.classList.toggle("on", amt !== null && c.textContent === `$${ethers.formatUnits(amt, 18).replace(/\.0$/, "")}`));
    msg.replaceChildren();
    let ok = true;
    if (btcBal === 0n) {
      msg.append(notice("warn", "You need a little test BTC for the network fee. Get some free at faucet.test.mezo.org.",
        h("a", { href: "https://faucet.test.mezo.org", target: "_blank", rel: "noopener noreferrer" }, "Open the faucet")));
      ok = false;
    }
    if (amt !== null && amt > musdBal) {
      msg.append(notice("warn", `You only have ${fmtMusd(musdBal)}. Get test MUSD at testnet.mezo.org.`,
        h("a", { href: "https://testnet.mezo.org", target: "_blank", rel: "noopener noreferrer" }, "Open testnet.mezo.org")));
      ok = false;
    }
    if (nb > MAX_NOTE_BYTES) ok = false;
    if (amt === null) ok = false;
    const shown = amt ? fmtUsdShort(amt) : "$0.00";
    receives.textContent = shown; total.textContent = shown;
    sendBtn.disabled = !ok;
    sendBtn.textContent = amt && ok ? `Create ${shown} link` : "Create link";
    preview.replaceChildren(voucher({ amount: amt ? fmtUsdShort(amt).replace(/^\$/, "$") : "$0.00", name: nameIn.value.trim(), note: noteIn.value.trim() }));
    return ok ? amt : null;
  }
  for (const el of [amountIn, noteIn, nameIn]) el.addEventListener("input", validate);

  const form = h("form", { class: "card send-card", novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    const amt = validate();
    if (amt) doSend(account, amt, noteIn.value.trim(), nameIn.value.trim());
  } },
    errorText ? notice("error", errorText) : null,
    h("div", { class: "step-head" }, h("p", { class: "step" }, "Step 1 · Enter amount"), h("span", { class: "tag" }, `Balance ${fmtMusd(musdBal)}`)),
    h("div", { class: "amount-box" },
      h("div", { class: "amount-row" }, h("span", { class: "amount-prefix", "aria-hidden": "true" }, "$"), amountIn, h("span", { class: "amount-unit" }, "USD")),
      h("div", { class: "chips" }, ...chips, h("button", { class: "amt-chip", type: "button", onclick: () => {
        amountIn.value = ethers.formatUnits(musdBal, 18).replace(/\.0$/, ""); validate(); } }, "Max")),
    ),
    h("div", { class: "step-head" }, h("p", { class: "step" }, "Step 2 · Recipient & note"), h("span", { class: "muted small" }, "Shown when they open the link")),
    h("label", { for: "who", class: "field-label" }, h("span", {}, "Who is this for?"), h("span", { class: "muted" }, "Only in your message, never on-chain")),
    nameIn,
    h("label", { for: "note", class: "field-label" }, h("span", {}, "Personal note"), counter),
    noteIn,
    h("p", { class: "hint" }, "Notes are public on the blockchain."),
    h("div", { class: "summary" },
      h("div", { class: "sum-row" }, h("span", {}, "They receive"), receives),
      h("div", { class: "sum-row" }, h("span", {}, "Their fee to claim"), h("span", { class: "ok" }, "$0.00 (we cover it)")),
      h("div", { class: "sum-row" }, h("span", {}, "Your network fee"), h("span", {}, "Under $0.01 in test BTC")),
      h("div", { class: "sum-row sum-total-row" }, h("span", {}, "Total from your wallet"), total),
    ),
    h("div", { class: "refund-box" },
      h("p", {}, h("strong", {}, "7-day auto-refund"), h("span", { class: "tag tag-warn" }, "Held by the contract")),
      h("p", {}, "If they don't claim it within 7 days, you can take the full amount back from Sent links. Nobody else can."),
    ),
    msg,
    sendBtn,
    h("p", { class: "trust" }, "Open-source escrow on Mezo · Link works once · No app needed"),
  );
  render(root, form);
  validate();
  if (!errorText) amountIn.focus();
}

async function doSend(account, amount, note, name = "") {
  const amtText = fmtMusd(amount);
  try {
    await ensureChain();
    const signer = await getSigner();
    const from = ethers.getAddress(await signer.getAddress());
    if (from !== account) account = from;
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);
    const musd = new ethers.Contract(MUSD, ERC20_ABI, signer);

    // One-time link key. Only its address goes on-chain. Saved first so a crash can't lose it.
    const linkKey = ethers.Wallet.createRandom();
    save(STORE.pendingKey, { pk: linkKey.privateKey, link: linkKey.address, sender: account, amount: amount.toString(), note, at: Date.now() });

    const allowance = await musdRead().allowance(account, ESCROW_ADDRESS);
    let tx;
    if (allowance >= amount) {
      render(root, busy(`Locking your ${amtText} into a link...`));
      tx = await escrow.create(linkKey.address, amount, note);
    } else {
      let permitSig = null;
      render(root, busy(`Please confirm in your wallet. This lets ${APPNAME} move exactly ${amtText}.`));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      try {
        const nonce = await musdRead().nonces(account);
        permitSig = await signer.signTypedData(MUSD_PERMIT_DOMAIN, PERMIT_TYPES,
          { owner: account, spender: ESCROW_ADDRESS, value: amount, nonce, deadline });
      } catch (e) {
        if (isRejected(e)) throw e;
        permitSig = null; // fall back to approve
      }
      if (permitSig) {
        const { v, r, s } = ethers.Signature.from(permitSig);
        render(root, busy(`Locking your ${amtText} into a link...`));
        tx = await escrow.createWithPermit(linkKey.address, amount, note, deadline, v, r, s);
      } else {
        render(root, busy("Step 1 of 2: approving..."));
        const atx = await musd.approve(ESCROW_ADDRESS, amount);
        await atx.wait();
        render(root, busy("Step 2 of 2: sending..."));
        tx = await escrow.create(linkKey.address, amount, note);
      }
    }
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("tx failed");

    let id = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) continue;
      try {
        const p = escrow.interface.parseLog(log);
        if (p?.name === "Created") { id = p.args.id; break; }
      } catch { /* not ours */ }
    }
    if (id === null) throw new Error("no Created log");

    const url = `${location.origin}/c#${id}.${linkKey.privateKey.slice(2)}`;
    saveSentLink(account, { id: id.toString(), url, amount: amount.toString(), note, createdAt: Date.now() });
    remove(STORE.pendingKey);
    draft = { amount: "", note: "", name: "" };
    showDone(account, amount, note, url, receipt.hash, id, name);
  } catch (e) {
    showForm(account, isRejected(e) ? ERRORS.Cancelled : ERRORS.SendFailed);
  }
}

function showDone(account, amount, note, url, hash, id, name) {
  const amt = fmtUsdShort(amount);
  const linkBox = h("input", { class: "link-input", type: "text", readonly: true, value: url, "aria-label": "Your claim link", onfocus: (e) => e.target.select() });
  const smsText = encodeURIComponent(`I've sent you ${amt} with ${APPNAME}. Tap to claim it, no app or fees needed: ${url}`);
  const share = (cls, href, title, sub, icon) => h("a", { class: `share ${cls}`, href, target: "_blank", rel: "noopener noreferrer" },
    h("span", { class: "share-ic", "aria-hidden": "true" }, icon), h("span", {}, h("b", {}, title), h("small", {}, sub)));

  render(root,
    h("section", { class: "card done-card" },
      h("div", { class: "done-badge" }, h("span", { class: "badge-ic", "aria-hidden": "true" }, "✓"),
        h("div", {}, h("p", { class: "label-ok" }, "Money locked safely"), h("p", { class: "muted small" }, "Held by the Envelope contract on Mezo"))),
      h("h1", { class: "done-title" }, `Your ${amt} link is live and funded!`),
      h("p", { class: "lead muted" }, "Share it with the person you're paying. Whoever opens it can claim the money, with no app and no fees."),
      h("div", { class: "link-panel" },
        h("div", { class: "row-between" }, h("p", { class: "label-sm" }, "Claim link"), h("span", { class: "label-pink" }, "Works once")),
        h("div", { class: "link-row" }, linkBox, h("button", { class: "btn btn-primary btn-copy", type: "button", onclick: () => copyText(url, linkBox) }, "Copy link")),
      ),
      h("p", { class: "field-label" }, h("span", {}, "Share with them")),
      h("div", { class: "share-grid" },
        share("share-wa", whatsappUrl(amount, note, url, name), "Share on WhatsApp", "Best for family abroad", "💬"),
        share("", `sms:?&body=${smsText}`, "Send by SMS", "Standard text message", "✉️"),
        share("", `mailto:?subject=${encodeURIComponent(`${amt} for you`)}&body=${smsText}`, "Email the link", "Straight to their inbox", "📧"),
        share("", `https://explorer.test.mezo.org/tx/${hash}`, "View on explorer", "Proof it's locked on Mezo", "🔎"),
      ),
      h("div", { class: "easy-box" }, h("p", {}, h("strong", {}, "Easy for them: "),
        "they don't need an app, an account or any crypto knowledge. They open the link, tap Claim, and the dollars are theirs.")),
    ),
    h("section", { class: "card guard-card" },
      h("div", { class: "row-between" },
        h("div", {}, h("h2", {}, "7-day refund guard"), h("p", { class: "muted small" }, "Unclaimed money comes back to you")),
        h("span", { class: "tag tag-warn", id: "countdown" }, "7d 0h left")),
      h("p", { class: "muted" }, "If nobody claims it within 7 days, open Sent links and take it back. The contract only ever returns it to your wallet."),
      h("div", { class: "row-actions" },
        h("a", { class: "btn btn-secondary", href: "/links" }, "Sent links"),
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => { stopWatch(); showForm(account); } }, "Send another")),
    ),
  );

  // Right column: what they'll see, and a live status read from the chain.
  const steps = [
    h("li", { class: "on" }, h("b", {}, "Money locked"), h("span", {}, "Just now, on Mezo")),
    h("li", { id: "st-claim" }, h("b", {}, "Waiting for them to claim"), h("span", {}, "We check the chain every few seconds")),
  ];
  preview.replaceChildren(
    voucher({ amount: amt, name, note, label: "What they'll see", status: "Active" }),
    h("section", { class: "card status-card" },
      h("div", { class: "row-between" }, h("h2", {}, "Live status"), h("span", { class: "dot-ok" }, "Watching")),
      h("ol", { class: "timeline" }, ...steps)),
  );
  watch(id);
}

let watcher = null;
function stopWatch() { if (watcher) clearInterval(watcher); watcher = null; }
function watch(id) {
  stopWatch();
  const started = Date.now();
  watcher = setInterval(async () => {
    const left = 7 * 86400 * 1000 - (Date.now() - started);
    const cd = document.getElementById("countdown");
    if (cd) cd.textContent = `${Math.floor(left / 86400000)}d ${Math.floor(left / 3600000) % 24}h ${Math.floor(left / 60000) % 60}m left`;
    try {
      const [d] = await escrowRead().getDeposit(id);
      if (Number(d.status) === STATUS.Claimed) {
        const li = document.getElementById("st-claim");
        if (li) { li.className = "on"; li.replaceChildren(h("b", {}, "Claimed!"), h("span", {}, "The money is in their wallet")); }
        stopWatch();
      }
    } catch { /* try again next tick */ }
  }, 5000);
}

onWalletChange(() => start());
start();
