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

function snap(extra = {}) {
  return Model.computeSnapshot(transactions, {
    asOfDate: "2026-08-05",
    weeklySavingsTarget: 300,
    checkingReserve: 1000,
    ...Model.SAMPLE_FIXTURE,
    reportedBalances: { checking: 4500, savings: 12000, ...(extra.reportedBalances || {}) },
    ...extra
  });
}

const snapshot = snap();
const safe = snapshot.safeToSpend;

assert.equal(safe.periodSource, "calendar-week");
assert.equal(safe.fundingMode, "income-minus-commitments");
assert.equal(safe.period, "2026-08-03 / 2026-08-09");
assert.equal(safe.savingsTarget, 300);
assert.ok(safe.breakdown, "cash breakdown present");
assert.equal(safe.breakdown.checkingAccountId, "checking");
assert.equal(safe.breakdown.checkingBalance, 4500);
assert.equal(safe.breakdown.reserve, 1000);
assert.equal(typeof safe.remaining, "number");
assert.ok(Array.isArray(safe.assumptions) && safe.assumptions.length > 0);
assert.ok(Array.isArray(safe.incomeOutlook));

// Savings is subtracted before discretionary spending and before the headline.
assert.equal(
  safe.remaining,
  Math.round(
    (Math.max(0, safe.income - safe.committed - safe.savingsTarget) - safe.spent) *
      100
  ) / 100
);
assert.equal(typeof safe.cashBackedRemaining, "number", "cash rail remains available");

// Standing bill still contributes when unpaid in the horizon.
const withBill = snap({
  bills: [{ id: "car", title: "Car insurance", amount: 140, dueDay: 20, active: true }]
});
assert.ok(
  withBill.safeToSpend.commitments.some((row) => row.title === "Car insurance"),
  "standing bill contributes when unpaid in horizon"
);

// No income history → default 4-week cash plan, finite remaining.
const expensesOnly = transactions.filter((tx) => tx.direction !== "in");
const weekFallback = Model.computeSnapshot(expensesOnly, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 0,
  checkingReserve: 1000,
  ...Model.SAMPLE_FIXTURE,
  reportedBalances: { checking: 4500, savings: 12000 }
});
assert.equal(weekFallback.safeToSpend.periodSource, "calendar-week");
assert.equal(weekFallback.safeToSpend.horizonSource, "default-4-weeks");
assert.equal(typeof weekFallback.safeToSpend.remaining, "number");
assert.equal(weekFallback.safeToSpend.amount, 0);

// Same-day Zelle 1500+1900 aggregates to one $3400 monthly stream.
const zelleTxs = Rules.normalizeTransactions([
  {
    id: "z1a",
    date: "2026-06-01",
    rawMerchant: "Web Branch:Zelle RAKESH WAGH 800-533-6773",
    amount: 1500,
    account: "checking",
    directionHint: "in",
    category: "income"
  },
  {
    id: "z1b",
    date: "2026-06-01",
    rawMerchant: "Web Branch:Zelle RAKESH WAGH 800-533-6773",
    amount: 1900,
    account: "checking",
    directionHint: "in",
    category: "income"
  },
  {
    id: "z2a",
    date: "2026-07-01",
    rawMerchant: "Web Branch:Zelle RAKESH WAGH 800-533-6773",
    amount: 1500,
    account: "checking",
    directionHint: "in",
    category: "income"
  },
  {
    id: "z2b",
    date: "2026-07-01",
    rawMerchant: "Web Branch:Zelle RAKESH WAGH 800-533-6773",
    amount: 1900,
    account: "checking",
    directionHint: "in",
    category: "income"
  },
  {
    id: "z3a",
    date: "2026-08-02",
    rawMerchant: "Web Branch:Zelle RAKESH WAGH 800-533-6773",
    amount: 1500,
    account: "checking",
    directionHint: "in",
    category: "income"
  },
  {
    id: "z3b",
    date: "2026-08-02",
    rawMerchant: "Web Branch:Zelle RAKESH WAGH 800-533-6773",
    amount: 1900,
    account: "checking",
    directionHint: "in",
    category: "income"
  },
  {
    id: "coffee",
    date: "2026-08-04",
    rawMerchant: "CORNER COFFEE",
    amount: 5,
    account: "checking",
    direction: "out",
    category: "dining"
  }
]);
const zelleKey = "web branch:zelle rakesh wagh 800-533-6773";
const zelleStreams = Model.detectRecurringStreams(zelleTxs, "in", {
  asOfDate: "2026-08-05"
});
assert.equal(zelleStreams.length, 1);
assert.equal(zelleStreams[0].amount, 3400);
assert.equal(zelleStreams[0].status, "observed");
assert.equal(zelleStreams[0].drivesHorizon, false);

const zelleConfirmed = Model.computeSnapshot(zelleTxs, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 0,
  checkingReserve: 1000,
  ...Model.SAMPLE_FIXTURE,
  reportedBalances: { checking: 5000 },
  incomeStreamOverrides: { [zelleKey]: { status: "confirmed" } }
});
const confirmed = zelleConfirmed.safeToSpend.incomeOutlook.find(
  (row) => row.key === zelleKey
);
assert.equal(confirmed.status, "confirmed");
assert.equal(confirmed.amount, 3400);
assert.ok(confirmed.drivesHorizon);
assert.equal(zelleConfirmed.safeToSpend.horizonSource, "confirmed-income");
assert.ok(zelleConfirmed.safeToSpend.nextPayday >= "2026-08-05");

// Stale payroll is excluded from active income / horizon.
const stalePayroll = Rules.normalizeTransactions([
  {
    id: "p1",
    date: "2025-03-14",
    rawMerchant: "ACH:C53622 COMMUNITY -DIR DEP",
    amount: 1033.85,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "p2",
    date: "2025-03-28",
    rawMerchant: "ACH:C53622 COMMUNITY -DIR DEP",
    amount: 1033.85,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "p3",
    date: "2025-04-11",
    rawMerchant: "ACH:C53622 COMMUNITY -DIR DEP",
    amount: 1033.85,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "p4",
    date: "2025-04-25",
    rawMerchant: "ACH:C53622 COMMUNITY -DIR DEP",
    amount: 1033.85,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "spend",
    date: "2026-08-04",
    rawMerchant: "GROCERY",
    amount: 40,
    account: "checking",
    direction: "out",
    category: "groceries"
  }
]);
const staleSnap = Model.computeSnapshot(stalePayroll, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 0,
  checkingReserve: 500,
  ...Model.SAMPLE_FIXTURE,
  reportedBalances: { checking: 2000 }
});
const staleRow = staleSnap.safeToSpend.incomeOutlook.find(
  (row) => row.status === "stale"
);
assert.ok(staleRow, "stale stream still listed");
assert.equal(staleRow.active, false);
assert.ok(staleRow.amount > 1000);
assert.equal(staleSnap.safeToSpend.weeklyIncome, 0);
assert.equal(staleSnap.safeToSpend.horizonSource, "default-4-weeks");
assert.equal(staleSnap.safeToSpend.amount, 0, "stale income cannot fund the weekly budget");
assert.equal(staleSnap.safeToSpend.cashBackedRemaining, 375);

// Paid bill is not reserved again.
const paidRent = Rules.normalizeTransactions([
  {
    id: "in1",
    date: "2026-07-01",
    rawMerchant: "ACME PAYROLL",
    amount: 4000,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "in2",
    date: "2026-08-01",
    rawMerchant: "ACME PAYROLL",
    amount: 4000,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "rentpay",
    date: "2026-08-02",
    rawMerchant: "AUGUST RENT",
    amount: 1650,
    account: "checking",
    direction: "out",
    category: "housing"
  }
]);
const paidSnap = Model.computeSnapshot(paidRent, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 0,
  checkingReserve: 1000,
  ...Model.SAMPLE_FIXTURE,
  reportedBalances: { checking: 3000 },
  bills: [{ id: "rent", title: "Rent", amount: 1650, dueDay: 2, active: true }],
  incomeStreamOverrides: {
    "employer payroll": { status: "confirmed" }
  }
});
assert.equal(paidSnap.safeToSpend.horizonSource, "confirmed-income");
assert.ok(
  !paidSnap.safeToSpend.commitments.some(
    (row) => /rent/i.test(row.title) && row.date <= "2026-08-05"
  ),
  "already-paid August rent not reserved again"
);
assert.ok(
  !paidSnap.safeToSpend.commitments.some((row) => row.date === "2026-08-02"),
  "August rent due not reserved after payment"
);

// Savings transfer progress reduces remaining savings need.
const withSavingsMove = Rules.normalizeTransactions([
  {
    id: "pay1",
    date: "2026-07-01",
    rawMerchant: "ACME PAYROLL",
    amount: 4000,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "pay2",
    date: "2026-08-01",
    rawMerchant: "ACME PAYROLL",
    amount: 4000,
    account: "checking",
    direction: "in",
    category: "income"
  },
  {
    id: "sav1",
    date: "2026-08-04",
    rawMerchant: "TRANSFER TO SAVINGS",
    amount: 200,
    account: "checking",
    direction: "transfer",
    transferAccount: "savings"
  }
]);
const savingsSnap = Model.computeSnapshot(withSavingsMove, {
  asOfDate: "2026-08-05",
  weeklySavingsTarget: 300,
  checkingReserve: 1000,
  ...Model.SAMPLE_FIXTURE,
  reportedBalances: { checking: 4000, savings: 12000 },
  incomeStreamOverrides: {
    "employer payroll": { status: "confirmed" }
  }
});
assert.ok(savingsSnap.safeToSpend.savingsAlready >= 200);
assert.ok(
  savingsSnap.safeToSpend.savingsRemaining <=
    savingsSnap.safeToSpend.savingsNeeded - 200 + 0.01
);

// Reserve protection remains a separate cash rail; it does not change the
// deterministic income - bills - savings weekly budget.
const lowReserve = snap({ checkingReserve: 500 });
const highReserve = snap({ checkingReserve: 2000 });
assert.equal(lowReserve.safeToSpend.remaining, highReserve.safeToSpend.remaining);
assert.ok(
  lowReserve.safeToSpend.cashBackedRemaining >
    highReserve.safeToSpend.cashBackedRemaining
);

// The visible weekly number follows the explicit period formula.
assert.equal(
  safe.amount,
  Math.max(0, safe.income - safe.committed - safe.savingsTarget)
);

console.log("Cashflow safe-to-spend checks passed.");
