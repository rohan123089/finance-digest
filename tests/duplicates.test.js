"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const { importText } = require("../hub/import/index.js");
const Duplicates = require("../engine/duplicates.js");
const Model = require("../engine/model.js");

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-dup-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 9);
  const db = dbApi.openDatabase({ seedSample: false, dbPath, encryptionKey: key });

  // --- Fingerprint skips re-import of the same row ---
  const csv = [
    "Date,Description,Amount",
    "2026-07-01,PAYROLL ACME,2500.00",
    "2026-07-02,TRADER JOE'S,-42.10"
  ].join("\n");

  const first = await importText(db, {
    accountId: "uwcu-checking",
    text: csv,
    format: "csv",
    label: "july.csv"
  });
  assert.equal(first.inserted, 2);
  assert.equal(first.skipped, 0);

  const second = await importText(db, {
    accountId: "uwcu-checking",
    text: csv,
    format: "csv",
    label: "july-again.csv"
  });
  assert.equal(second.duplicateFile, true);
  assert.equal(second.inserted, 0);
  assert.ok(second.skipped >= 2);
  assert.equal(dbApi.listTransactions(db).length, 2);

  // Different file bytes but same logical rows → fingerprint skip
  const csvTweaked = csv + "\n";
  const third = await importText(db, {
    accountId: "uwcu-checking",
    text: csvTweaked,
    format: "csv",
    label: "july-tweaked.csv"
  });
  assert.equal(third.duplicateFile, false);
  assert.equal(third.inserted, 0);
  assert.equal(third.skipped, 2);
  assert.equal(dbApi.listTransactions(db).length, 2);

  // --- Cross-account move: one transfer, opposite leg hidden ---
  dbApi.insertRawTransaction(db, {
    id: "tx-move-out",
    date: "2026-07-10",
    rawMerchant: "WEB BRANCH TRANSFER TO SAVINGS",
    amount: 500,
    account: "uwcu-checking",
    directionHint: "out"
  });
  dbApi.insertRawTransaction(db, {
    id: "tx-move-in",
    date: "2026-07-10",
    rawMerchant: "WEB BRANCH TRANSFER FROM CHECKING",
    amount: 500,
    account: "uwcu-savings",
    directionHint: "in"
  });

  const linked = dbApi.linkInternalTransfers(db);
  assert.ok(linked.linked >= 1);

  const txs = dbApi.listTransactions(db);
  const out = txs.find((tx) => tx.id === "tx-move-out");
  const inn = txs.find((tx) => tx.id === "tx-move-in");
  assert.equal(out.direction, "transfer");
  assert.equal(out.transferAccount, "uwcu-savings");
  assert.equal(inn.duplicateOf, "tx-move-out");

  const snap = dbApi.computeLiveSnapshot(db);
  assert.ok(inn.duplicateOf, "savings leg should be linked as duplicate");
  const maps = dbApi.getAccountMaps(db);
  const balances = snap.balances || {};
  // Checking: +2500 payroll -42.10 groceries -500 transfer = 1957.9 (opening 0)
  assert.equal(Number(balances["uwcu-checking"].toFixed(2)), 1957.9);
  // Savings: +500 from transfer only
  assert.equal(Number(balances["uwcu-savings"].toFixed(2)), 500);

  const activityCheck = Model.accountActivityDelta(
    txs,
    "uwcu-checking",
    "cash",
    maps.accountTypes
  );
  const activitySave = Model.accountActivityDelta(
    txs,
    "uwcu-savings",
    "cash",
    maps.accountTypes
  );
  assert.equal(Number(activityCheck.toFixed(2)), 1957.9);
  assert.equal(Number(activitySave.toFixed(2)), 500);

  // --- Typed transfer + opposite statement leg ---
  dbApi.insertRawTransaction(db, {
    id: "tx-typed-xfer",
    date: "2026-07-15",
    rawMerchant: "Transfer to Savings",
    amount: 200,
    account: "uwcu-checking"
  });
  dbApi.insertRawTransaction(db, {
    id: "tx-typed-leg",
    date: "2026-07-15",
    rawMerchant: "Deposit Transfer from Checking",
    amount: 200,
    account: "uwcu-savings",
    directionHint: "in"
  });
  const linked2 = dbApi.linkInternalTransfers(db);
  assert.ok(linked2.linked >= 1);
  const typedLeg = dbApi.listTransactions(db).find((tx) => tx.id === "tx-typed-leg");
  assert.equal(typedLeg.duplicateOf, "tx-typed-xfer");

  // Fingerprint helper normalizes OCR noise
  assert.equal(
    Duplicates.fingerprint("a", "2026-01-01", 10, "AMEX EPAYMENT 12345"),
    Duplicates.fingerprint("a", "2026-01-01", 10, "amex epayment #12345")
  );

  // --- Credit card payoff from checking (own money, not spending) ---
  dbApi.insertRawTransaction(db, {
    id: "tx-amex-bank",
    date: "2026-07-20",
    rawMerchant: "AMEX EPAYMENT ACH PMT",
    amount: 812.44,
    account: "uwcu-checking"
  });
  dbApi.insertRawTransaction(db, {
    id: "tx-amex-card",
    date: "2026-07-21",
    rawMerchant: "PAYMENT RECEIVED - THANK YOU",
    amount: 812.44,
    account: "amex",
    directionHint: "in"
  });
  const cardLink = dbApi.linkInternalTransfers(db);
  assert.ok(cardLink.linked >= 1 || cardLink.promoted >= 1);
  const bankPay = dbApi.listTransactions(db).find((tx) => tx.id === "tx-amex-bank");
  const cardPay = dbApi.listTransactions(db).find((tx) => tx.id === "tx-amex-card");
  assert.equal(bankPay.direction, "transfer");
  assert.equal(bankPay.transferAccount, "amex");
  assert.equal(cardPay.duplicateOf, "tx-amex-bank");

  const afterCard = dbApi.computeLiveSnapshot(db, { asOfDate: "2026-07-31" });
  // Card payoff is a transfer, not spending (only Trader Joe's $42.10 is an expense here).
  assert.equal(Number(afterCard.expenses.toFixed(2)), 42.1);
  // Opening 0 + payment transfer → liability balance falls by 812.44 once (not twice).
  assert.equal(Number(afterCard.balances.amex.toFixed(2)), -812.44);

  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log("duplicates.test.js: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
