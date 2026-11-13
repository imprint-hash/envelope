// Loan-health maths for "Pay from my Bitcoin". Pure BigInt, 18-decimal fixed point (1e18 = 100%).
// Shared by the send page and api/borrow-send.mjs so the screen and the relayer always agree.

export const ONE = 10n ** 18n;
export const MCR = 110n * 10n ** 16n;          // 110%: Mezo liquidates below this
export const SAFETY_FLOOR = 120n * 10n ** 16n; // 120%: Envelope refuses to borrow below this
export const CCR = 150n * 10n ** 16n;          // 150%: Mezo's recommended level (recovery-mode line)

// Same formula as Mezo's LiquityMath._computeCR: coll * price / debt. No debt = infinitely healthy.
export function computeICR(coll, debt, price) {
  if (debt <= 0n) return 2n ** 256n - 1n;
  return (coll * price) / debt;
}

/**
 * Where the loan would be after borrowing `amount` (plus Mezo's one-time borrowing `fee`).
 * coll and debt come from TroveManager.getEntireDebtAndColl: debt = principal + interest.
 * Returns { icrNow, icrAfter, debtAfter, level, dropToLiquidation } where level is
 * "safe" (>= 150%), "risky" (120% to 150%) or "blocked" (< 120%, or recovery mode).
 */
export function loanHealth({ coll, debt, price, amount, fee, recoveryMode = false }) {
  const icrNow = computeICR(coll, debt, price);
  const debtAfter = debt + amount + fee;
  const icrAfter = computeICR(coll, debtAfter, price);
  let level = "safe";
  if (recoveryMode || icrAfter < SAFETY_FLOOR) level = "blocked";
  else if (icrAfter < CCR) level = "risky";
  // How far BTC could fall (in basis points) before this loan hits 110%.
  const dropToLiquidation = icrAfter > MCR ? Number(((icrAfter - MCR) * 10_000n) / icrAfter) : 0;
  return { icrNow, icrAfter, debtAfter, level, dropToLiquidation };
}

// 1.2738e18 -> 127.4 (a percent with one decimal), for display.
export function pct(icr) {
  if (icr >= 10n ** 30n) return Infinity;
  return Number((icr * 1000n) / ONE) / 10;
}
