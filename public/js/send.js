import {
  APPNAME, ESCROW_ADDRESS_V2, MUSD, ERC20_ABI, STORE, STATUS, MAX_NOTE_BYTES, PERMIT_TYPES,
  MUSD_PERMIT_DOMAIN, V2_LINK_PREFIX, WITHDRAW_MUSD_DOMAIN, WITHDRAW_MUSD_TYPES,
} from "./config.js";
import { CREATE_FOR_TYPES, envelopeV2Domain, quoteLocal } from "./abi-v2.js";
import { loanHealth, pct } from "./loan-math.js";
import {
  ethers, h, render, busy, notice, applyAppName, markNav, walletGate, onWalletChange, ensureChain, getSigner,
  isRejected, musdRead, mezoRead, readProvider, fmtMusd, fmtUsd, fmtUsdShort, copyText, whatsappUrl, save, remove,
  saveSentLink, ERRORS, v2Configured, escrowAddressFor, escrowAbiFor, escrowReadFor,
} from "./common.js";

const root = document.getElementById("app");
applyAppName("Send");
markNav("send");

const INTRO = "Send dollars to anyone with just a link.";
let draft = { amount: "", note: "", name: "", method: "musd" };

// New envelopes go to V2 once it is deployed; until then, to V1 (no fee).
// V2 fee model: the sender pays 0.5% on top (rounded up); the recipient gets exactly the amount typed.
const sendVersion = () => (v2Configured() ? 2 : 1);
const linkUrl = (v, id, pk) => `${location.origin}/c#${v === 2 ? V2_LINK_PREFIX : ""}${id}.${pk.slice(2)}`;

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
const quote = (amt) => (sendVersion() === 2 ? quoteLocal(amt) : { total: amt, fee: 0n });
// Authoritative fee from the contract for signing; falls back to the same maths locally.
async function envelopeFee(v, amount) {
  if (v !== 2) return 0n;
  try { return await escrowReadFor(2).feeFor(amount); } catch { return quoteLocal(amount).fee; }
}
// Largest amount whose amount + fee fits in `bal`.
function maxSendable(bal) {
  if (sendVersion() !== 2) return bal;
  let a = (bal * 10_000n) / 10_050n;
  while (a > 0n && quoteLocal(a).total > bal) a -= 1n;
  return a;
}

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

// ---------- the sender's Mezo loan (trove) ----------
// Returns null when there is no active loan, V2 isn't deployed, or the read fails (the MUSD path still works).
async function readLoan(account) {
  if (!v2Configured()) return null;
  try {
    const tm = mezoRead("troveManager");
    if (Number(await tm.getTroveStatus(account)) !== 1) return null;
    const price = await mezoRead("priceFeed").fetchPrice();
    const [icrNow, dc, recovery] = await Promise.all([tm.getCurrentICR(account, price), tm.getEntireDebtAndColl(account), tm.checkRecoveryMode(price)]);
    return { price, icrNow, coll: dc.coll, debt: dc.principal + dc.interest, recovery };
  } catch {
    return null;
  }
}

// Mezo's one-time borrowing fee for an amount, cached so typing doesn't hammer the RPC.
const feeCache = new Map();
let feeTimer = null;
function borrowingFee(amount, onReady) {
  const k = amount.toString();
  if (feeCache.has(k)) return feeCache.get(k);
  clearTimeout(feeTimer);
  feeTimer = setTimeout(async () => {
    try { feeCache.set(k, await mezoRead("borrowerOperations").getBorrowingFee(amount)); onReady(); } catch { /* shown as unavailable */ }
  }, 250);
  return null;
}

const pctText = (icr) => { const p = pct(icr); return p === Infinity ? "No debt" : `${p.toFixed(1)}%`; };
const usdPrice = (wei) => "$" + Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 });

// Health meter: 100% at the left edge, 200%+ at the right.
const meterPos = (p) => Math.max(0, Math.min(100, (p - 100)));
function meter(icrNow, icrAfter, level) {
  const now = pct(icrNow), after = icrAfter === null ? null : pct(icrAfter);
  const tick = (at, label, cls) => h("span", { class: `meter-tick ${cls}`, style: `left:${meterPos(at)}%` }, h("span", {}, label));
  const label = `Loan health now ${pctText(icrNow)}` + (after === null ? "" : `, after this ${pctText(icrAfter)}`) +
    ". Mezo liquidates at 110%, our floor is 120%, Mezo recommends 150% or more.";
  return h("div", { class: "meter-wrap", role: "img", "aria-label": label },
    h("div", { class: "meter" },
      h("span", { class: "meter-zone z-liq", style: "left:0;width:10%" }),
      h("span", { class: "meter-zone z-block", style: "left:10%;width:10%" }),
      h("span", { class: "meter-zone z-risky", style: "left:20%;width:30%" }),
      h("span", { class: "meter-zone z-safe", style: "left:50%;width:50%" }),
      tick(110, "110%", "t-below"), tick(120, "120%", "t-above"), tick(150, "150%", "t-below"),
      h("span", { class: "meter-dot dot-now", style: `left:${meterPos(now)}%`, title: `Now ${pctText(icrNow)}` }),
      after === null ? null : h("span", { class: `meter-dot dot-after lvl-${level}`, style: `left:${meterPos(after)}%`, title: `After ${pctText(icrAfter)}` }),
    ),
    h("ul", { class: "meter-legend" },
      h("li", {}, h("i", { class: "k-liq" }), "110% Mezo sells Bitcoin"),
      h("li", {}, h("i", { class: "k-block" }), "120% our safety floor"),
      h("li", {}, h("i", { class: "k-safe" }), "150% Mezo recommends")),
  );
}

const STATUS_TEXT = {
  safe: (drop) => ["Safe", `Your loan stays healthy. Bitcoin could fall about ${drop}% before Mezo would sell any of it.`],
  risky: (drop) => ["Risky: this loan is close to liquidation", `If Bitcoin falls about ${drop}%, Mezo could sell some of your Bitcoin to repay the loan. A smaller amount is safer.`],
  blocked: () => ["Blocked: would put your Bitcoin at risk", "This would take your loan below our 120% safety floor, so we won't send it. Try a smaller amount, or add Bitcoin to your loan at mezo.org."],
};

function loanCard(loan, amt, fee) {
  const health = amt && fee !== null ? loanHealth({ ...loan, amount: amt, fee, recoveryMode: loan.recovery }) : null;
  const level = health?.level || (loan.recovery ? "blocked" : null);
  const status = loan.recovery
    ? ["Blocked: Mezo is in recovery mode", "Mezo has paused new borrowing for a while to keep everyone's Bitcoin safe. Pay with MUSD instead, or try again later."]
    : health ? STATUS_TEXT[health.level]((health.dropToLiquidation / 100).toFixed(0)) : null;
  return h("div", { class: "loan-card", "aria-live": "polite" },
    h("div", { class: "row-between" }, h("p", { class: "loan-title" }, "Your Bitcoin loan"), h("span", { class: "tag tag-ink" }, "3 signatures, $0 gas")),
    h("div", { class: "loan-stats" },
      h("div", {}, h("small", {}, "BTC price"), h("b", {}, usdPrice(loan.price))),
      h("div", {}, h("small", {}, "Health now"), h("b", {}, pctText(loan.icrNow))),
      h("div", {}, h("small", {}, "After this"), h("b", { class: level ? `lvl-${level}` : "" }, health ? pctText(health.icrAfter) : (amt ? "…" : "—"))),
    ),
    meter(loan.icrNow, health ? health.icrAfter : null, level),
    status ? h("div", { class: `health-status lvl-${level}`, role: level === "blocked" ? "alert" : "status" },
      h("b", {}, status[0]), h("p", {}, status[1])) : h("p", { class: "loan-hint" }, "Enter an amount to see how it changes your loan."),
  );
}

async function showForm(account, errorText) {
  render(root, busy("Checking your balance..."));
  let musdBal, btcBal, loan;
  try {
    [musdBal, btcBal, loan] = await Promise.all([musdRead().balanceOf(account), readProvider().getBalance(account), readLoan(account)]);
  } catch {
    return render(root, notice("error", ERRORS.Network,
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => showForm(account) }, "Try again")));
  }
  if (!loan) draft.method = "musd";
  const v = sendVersion();

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
  const summary = h("div", { class: "summary" });
  const loanBox = h("div", {});
  const balTag = h("span", { class: "tag" }, `Balance ${fmtMusd(musdBal)}`);
  const chips = [5, 20, 50, 100, 250].map((n) => h("button", { class: "amt-chip", type: "button", onclick: () => { amountIn.value = String(n); validate(); } }, `$${n}`));
  const maxChip = h("button", { class: "amt-chip", type: "button", onclick: () => {
    amountIn.value = ethers.formatUnits(maxSendable(musdBal), 18).replace(/\.0$/, ""); validate(); } }, "Max");

  // Payment method: only offered when the wallet has an active Mezo loan.
  const radio = (value, title, sub) => h("label", { class: "pay-opt" },
    h("input", { type: "radio", name: "pay", value, checked: draft.method === value, onchange: () => { draft.method = value; validate(); } }),
    h("span", { class: "pay-dot", "aria-hidden": "true" }),
    h("span", {}, h("b", {}, title), h("small", {}, sub)));
  const methods = loan ? h("fieldset", { class: "pay-methods" },
    h("legend", { class: "step" }, "How do you want to pay?"),
    radio("musd", "Pay with my MUSD", `From your balance of ${fmtMusd(musdBal)}`),
    radio("btc", "Pay from my Bitcoin", "Borrow against your BTC on Mezo · $0 gas"),
  ) : null;

  const row = (label, value, cls) => h("div", { class: `sum-row ${cls || ""}` }, h("span", {}, label), value);

  function validate() {
    const btc = draft.method === "btc" && !!loan;
    draft = { ...draft, amount: amountIn.value, note: noteIn.value, name: nameIn.value };
    const nb = noteBytes(noteIn.value);
    counter.textContent = `${nb} / ${MAX_NOTE_BYTES}`;
    counter.classList.toggle("over", nb > MAX_NOTE_BYTES);
    const amt = parseAmount(amountIn.value);
    chips.forEach((c) => c.classList.toggle("on", amt !== null && c.textContent === `$${ethers.formatUnits(amt, 18).replace(/\.0$/, "")}`));
    maxChip.hidden = btc;
    balTag.textContent = btc ? "From your Bitcoin" : `Balance ${fmtMusd(musdBal)}`;
    msg.replaceChildren();
    let ok = amt !== null && nb <= MAX_NOTE_BYTES;

    const { total, fee } = amt ? quote(amt) : { total: 0n, fee: 0n };
    if (!btc) {
      if (btcBal === 0n) {
        msg.append(notice("warn", "You need a little test BTC for the network fee. Get some free at faucet.test.mezo.org.",
          h("a", { href: "https://faucet.test.mezo.org", target: "_blank", rel: "noopener noreferrer" }, "Open the faucet")));
        ok = false;
      }
      if (amt !== null && total > musdBal) {
        msg.append(notice("warn", `You only have ${fmtMusd(musdBal)}` + (fee > 0n ? `, and this costs ${fmtUsd(total)} with the fee.` : ".") + (loan ? " You can pay from your Bitcoin instead." : " Get test MUSD at testnet.mezo.org."),
          loan ? null : h("a", { href: "https://testnet.mezo.org", target: "_blank", rel: "noopener noreferrer" }, "Open testnet.mezo.org")));
        ok = false;
      }
    }

    const sendRow = row("You send", h("span", {}, amt ? fmtUsd(amt) : "$0.00"));
    const feeRow = v === 2 ? row("Fee (0.5%, pays the gas)", h("span", {}, amt ? fmtUsd(fee) : "$0.00")) : null;
    const receiveRow = row("They receive", h("strong", { class: "sum-big" }, amt ? fmtUsd(amt) : "$0.00"));
    if (btc) {
      if (amt !== null && amt < 10n ** 18n) { msg.append(notice("warn", "Please send at least $1 from your Bitcoin.")); ok = false; }
      // We borrow amount + envelope fee; Mezo adds its one-time borrowing fee on that to the loan.
      const bFee = amt ? borrowingFee(total, validate) : null;
      loanBox.replaceChildren(loanCard(loan, amt ? total : null, bFee));
      if (amt && bFee === null) ok = false; // still fetching Mezo's fee
      if (loan.recovery) ok = false;
      if (amt && bFee !== null && loanHealth({ ...loan, amount: total, fee: bFee, recoveryMode: loan.recovery }).level === "blocked") ok = false;
      summary.replaceChildren(
        sendRow,
        feeRow,
        row("Mezo borrowing fee (one-time)", h("span", {}, amt ? (bFee === null ? "…" : fmtUsd(bFee)) : "$0.00")),
        row("Network fees", h("span", { class: "ok" }, "$0 (we pay them)")),
        row("Added to your Bitcoin loan", h("strong", { class: "sum-total" }, amt && bFee !== null ? fmtUsd(total + bFee) : "$0.00"), "sum-total-row"),
        receiveRow,
      );
    } else {
      loanBox.replaceChildren();
      summary.replaceChildren(
        sendRow,
        feeRow,
        row("Your network fee", h("span", {}, "Under $0.01 in test BTC")),
        row("You pay", h("strong", { class: "sum-total" }, amt ? fmtUsd(total) : "$0.00"), "sum-total-row"),
        receiveRow,
      );
    }
    if (v === 2) summary.append(h("p", { class: "fee-note" }, "The 0.5% fee pays the network fee when they claim, so they get every cent you send, with nothing to pay."));

    sendBtn.disabled = !ok;
    const shown = amt ? fmtUsdShort(amt) : "";
    sendBtn.textContent = !(amt && ok) ? (btc ? "Sign and send" : "Create link") : btc ? `Sign 3 times & send ${shown}` : `Create ${shown} link`;
    preview.replaceChildren(voucher({ amount: amt ? fmtUsdShort(amt) : "$0.00", name: nameIn.value.trim(), note: noteIn.value.trim() }));
    return ok ? amt : null;
  }
  for (const el of [amountIn, noteIn, nameIn]) el.addEventListener("input", validate);

  const form = h("form", { class: "card send-card", novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    const amt = validate();
    if (!amt) return;
    if (draft.method === "btc" && loan) doSendFromBitcoin(account, amt, noteIn.value.trim(), nameIn.value.trim());
    else doSend(account, amt, noteIn.value.trim(), nameIn.value.trim());
  } },
    errorText ? notice("error", errorText) : null,
    methods,
    h("div", { class: "step-head" }, h("p", { class: "step" }, "Step 1 · Enter amount"), balTag),
    h("div", { class: "amount-box" },
      h("div", { class: "amount-row" }, h("span", { class: "amount-prefix", "aria-hidden": "true" }, "$"), amountIn, h("span", { class: "amount-unit" }, "USD")),
      h("div", { class: "chips" }, ...chips, maxChip),
    ),
    loanBox,
    h("div", { class: "step-head" }, h("p", { class: "step" }, "Step 2 · Recipient & note"), h("span", { class: "muted small" }, "Shown when they open the link")),
    h("label", { for: "who", class: "field-label" }, h("span", {}, "Who is this for?"), h("span", { class: "muted" }, "Only in your message, never on-chain")),
    nameIn,
    h("label", { for: "note", class: "field-label" }, h("span", {}, "Personal note"), counter),
    noteIn,
    h("p", { class: "hint" }, "Notes are public on the blockchain."),
    summary,
    h("div", { class: "refund-box" },
      h("p", {}, h("strong", {}, "7-day auto-refund"), h("span", { class: "tag tag-warn" }, "Held by the contract")),
      h("p", {}, "If they don't claim it within 7 days, you can take it back from Sent links. Nobody else can."),
    ),
    msg,
    sendBtn,
  );
  render(root, form);
  showAccount(account);
  validate();
  if (!errorText) amountIn.focus();
}

// Finds our Created event in a receipt.
function createdId(receipt, address, abi) {
  const iface = new ethers.Interface(abi);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    try { const p = iface.parseLog(log); if (p?.name === "Created") return { id: p.args.id, amount: p.args.amount }; } catch { /* not ours */ }
  }
  return null;
}

// ---------- Pay with my MUSD ----------
async function doSend(account, amount, note, name = "") {
  const amtText = fmtMusd(amount);
  const v = sendVersion();
  const escrowAddr = escrowAddressFor(v);
  try {
    await ensureChain();
    const signer = await getSigner();
    const from = ethers.getAddress(await signer.getAddress());
    if (from !== account) account = from;
    const escrow = new ethers.Contract(escrowAddr, escrowAbiFor(v), signer);
    const musd = new ethers.Contract(MUSD, ERC20_ABI, signer);

    // One-time link key. Only its address goes on-chain. Saved first so a crash can't lose it.
    const linkKey = ethers.Wallet.createRandom();
    save(STORE.pendingKey, { pk: linkKey.privateKey, link: linkKey.address, sender: account, amount: amount.toString(), note, v, at: Date.now() });

    // V2 pulls amount + fee, so approvals and permits cover the total.
    const fee = await envelopeFee(v, amount);
    const total = amount + fee;
    const allowance = await musdRead().allowance(account, escrowAddr);
    let tx;
    if (allowance >= total) {
      render(root, busy(`Locking your ${amtText} into a link...`));
      tx = await escrow.create(linkKey.address, amount, note);
    } else {
      let permitSig = null;
      render(root, busy(`Please confirm in your wallet. This lets ${APPNAME} move exactly ${fmtMusd(total)}.`));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      try {
        const nonce = await musdRead().nonces(account);
        permitSig = await signer.signTypedData(MUSD_PERMIT_DOMAIN, PERMIT_TYPES,
          { owner: account, spender: escrowAddr, value: total, nonce, deadline });
      } catch (e) {
        if (isRejected(e)) throw e;
        permitSig = null; // fall back to approve
      }
      if (permitSig) {
        const { v: pv, r, s } = ethers.Signature.from(permitSig);
        render(root, busy(`Locking your ${amtText} into a link...`));
        tx = await escrow.createWithPermit(linkKey.address, amount, note, deadline, pv, r, s);
      } else {
        render(root, busy("Step 1 of 2: approving..."));
        const atx = await musd.approve(escrowAddr, total);
        await atx.wait();
        render(root, busy("Step 2 of 2: sending..."));
        tx = await escrow.create(linkKey.address, amount, note);
      }
    }
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("tx failed");
    const created = createdId(receipt, escrowAddr, escrowAbiFor(v));
    if (!created) throw new Error("no Created log");

    finish(account, { v, id: created.id, amount: created.amount, fee, pk: linkKey.privateKey, note, name, hash: receipt.hash });
  } catch (e) {
    showForm(account, isRejected(e) ? ERRORS.Cancelled : ERRORS.SendFailed);
  }
}

// ---------- Pay from my Bitcoin: 3 signatures, $0 gas ----------
function progress(step, amtText, borrowText = amtText) {
  const item = (n, title, sub) => h("li", { class: step > n ? "on" : step === n ? "now" : "" }, h("b", {}, title), h("span", {}, sub));
  return h("section", { class: "card center progress-card", role: "status", "aria-live": "polite" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    h("p", { class: "lead" }, step === 1 ? "Borrowing against your Bitcoin…" : "Creating your envelope…"),
    h("ol", { class: "timeline progress-steps" },
      item(1, "Borrow from Mezo", `${borrowText} lands in your own wallet first`),
      item(2, "Lock it into a link", "Held by the Envelope contract, not by us")),
    h("p", { class: "muted small" }, "This takes about 15 seconds. We pay the network fees."),
  );
}

async function doSendFromBitcoin(account, amount, note, name = "") {
  const amtText = fmtUsdShort(amount);
  const escrowAddr = ESCROW_ADDRESS_V2;
  let poll = null;
  try {
    await ensureChain();
    const signer = await getSigner();
    const from = ethers.getAddress(await signer.getAddress());
    if (from !== account) account = from;

    const linkKey = ethers.Wallet.createRandom();
    save(STORE.pendingKey, { pk: linkKey.privateKey, link: linkKey.address, sender: account, amount: amount.toString(), note, v: 2, at: Date.now() });

    render(root, busy("Getting your signatures ready..."));
    const rp = readProvider();
    const [mezoNonce, musdNonce, envNonce, block, fee] = await Promise.all([
      mezoRead("borrowerOpsSignatures").getNonce(account), musdRead().nonces(account),
      escrowReadFor(2).nonces(account), rp.getBlock("latest"), envelopeFee(2, amount),
    ]);
    const deadline = BigInt(block.timestamp) + 1800n; // 30 minutes, chain time
    const total = amount + fee; // borrowed and pulled; the recipient gets exactly `amount`
    const totalText = fmtUsd(total);

    render(root, busy(`Signature 1 of 3: let Mezo lend you ${totalText} against your Bitcoin (${amtText} plus the 0.5% fee). It goes to your own wallet.`));
    const mezoSig = await signer.signTypedData(WITHDRAW_MUSD_DOMAIN, WITHDRAW_MUSD_TYPES,
      { amount: total, borrower: account, recipient: account, nonce: mezoNonce, deadline });

    render(root, busy(`Signature 2 of 3: let ${APPNAME} move exactly ${totalText} of it.`));
    const permitSig = await signer.signTypedData(MUSD_PERMIT_DOMAIN, PERMIT_TYPES,
      { owner: account, spender: escrowAddr, value: total, nonce: musdNonce, deadline });

    render(root, busy("Signature 3 of 3: confirm the envelope and its note."));
    const noteHash = ethers.keccak256(ethers.toUtf8Bytes(note));
    const authSig = await signer.signTypedData(envelopeV2Domain(escrowAddr), CREATE_FOR_TYPES,
      { sender: account, link: linkKey.address, amount, noteHash, nonce: envNonce, deadline });

    // Real progress: step 2 starts when Mezo has used our signature (its nonce moves on).
    render(root, progress(1, amtText, totalText));
    poll = setInterval(async () => {
      try {
        if ((await mezoRead("borrowerOpsSignatures").getNonce(account)) > mezoNonce) { clearInterval(poll); poll = null; render(root, progress(2, amtText, totalText)); }
      } catch { /* try again */ }
    }, 2500);

    const { v: pv, r, s } = ethers.Signature.from(permitSig);
    let res, body;
    try {
      res = await fetch("/api/borrow-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: account, amount: amount.toString(), link: linkKey.address, note, noteHash,
          mezoSig, mezoDeadline: deadline.toString(),
          permit: { v: pv, r, s, deadline: deadline.toString() },
          authSig, authDeadline: deadline.toString(),
        }),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      body = { error: "We lost the connection. If your loan changed, the money is safe in your own wallet. Check Sent links before trying again." };
    }
    if (poll) { clearInterval(poll); poll = null; }

    if (!res?.ok || !body.ok) {
      if (body.code === "CreateFailedAfterBorrow") draft.method = "musd"; // the money is in their wallet now
      return showForm(account, body.error || ERRORS.SendFailed);
    }

    let id = body.id;
    if (!id) { // the relayer didn't wait long enough: wait for the envelope ourselves
      render(root, progress(2, amtText, totalText));
      const rc = await rp.waitForTransaction(body.createTx, 1, 90_000);
      const created = rc && rc.status === 1 ? createdId(rc, escrowAddr, escrowAbiFor(2)) : null;
      if (!created) return showForm(account, "We borrowed the money for you and it's safe in your own wallet, but we couldn't confirm the envelope. Check Sent links before trying again.");
      id = created.id;
    }
    finish(account, { v: 2, id: BigInt(id), amount, fee, pk: linkKey.privateKey, note, name, hash: body.createTx, borrowTx: body.borrowTx });
  } catch (e) {
    if (poll) clearInterval(poll);
    showForm(account, isRejected(e) ? ERRORS.BorrowCancelled : ERRORS.SendFailed);
  }
}

function finish(account, { v, id, amount, fee, pk, note, name, hash, borrowTx }) {
  const url = linkUrl(v, id, pk);
  saveSentLink(account, { v, id: id.toString(), url, amount: amount.toString(), note, createdAt: Date.now() });
  remove(STORE.pendingKey);
  draft = { amount: "", note: "", name: "", method: draft.method };
  showDone(account, { amount, fee, note, url, hash, id, name, v, borrowTx });
}

function showDone(account, { amount, fee, note, url, hash, id, name, v, borrowTx }) {
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
      fee > 0n ? h("p", { class: "fee-line" }, `They get the full ${amt}. You paid ${fmtUsd(amount + fee)}: the 0.5% fee (${fmtUsd(fee)}) pays for their free claim.`) : null,
      borrowTx ? h("p", { class: "fee-line" }, "Paid from your Bitcoin: borrowed on Mezo, with $0 in network fees. ",
        h("a", { href: `https://explorer.test.mezo.org/tx/${borrowTx}`, target: "_blank", rel: "noopener noreferrer" }, "See the loan")) : null,
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
  watch(id, v);
}

// Connected wallet, shown in the header so it's clear you're signed in.
function showAccount(account) {
  const bar = document.querySelector(".top-in");
  if (!bar) return;
  bar.querySelector(".acct")?.remove();
  bar.append(h("span", { class: "acct", title: account }, h("span", { class: "acct-dot", "aria-hidden": "true" }), `Connected ${account.slice(0, 6)}…${account.slice(-4)}`,
    h("button", { class: "acct-out", type: "button", onclick: disconnect }, "Disconnect")));
}

// Drops this site's permission in MetaMask, so the next visit asks to connect again.
async function disconnect() {
  stopWatch();
  try { await window.ethereum.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* older wallets: just reload */ }
  location.reload();
}

let watcher = null;
function stopWatch() { if (watcher) clearInterval(watcher); watcher = null; }
function watch(id, v) {
  stopWatch();
  const started = Date.now();
  watcher = setInterval(async () => {
    const left = 7 * 86400 * 1000 - (Date.now() - started);
    const cd = document.getElementById("countdown");
    if (cd) cd.textContent = `${Math.floor(left / 86400000)}d ${Math.floor(left / 3600000) % 24}h ${Math.floor(left / 60000) % 60}m left`;
    try {
      const [d] = await escrowReadFor(v).getDeposit(id);
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
