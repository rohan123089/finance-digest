"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Rules = require("../engine/rules.js");
const Model = require("../engine/model.js");

function loadMockShelf() {
  const code = fs.readFileSync(
    path.join(__dirname, "../apps/shelf/mock-shelf.js"),
    "utf8"
  );
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.Shelf;
}

async function main() {
  const html = fs.readFileSync(
    path.join(__dirname, "../apps/money/money.html"),
    "utf8"
  );
  const mockSrc = fs.readFileSync(
    path.join(__dirname, "../apps/shelf/mock-shelf.js"),
    "utf8"
  );

  // Iron rule: money HTML never touches network / credentials surfaces.
  assert.doesNotMatch(html, /\bfetch\s*\(/, "money.html must not call fetch");
  assert.doesNotMatch(html, /\bXMLHttpRequest\b/, "money.html must not use XHR");
  assert.doesNotMatch(html, /https?:\/\//i, "money.html must not embed external URLs");
  assert.doesNotMatch(html, /\blocalStorage\b/, "money.html must not use localStorage");
  assert.doesNotMatch(html, /\bsessionStorage\b/, "money.html must not use sessionStorage");
  assert.match(html, /Shelf\.data\.get\(\s*['"]transactions['"]\s*\)/, "loads via Shelf");
  assert.match(html, /mock-shelf\.js/, "loads mock when real Shelf absent");
  assert.doesNotMatch(mockSrc, /\bfetch\s*\(/, "mock-shelf must not fetch");
  assert.doesNotMatch(mockSrc, /https?:\/\//i, "mock-shelf must not use external URLs");

  const Shelf = loadMockShelf();
  assert.equal(Shelf.__mock, true);

  const payload = await Shelf.data.get("transactions");
  assert.ok(payload && "transactions" in payload, "transactions come back as a field");
  assert.equal(payload.transactions.length, 25);
  const transactions = Rules.normalizeTransactions(payload.transactions);

  function without(id) {
    return transactions.filter((tx) => tx.id !== id);
  }
  function snapshot(rows = transactions) {
    return Model.computeSnapshot(rows, { asOfDate: "2026-08-05" });
  }

  const savingsTransfer = transactions.find((tx) => tx.id === "tx-008");
  assert.equal(savingsTransfer.direction, "transfer");
  assert.equal(savingsTransfer.transferAccount, "savings");
  const withAll = snapshot();
  const withoutSavings = snapshot(without("tx-008"));
  assert.equal(withAll.income, withoutSavings.income);
  assert.equal(withAll.expenses, withoutSavings.expenses);

  const vanguard = transactions.find((tx) => tx.id === "tx-007");
  assert.equal(vanguard.direction, "transfer");
  assert.equal(vanguard.transferAccount, "vanguard");
  const withoutVanguard = snapshot(without("tx-007"));
  assert.equal(withAll.expenses, withoutVanguard.expenses);
  assert.equal(withAll.invested - withoutVanguard.invested, 600);
  assert.equal(withAll.liquid - withoutVanguard.liquid, -600);
  assert.equal(withAll.netWorth, withoutVanguard.netWorth);

  const withoutExternal = snapshot(without("tx-016"));
  assert.equal(withAll.expenses - withoutExternal.expenses, 86.25);
  assert.equal(withAll.liquid, withoutExternal.liquid);
  assert.equal(withAll.invested, withoutExternal.invested);
  assert.equal(withAll.owed - withoutExternal.owed, 86.25);
  assert.equal(withAll.netWorth - withoutExternal.netWorth, -86.25);
  assert.equal(
    withAll.spendingByCategory.dining - (withoutExternal.spendingByCategory.dining || 0),
    86.25
  );

  const withoutReimburse = snapshot(without("tx-017"));
  assert.equal(withAll.owed - withoutReimburse.owed, -50);
  assert.equal(withAll.liquid - withoutReimburse.liquid, -50);
  assert.equal(withAll.netWorth, withoutReimburse.netWorth);

  const venmo = transactions.find((tx) => tx.id === "tx-024");
  assert.equal(venmo.direction, "");
  assert.equal(venmo.needsReview, true);
  venmo.direction = "out";
  venmo.category = "uncategorized";
  const asExpense = snapshot();
  venmo.direction = "transfer";
  venmo.category = "";
  venmo.transferAccount = "savings";
  const asTransfer = snapshot();
  assert.equal(asTransfer.expenses, asExpense.expenses - 72);
  assert.equal(asTransfer.netWorth, asExpense.netWorth + 72);
  assert.ok(asTransfer.savingsRate > asExpense.savingsRate);

  // Contract surface smoke
  assert.ok(typeof Shelf.contacts.list === "function");
  assert.ok(typeof Shelf.sms.query === "function");
  assert.ok(typeof Shelf.camera.capture === "function");
  assert.ok(typeof Shelf.ocr.recognize === "function");
  assert.ok(typeof Shelf.fs.read === "function");
  assert.ok(typeof Shelf.secure.get === "function");
  await assert.rejects(
    () => Shelf.secure.get("token"),
    (error) => error.shelf === true && error.code === "SECURE_DISABLED",
    "secure.get must reject instead of returning tokens"
  );
  await assert.rejects(() => Shelf.secure.set("token", "x"), (error) => error.shelf === true);
  await assert.rejects(
    () => Shelf.Net.call("groupme", {}),
    (error) => error.shelf === true && error.code === "NET_NATIVE_ONLY"
  );
  assert.ok(typeof Shelf.outbox.push === "function");
  assert.ok(typeof Shelf.notify === "function");
  assert.ok(typeof Shelf.onShare === "function");
  assert.ok(typeof Shelf.onAppUrl === "function");

  console.log("Money app (Shelf bridge) acceptance checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
