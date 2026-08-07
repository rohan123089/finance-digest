"use strict";

const assert = require("node:assert/strict");
const Model = require("../engine/model.js");

assert.equal(Model.isCashLikeHolding({ symbol: "VMFXX" }), true);
assert.equal(
  Model.isCashLikeHolding({
    symbol: "VOO",
    description: "Vanguard 500 Index Fund"
  }),
  false
);

const split = Model.splitBalanceByHoldings(9700.08, [
  { symbol: "VMFXX", description: "Vanguard Federal Money Market Fund", market_value: "8297.08" },
  { symbol: "VOO", description: "Vanguard 500 Index Fund", market_value: "744.69" },
  { symbol: "AAPL", description: "Apple Inc", market_value: "318.72" },
  { symbol: "LUV", description: "Southwest Airlines Co", market_value: "51.29" },
  { symbol: "DAL", description: "Delta Air Lines Inc", market_value: "288.30" }
]);

assert.equal(split.cash, 8297.08);
assert.equal(split.invested, 1403);

const snap = Model.computeSnapshot([], {
  asOfDate: "2026-08-06",
  openingBalances: {
    "vanguard-brokerage": 9700.08,
    amex: 2895.24
  },
  accountTypes: {
    "vanguard-brokerage": "investment",
    amex: "liability"
  },
  accountHoldings: {
    "vanguard-brokerage": [
      { symbol: "VMFXX", market_value: 8297.08 },
      { symbol: "VOO", market_value: 1403 }
    ]
  }
});

assert.equal(snap.liquid, 8297.08);
assert.equal(snap.invested, 1403);
assert.equal(snap.liabilities, 2895.24);
assert.equal(snap.netWorth, 8297.08 + 1403 - 2895.24);

console.log("Holdings cash/invested split checks passed.");
