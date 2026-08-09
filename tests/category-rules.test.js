"use strict";

const assert = require("node:assert/strict");
const Rules = require("../engine/rules.js");

const cases = [
  ["GglPay TRADER JOE S DOWNERS GROVE IL", "groceries"],
  ["GglPay CHIPOTLE MEX NEWPORT BEACH CA", "dining"],
  ["GglPay COMMON'S CAFEDOWNERS GROVE IL", "dining"],
  ["GglPay TST* MUSAAFERMANHATTAN NY", "dining"],
  ["GglPay QDOBA 1775 SEATTLE WA", "dining"],
  ["GglPay NYCT PAYGO NEW YORK NY", "transportation"],
  ["GglPay ORCA*00W8FST SEATTLE WA", "transportation"],
  ["GglPay SHELL 5744408OAK BROOK IL", "transportation"],
  ["QFC FUEL RENTON WA", "transportation"],
  ["LYFT 855-280-0278 CA", "transportation"],
  ["UNITED AIRLINES HOUSTON TX", "travel"],
  ["AIRBNB * HMH935P2EN SAN FRANCISCO CA", "travel"],
  ["NYTimes.COM NY TIMES(800)698-4637 NY", "subscriptions"],
  ["OPENAI *CHATGPT SUBSSAN FRANCISCO CA", "subscriptions"],
  ["CURSOR, AI POWERED ISAN FRANCISCO CA", "subscriptions"],
  ["ANTHROPIC* CLAUDE SUSAN FRANCISCO CA", "subscriptions"],
  ["WALGREENS AURORA IL", "health"],
  ["GglPay TARGET LOMBARD IL", "shopping"],
  ["CINEMARK 276 ONLINE WOODRIDGE IL", "entertainment"],
  ["EXXONMOBIL OAK BROOK TER IL", "transportation"],
  ["GglPay BP#1502400SANMILWAUKEE WI", "transportation"],
  ["CASA DE CREPES SAN FRANCISCO CA", "dining"],
  ["7THSTREETBURGER BROOKLYN NY", "dining"],
  ["GglPay AMZ*3JDMQ9419CHICAGO IL", "shopping"],
  ["GglPay ALLSTATE ARENROSEMONT IL", "entertainment"],
  ["RANDOM LOCAL SHOP XYZ", "uncategorized"]
];

for (const [merchant, expected] of cases) {
  assert.equal(
    Rules.categoryFor(merchant),
    expected,
    `${merchant} → expected ${expected}, got ${Rules.categoryFor(merchant)}`
  );
}

// Sample rows still normalize.
const sample = Rules.normalizeTransaction({
  id: "tx-test",
  date: "2026-08-01",
  rawMerchant: "CHIPOTLE PARENTS CARD",
  amount: 12,
  account: "amex"
});
assert.equal(sample.category, "dining");
assert.equal(sample.direction, "out");

assert.equal(Rules.CATEGORY_RULES_VERSION, 3);
console.log(`Category offline rules ok (${cases.length} merchants).`);
