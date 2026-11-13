// Regression tests for the Wave 2 pressure-test findings (13 Nov 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes } from "ethers";
import { validateInput } from "../../api/borrow-send.mjs";
import { parseClaimInput } from "../../api/claim.mjs";

const NOW = 1_700_000_000;

test("borrow-send: half an emoji in the note is rejected, never crashes", () => {
  const base = { sender: "0x" + "1".repeat(40), link: "0x" + "2".repeat(40), amount: "1000000000000000000" };
  for (const note of ["\ud800", "ok \udfff", "\ud83d"]) {
    let r;
    assert.doesNotThrow(() => { r = validateInput({ ...base, note, noteHash: "0x" + "0".repeat(64) }, NOW); });
    assert.equal(r.code, "BadInput");
  }
  // a whole emoji is fine as far as the note check goes (it fails later only because this test has no signatures)
  const ok = validateInput({ ...base, note: "😀", noteHash: keccak256(toUtf8Bytes("😀")) }, NOW);
  assert.notEqual(ok.code, "BadInput");
});

test("claim options: the deadline must leave at least 2 minutes", () => {
  const sig = "0x" + "11".repeat(64) + "1b";
  const rcpt = "0x00000000000000000000000000000000000000a1";
  const opt = (deadline) => ({ id: "5", recipient: rcpt, mode: 1, minOut: "1000", deadline: String(deadline), sig, v: 2 });
  assert.equal(parseClaimInput(opt(NOW), NOW).code, "SignatureExpired");
  assert.equal(parseClaimInput(opt(NOW + 119), NOW).code, "SignatureExpired");
  assert.ok(parseClaimInput(opt(NOW + 120), NOW).value);
  assert.ok(parseClaimInput(opt(NOW + 600), NOW).value);
});
