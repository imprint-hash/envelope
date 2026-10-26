import { ESCROW_ADDRESS, ESCROW_ABI, STORE, STATUS } from "./config.js";
import {
  ethers, h, render, busy, notice, applyAppName, markNav, walletGate, onWalletChange, ensureChain, getSigner,
  isRejected, escrowRead, latestTimestamp, fmtUsd, fmtUsdShort, fmtDate, timeLeft, copyText, whatsappUrl,
  load, remove, sentLinksFor, saveSentLink, ERRORS,
} from "./common.js";

const root = document.getElementById("app");
applyAppName("My links");
markNav("links");

const INTRO = "See the links you've sent.";

function start() {
  walletGate(root, { intro: INTRO, onReady: showLinks });
}

async function showLinks(account) {
  render(root, busy("Loading your links..."));
  let rows, now;
  try {
    const escrow = escrowRead();
    const [ids, ts] = await Promise.all([escrow.idsOf(account), latestTimestamp()]);
    now = ts;
    rows = await Promise.all([...ids].map(async (id) => {
      const [d, note] = await escrow.getDeposit(id);
      return { id, d, note };
    }));
  } catch {
    return render(root, notice("error", ERRORS.Network,
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => showLinks(account) }, "Try again")));
  }

  // Recover a link whose tx landed but whose page closed before the URL was saved.
  const pending = load(STORE.pendingKey, null);
  if (pending?.link && pending?.pk) {
    const hit = rows.find((r) => ethers.getAddress(r.d.link) === ethers.getAddress(pending.link));
    if (hit) {
      saveSentLink(account, {
        id: hit.id.toString(), url: `${location.origin}/c#${hit.id}.${pending.pk.slice(2)}`,
        amount: hit.d.amount.toString(), note: hit.note, createdAt: pending.at || Date.now(),
      });
      remove(STORE.pendingKey);
    }
  }
  const urls = new Map(sentLinksFor(account).map((l) => [String(l.id), l.url]));

  if (rows.length === 0) {
    return render(root, h("section", { class: "card center" },
      h("h1", {}, "You haven't sent any links yet."),
      h("a", { class: "btn btn-primary", href: "/" }, "Send money"),
    ));
  }

  rows.sort((a, b) => (b.id > a.id ? 1 : -1));
  render(root,
    h("h1", { class: "page-title" }, "My links"),
    h("ul", { class: "link-list" }, rows.map((r) => row(account, r, now, urls.get(r.id.toString())))),
  );
}

function row(account, { id, d, note }, now, url) {
  const status = Number(d.status);
  const expired = now >= BigInt(d.expiresAt);
  const createdAt = BigInt(d.expiresAt) - 7n * 86400n;
  let chip, actions = [];

  if (status === STATUS.Claimed) chip = h("span", { class: "chip chip-ok" }, "Claimed");
  else if (status === STATUS.Refunded) chip = h("span", { class: "chip chip-muted" }, "Refunded");
  else if (expired) {
    chip = h("span", { class: "chip chip-alert" }, "Ready to take back");
    const btn = h("button", { class: "btn btn-primary", type: "button" }, "Take my money back");
    const out = h("div", {});
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.replaceChildren(busy("Taking your money back..."));
      try {
        await ensureChain();
        const signer = await getSigner();
        const tx = await new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, signer).refund(id);
        const rc = await tx.wait();
        if (!rc || rc.status !== 1) throw new Error("failed");
        out.replaceChildren(notice("ok", `Done. ${fmtUsdShort(d.amount)} is back in your wallet.`));
        btn.remove();
        chip.className = "chip chip-muted"; chip.textContent = "Refunded";
      } catch (e) {
        btn.disabled = false;
        out.replaceChildren(notice("error", isRejected(e) ? "You cancelled. Nothing changed." : "That didn't go through. Your money is still safe in the link. Please try again."));
      }
    });
    actions = [btn, out];
  } else {
    chip = h("span", { class: "chip chip-wait" }, "Waiting");
    if (url) {
      actions = [h("div", { class: "row-actions" },
        h("button", { class: "btn btn-secondary btn-small", type: "button", onclick: () => copyText(url) }, "Copy link"),
        h("a", { class: "btn btn-secondary btn-small", href: whatsappUrl(d.amount, note, url), target: "_blank", rel: "noopener noreferrer" }, "Share"),
      )];
    } else {
      actions = [h("p", { class: "hint" }, "Link saved on another device")];
    }
  }

  return h("li", { class: "card link-row" },
    h("div", { class: "row-between" }, h("strong", { class: "row-amount" }, fmtUsd(d.amount)), chip),
    note ? h("p", { class: "note-quote small" }, `“${note}”`) : null,
    h("p", { class: "muted small" },
      `Sent ${fmtDate(createdAt)} · `,
      status === STATUS.Open && !expired ? timeLeft(d.expiresAt, now) : `Expiry ${fmtDate(d.expiresAt)}`),
    ...actions,
  );
}

onWalletChange(() => start());
start();
