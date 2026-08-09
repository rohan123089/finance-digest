"use strict";

const assert = require("node:assert/strict");
const Budget = require("../engine/budget.js");

function tx(id, date, amount, category, account = "checking", direction = "out") {
  return { id, date, amount, category, account, accountType: account === "outside" ? "external" : "cash", direction };
}

// Savings is removed before the headline spendable amount.
assert.equal(Budget.safeToSpend(1000, 300, 250), 450);
assert.equal(Budget.safeToSpend(100, 80, 50), 0, "safe-to-spend floors at zero");
assert.equal(
  Budget.initializeSavingsTarget({ savingsRate: 0.25 }, 1000),
  250,
  "the initial target follows the observed savings rate"
);

const snapshot = {
  asOfDate: "2026-08-05",
  savingsRate: 0.25,
  recurring: [
    {
      key: "rent",
      merchant: "Rent",
      amount: 100,
      cadenceLabel: "weekly",
      transactionIds: ["rent-current"]
    }
  ],
  safeToSpend: {
    weeklyIncome: 1000,
    savingsTarget: 250,
    dueThisWeek: [{ title: "Rent", amount: 100 }]
  }
};

const current = [
  tx("rent-current", "2026-08-03", 100, "housing"),
  tx("cash-spend", "2026-08-04", 40, "dining"),
  tx("external-spend", "2026-08-05", 60, "shopping", "outside")
];
const computed = Budget.computeBudget(snapshot, current);
assert.equal(computed.safeToSpend, 650);
assert.equal(computed.discretionarySpend, 100);
assert.equal(computed.remaining, 550);

// External-account money-out is spending, but the committed bill is not.
assert.equal(
  Budget.discretionaryTransactions(snapshot, current, Budget.weekBounds("2026-08-05"))
    .find((row) => row.id === "external-spend").amount,
  60
);

// Leftover only becomes a sweep; it never funds the next period.
const rollover = Budget.rolloverPeriod(
  {
    periodStart: "2026-07-27",
    safeToSpend: 500,
    discretionarySpend: 300
  },
  { periodIncome: 1000, committedBills: 300, savingsTarget: 250 },
  { goal: "Emergency fund" }
);
assert.equal(rollover.leftover, 200);
assert.equal(rollover.nextSafeToSpend, 450);
assert.equal(rollover.sweepFlag.dollarValue, 200);
assert.match(rollover.sweepFlag.action, /sweep \$200\.00 to Emergency fund/);
assert.equal("carryover" in rollover, false);

// Three underspend periods propose a step; overspend pauses without lowering.
let ratchet = { streak: 0, savingsTarget: 250 };
for (let index = 0; index < 3; index += 1) {
  ratchet = {
    ...ratchet,
    ...Budget.updateRatchet(ratchet, {
      periodStart: `2026-07-${13 + index * 7}`,
      safeToSpend: 500,
      discretionarySpend: 400
    })
  };
}
assert.equal(ratchet.streak, 3);
assert.equal(ratchet.proposal.nextSavingsTarget, 260);
const paused = Budget.updateRatchet(ratchet, {
  periodStart: "2026-08-03",
  safeToSpend: 500,
  discretionarySpend: 525
});
assert.equal(paused.status, "paused");
assert.equal(paused.streak, 3);
assert.equal(paused.proposal, null);
assert.equal(Budget.acceptRatchet(250), 260);

const history = [
  tx("d1", "2026-07-07", 10, "dining"),
  tx("d2", "2026-07-14", 10, "dining"),
  tx("d3", "2026-07-21", 10, "dining"),
  tx("d4", "2026-07-28", 10, "dining"),
  tx("e1", "2026-07-08", 40, "entertainment"),
  tx("e2", "2026-07-15", 40, "entertainment"),
  tx("e3", "2026-07-22", 40, "entertainment"),
  tx("e4", "2026-07-29", 40, "entertainment"),
  tx("current-dining", "2026-08-04", 30, "dining"),
  tx("current-entertainment", "2026-08-05", 100, "entertainment", "outside")
];
const diagnostics = Budget.categoryDiagnostics(
  { asOfDate: "2026-08-05", recurring: [] },
  history,
  { historyPeriods: 4 }
);
assert.deepEqual(
  diagnostics.categories.map((row) => row.category),
  ["entertainment", "dining"],
  "current categories rank by spend"
);
assert.equal(diagnostics.categories[0].rollingAverage, 40);
assert.equal(diagnostics.categories[1].rollingAverage, 10);
assert.ok(diagnostics.leakFlag, "a leak above the threshold emits a flag");
assert.equal(diagnostics.leakFlag.trigger, "category over baseline");
assert.match(diagnostics.leakFlag.why, /entertainment \$100\.00 vs usual \$40\.00/);
assert.equal(diagnostics.leakFlag.dollarValue, 60);
assert.equal(
  [diagnostics.leakFlag].length,
  1,
  "only the single biggest leak is emitted"
);

const belowThreshold = Budget.categoryDiagnostics(
  { asOfDate: "2026-08-05", recurring: [] },
  [
    tx("h1", "2026-07-08", 100, "health"),
    tx("h2", "2026-07-15", 100, "health"),
    tx("h3", "2026-07-22", 100, "health"),
    tx("h4", "2026-07-29", 100, "health"),
    tx("hc", "2026-08-05", 139, "health")
  ],
  { historyPeriods: 4 }
);
assert.equal(belowThreshold.leakFlag, null);

const pause = Budget.spendPause(
  tx("large", "2026-08-05", 120, "shopping"),
  300,
  { asOfDate: "2026-08-05" }
);
assert.equal(pause.message, "$180.00 left this week — still in?");
assert.equal(pause.cooldownOffered, true);
assert.equal(pause.revisitDate, "2026-08-06");

console.log("Weekly budget checks passed.");
