import assert from "node:assert/strict";
import { test } from "node:test";

import { describeHttpFailure, extractErrorDetail, normalizeBalance, normalizeWallet, pickWallet } from "../lib/balance.js";

test("normalizeWallet keeps the documented amount fields", () => {
  assert.deepEqual(
    normalizeWallet({ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }),
    { currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" },
  );
});

test("normalizeWallet accepts numbers, because the API could start sending them", () => {
  assert.deepEqual(normalizeWallet({ currency: "USD", total_balance: 5, topped_up_balance: 5 }), {
    currency: "USD",
    total: "5",
    granted: "0",
    toppedUp: "5",
  });
});

test("normalizeWallet refuses what it cannot read", () => {
  assert.equal(normalizeWallet(null), undefined);
  assert.equal(normalizeWallet("CNY"), undefined);
  assert.equal(normalizeWallet({ total_balance: "1.00" }), undefined, "a wallet without a currency is not a wallet");
  assert.equal(normalizeWallet({ currency: "CNY" }), undefined, "a wallet with no readable amount is dropped");
  assert.equal(normalizeWallet({ currency: "CNY", topped_up_balance: "not money" }), undefined);
});

test("total is reconstructed exactly when a wallet reports only its parts", () => {
  // The panel's headline is `total`, so a wallet that omitted it must not
  // render as zero. Integer hundredths, so the sum carries no float error.
  const wallet = normalizeWallet({ currency: "CNY", topped_up_balance: "100.00", granted_balance: "10.00" });
  assert.equal(wallet?.total, "110.00");
  assert.equal(normalizeWallet({ currency: "CNY", topped_up_balance: "0.10", granted_balance: "0.20" })?.total, "0.30");
  assert.equal(normalizeWallet({ currency: "CNY", topped_up_balance: "5", granted_balance: "0.5" })?.total, "5.50");
  assert.equal(normalizeWallet({ currency: "CNY", topped_up_balance: "99.99" })?.total, "99.99");
  // A reported total is authoritative and never recomputed.
  assert.equal(
    normalizeWallet({ currency: "CNY", total_balance: "1.00", topped_up_balance: "9.00" })?.total,
    "1.00",
  );
});

test("normalizeWallet uppercases the currency so a preference can match it", () => {
  assert.equal(normalizeWallet({ currency: " cny ", topped_up_balance: "1.00" })?.currency, "CNY");
});

test("normalizeBalance reads is_available and drops unusable entries", () => {
  const result = normalizeBalance({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
      { currency: "USD", topped_up_balance: "0.00" },
      null,
    ],
  });
  assert.equal(result?.isAvailable, true);
  assert.deepEqual(
    result?.wallets.map((wallet) => wallet.currency),
    ["CNY", "USD"],
  );
});

test("normalizeBalance reports the documented shape only", () => {
  assert.equal(normalizeBalance(null), undefined);
  assert.equal(normalizeBalance({ is_available: true }), undefined, "balance_infos is required");
  assert.equal(normalizeBalance({ is_available: true, balance_infos: [] }), undefined, "no wallets is a protocol error, not a zero balance");
  assert.equal(normalizeBalance({ is_available: true, balance_infos: [null] }), undefined);
});

test("normalizeBalance treats a missing is_available as false, never as true", () => {
  const result = normalizeBalance({ balance_infos: [{ currency: "CNY", topped_up_balance: "1.00" }] });
  assert.equal(result?.isAvailable, false);
});

test("pickWallet honours an explicit preference", () => {
  const wallets = [
    { currency: "CNY", total: "1.00", granted: "0", toppedUp: "1.00" },
    { currency: "USD", total: "2.00", granted: "0", toppedUp: "2.00" },
  ];
  assert.equal(pickWallet(wallets, "USD")?.currency, "USD");
  assert.equal(pickWallet(wallets, "usd")?.currency, "USD");
});

test("pickWallet falls back to the first wallet when the preference is absent from the answer", () => {
  const wallets = [{ currency: "USD", total: "2.00", granted: "0", toppedUp: "2.00" }];
  assert.equal(pickWallet(wallets, "CNY")?.currency, "USD");
  assert.equal(pickWallet([], "CNY"), undefined);
});

test("pickWallet prefers CNY under auto, because balance_infos has no documented order", () => {
  const usdFirst = [
    { currency: "USD", total: "2.00", granted: "0", toppedUp: "2.00" },
    { currency: "CNY", total: "1.00", granted: "0", toppedUp: "1.00" },
  ];
  assert.equal(pickWallet(usdFirst, "auto")?.currency, "CNY");
  assert.equal(pickWallet(usdFirst, undefined)?.currency, "CNY");
  assert.equal(pickWallet([{ currency: "USD", total: "2.00", granted: "0", toppedUp: "2.00" }], "auto")?.currency, "USD");
});

test("extractErrorDetail tolerates the plain-text 401 body", () => {
  assert.equal(extractErrorDetail("Authentication Fails (governor)"), "Authentication Fails (governor)");
  assert.equal(extractErrorDetail(""), undefined);
  assert.equal(extractErrorDetail("   "), undefined);
});

test("extractErrorDetail prefers the JSON envelope when there is one", () => {
  const body = JSON.stringify({ error: { message: "Authentication Fails, Your api key: ****0000 is invalid", type: "authentication_error" } });
  assert.equal(extractErrorDetail(body), "Authentication Fails, Your api key: ****0000 is invalid");
});

test("extractErrorDetail truncates instead of relaying a whole page", () => {
  const long = "x".repeat(500);
  assert.equal(extractErrorDetail(long)?.length, 160);
});

test("describeHttpFailure names the states a user can act on", () => {
  assert.equal(describeHttpFailure(401, "").code, "unauthorized");
  assert.equal(describeHttpFailure(403, "").code, "unauthorized");
  assert.equal(describeHttpFailure(402, "").code, "insufficient-balance");
  assert.equal(describeHttpFailure(429, "").code, "rate-limited");
  assert.equal(describeHttpFailure(500, "boom").code, "http-500");
  assert.match(describeHttpFailure(500, "boom").message, /boom/);
});
