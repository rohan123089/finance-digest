"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Rules = require("../engine/rules.js");
const Model = require("../engine/model.js");

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../sample-data/transactions.json"), "utf8")
);
const transactions = Rules.normalizeTransactions(raw);

function without(id) {
  return transactions.filter((tx) => tx.id !== id);
}

function snapshot(rows = transactions) {
  return Model.computeSnapshot(rows, { asOfDate: "2026-08-05" });
}

assert.equal(raw.length, 25, "sample data has 25 rows");
assert.equal(transactions.length, 25, "all sample rows normalize");

const savingsTransfer = transactions.find((tx) => tx.id === "tx-008");
assert.equal(savingsTransfer.direction, "transfer");
assert.equal(savingsTransfer.transferAccount, "savings");
const withSavingsTransfer = snapshot();
const withoutSavingsTransfer = snapshot(without("tx-008"));
assert.equal(withSavingsTransfer.income, withoutSavingsTransfer.income);
assert.equal(withSavingsTransfer.expenses, withoutSavingsTransfer.expenses);
assert.equal(withSavingsTransfer.netWorth, withoutSavingsTransfer.netWorth);

const vanguardBuy = transactions.find((tx) => tx.id === "tx-007");
assert.equal(vanguardBuy.direction, "transfer");
assert.equal(vanguardBuy.transferAccount, "vanguard");
const withoutVanguard = snapshot(without("tx-007"));
assert.equal(withSavingsTransfer.expenses, withoutVanguard.expenses);
assert.equal(withSavingsTransfer.invested - withoutVanguard.invested, 600);
assert.equal(withSavingsTransfer.liquid - withoutVanguard.liquid, -600);
assert.equal(withSavingsTransfer.netWorth, withoutVanguard.netWorth);

const withoutExternalExpense = snapshot(without("tx-016"));
assert.equal(withSavingsTransfer.expenses - withoutExternalExpense.expenses, 86.25);
assert.equal(withSavingsTransfer.liquid, withoutExternalExpense.liquid);
assert.equal(withSavingsTransfer.invested, withoutExternalExpense.invested);
assert.equal(withSavingsTransfer.owed - withoutExternalExpense.owed, 86.25);
assert.equal(withSavingsTransfer.netWorth - withoutExternalExpense.netWorth, -86.25);
assert.equal(withSavingsTransfer.spendingByCategory.dining - withoutExternalExpense.spendingByCategory.dining, 86.25);

const withoutReimbursement = snapshot(without("tx-017"));
assert.equal(withSavingsTransfer.owed - withoutReimbursement.owed, -50);
assert.equal(withSavingsTransfer.liquid - withoutReimbursement.liquid, -50);
assert.equal(withSavingsTransfer.netWorth, withoutReimbursement.netWorth);

const venmo = transactions.find((tx) => tx.id === "tx-024");
assert.equal(venmo.direction, "");
assert.equal(venmo.needsReview, true);
venmo.direction = "out";
venmo.category = "uncategorized";
const venmoAsExpense = snapshot();
venmo.direction = "transfer";
venmo.category = "";
venmo.transferAccount = "savings";
const venmoAsTransfer = snapshot();
assert.equal(venmoAsTransfer.expenses, venmoAsExpense.expenses - 72);
assert.equal(venmoAsTransfer.netWorth, venmoAsExpense.netWorth + 72);
assert.ok(venmoAsTransfer.savingsRate > venmoAsExpense.savingsRate);

assert.ok(
  withSavingsTransfer.recurring.some((item) => item.merchant.includes("NETFLIX")),
  "monthly Netflix charge is detected"
);

const html = fs.readFileSync(
  path.join(__dirname, "../apps/money/money.html"),
  "utf8"
);
assert.doesNotMatch(html, /https?:\/\//i, "UI has no network dependencies");
assert.doesNotMatch(html, /\blocalStorage\b/, "UI does not use localStorage");
assert.match(html, /SAMPLE_TRANSACTIONS/, "offline sample data remains embedded");
assert.match(html, /hubMode/, "hub mode path is available when served locally");

console.log("Milestone 1 acceptance checks passed.");
