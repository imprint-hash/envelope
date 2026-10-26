import { APPNAME, ESCROW_ADDRESS, MUSD, ESCROW_ABI, ERC20_ABI, STORE, MAX_NOTE_BYTES, PERMIT_TYPES, MUSD_PERMIT_DOMAIN } from "./config.js";
import {
  ethers, h, render, busy, notice, applyAppName, markNav, walletGate, onWalletChange, ensureChain, getSigner,
  isRejected, musdRead, readProvider, fmtMusd, fmtUsdShort, copyText, whatsappUrl, save, remove, saveSentLink, ERRORS,
} from "./common.js";

const root = document.getElementById("app");
applyAppName("Send");
markNav("send");

const INTRO = "Send dollars to anyone with just a link.";
let draft = { amount: "", note: "" };

function start() {
  walletGate(root, { intro: INTRO, onReady: showForm });
}

function parseAmount(v) {
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s) && !/^\.\d{1,18}$/.test(s)) return null;
  try { const w = ethers.parseUnits(s.startsWith(".") ? "0" + s : s, 18); return w > 0n ? w : null; } catch { return null; }
}
const noteBytes = (s) => new TextEncoder().encode(s).length;

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
    placeholder: "0.00", value: draft.amount, "aria-describedby": "amount-help", class: "amount-input",
  });
  const noteIn = h("input", {
    id: "note", name: "note", type: "text", maxlength: String(MAX_NOTE_BYTES), autocomplete: "off",
    placeholder: "For mum's groceries", value: draft.note, "aria-describedby": "note-help",
  });
  const counter = h("span", { class: "counter", "aria-live": "polite" });
  const msg = h("div", { class: "form-msg" });
  const sendBtn = h("button", { class: "btn btn-primary", type: "submit" }, "Send");

  function validate() {
    draft = { amount: amountIn.value, note: noteIn.value };
    const nb = noteBytes(noteIn.value);
    counter.textContent = `${nb}/${MAX_NOTE_BYTES}`;
    counter.classList.toggle("over", nb > MAX_NOTE_BYTES);
    const amt = parseAmount(amountIn.value);
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
    sendBtn.disabled = !ok;
    sendBtn.textContent = amt && ok ? `Send ${fmtUsdShort(amt)}` : "Send";
    return ok ? amt : null;
  }
  amountIn.addEventListener("input", validate);
  noteIn.addEventListener("input", validate);

  const form = h("form", { class: "card", novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    const amt = validate();
    if (amt) doSend(account, amt, noteIn.value.trim());
  } },
    h("h1", {}, INTRO),
    h("p", { class: "balance" }, "You have ", h("strong", {}, fmtMusd(musdBal))),
    errorText ? notice("error", errorText) : null,
    h("label", { for: "amount", class: "label" }, "Amount (digital dollars)"),
    h("div", { class: "amount-row" },
      h("span", { class: "amount-prefix", "aria-hidden": "true" }, "$"),
      amountIn,
      h("button", { class: "btn btn-chip", type: "button", onclick: () => {
        amountIn.value = ethers.formatUnits(musdBal, 18).replace(/\.0$/, ""); validate(); amountIn.focus();
      } }, "Max"),
    ),
    h("p", { id: "amount-help", class: "hint" }, "1 MUSD is worth 1 US dollar."),
    h("label", { for: "note", class: "label" }, "Note ", h("span", { class: "muted" }, "(optional)")),
    noteIn,
    h("p", { id: "note-help", class: "hint row-between" }, h("span", {}, "Notes are public on the blockchain."), counter),
    msg,
    sendBtn,
  );
  render(root, form);
  validate();
  if (!errorText) amountIn.focus();
}

async function doSend(account, amount, note) {
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
        render(root, busy(`Locking your ${amtText} into a link...`));
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
    draft = { amount: "", note: "" };
    showDone(account, amount, note, url, receipt.hash);
  } catch (e) {
    showForm(account, isRejected(e) ? ERRORS.Cancelled : ERRORS.SendFailed);
  }
}

function showDone(account, amount, note, url, hash) {
  const linkBox = h("input", { class: "link-box", type: "text", readonly: true, value: url, "aria-label": "Your claim link", onfocus: (e) => e.target.select() });
  render(root, h("section", { class: "card done" },
    h("p", { class: "eyebrow" }, `${fmtUsdShort(amount)} locked`),
    h("h1", {}, "Your link is ready."),
    note ? h("p", { class: "note-quote" }, `“${note}”`) : null,
    linkBox,
    h("div", { class: "stack" },
      h("a", { class: "btn btn-primary btn-whatsapp", href: whatsappUrl(amount, note, url), target: "_blank", rel: "noopener noreferrer" }, "Share on WhatsApp"),
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => copyText(url, linkBox) }, "Copy link"),
    ),
    notice("warn", "Anyone with this link can claim the money. Only share it with the person you're paying. If it isn't claimed in 7 days, you can take it back."),
    h("p", { class: "hint" }, h("a", { href: `https://explorer.test.mezo.org/tx/${hash}`, target: "_blank", rel: "noopener noreferrer" }, "View on explorer")),
    h("button", { class: "btn btn-ghost", type: "button", onclick: () => showForm(account) }, "Send another"),
  ));
}

onWalletChange(() => start());
start();
