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
const snapshot = Model.computeSnapshot(transactions, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 300,
  ...Model.SAMPLE_FIXTURE
});

const safe = snapshot.safeToSpend;

assert.equal(safe.periodSource, "income-cadence");
assert.equal(safe.period, "2026-08-03 / 2026-09-03");
assert.equal(safe.income, 5200);
assert.equal(safe.incomeReceived, 5200);
assert.equal(safe.incomeExpected, 0);

// Rent cycles monthly and is due again before the next payday — even though the
// last rent charge fell just before this paycheck.
assert.ok(
  safe.commitments.some((row) => row.amount === 1650 && row.date.startsWith("2026-09")),
  "next rent inside the pay period is committed"
);
assert.ok(
  safe.commitments.some((row) => row.title.includes("NETFLIX")),
  "Netflix due this period is committed"
);
assert.equal(safe.committed, 1677.48);
assert.equal(safe.spent, 95.95);
assert.ok(safe.remaining > 0);

const withBill = Model.computeSnapshot(transactions, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 300,
  ...Model.SAMPLE_FIXTURE,
  bills: [{ id: "car", title: "Car insurance", amount: 140, dueDay: 20, active: true }]
});
assert.ok(
  withBill.safeToSpend.commitments.some((row) => row.title === "Car insurance"),
  "standing bill due mid-period is included even without matching transactions"
);
assert.equal(withBill.safeToSpend.committed, round(1677.48 + 140));

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// No income history → calendar-week fallback still produces a finite remaining.
const expensesOnly = transactions.filter((tx) => tx.direction !== "in");
const weekFallback = Model.computeSnapshot(expensesOnly, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 0,
  ...Model.SAMPLE_FIXTURE
});
assert.equal(weekFallback.safeToSpend.periodSource, "calendar-week");
assert.equal(typeof weekFallback.safeToSpend.remaining, "number");

console.log("Cashflow safe-to-spend checks passed.");
