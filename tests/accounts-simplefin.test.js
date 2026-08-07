"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const { createServer } = require("../hub/server.js");
const { parseImport } = require("../hub/import/parse.js");
const importer = require("../hub/import/index.js");
const simplefin = require("../hub/connectors/simplefin.js");
const Rules = require("../engine/rules.js");

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const type = res.headers["content-type"] || "";
          let parsed = null;
          if (text && type.includes("json")) parsed = JSON.parse(text);
          resolve({ status: res.statusCode, body: parsed, text });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-accounts-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 9);

  // Empty DB: starter accounts only, no sample transactions.
  const emptyDb = dbApi.openDatabase({ dbPath, encryptionKey: key });
  assert.equal(dbApi.listTransactions(emptyDb).length, 0);
  const starters = dbApi.listAccounts(emptyDb);
  assert.ok(starters.some((a) => a.id === "uwcu-checking"));
  assert.ok(starters.some((a) => a.id === "amex"));
  assert.ok(starters.some((a) => a.id === "discover"));
  assert.ok(starters.some((a) => a.id === "vanguard"));

  const created = dbApi.createAccount(emptyDb, {
    id: "fidelity",
    label: "Fidelity",
    type: "investment",
    openingBalance: 100
  });
  assert.equal(created.id, "fidelity");
  assert.equal(dbApi.getAccountMaps(emptyDb).accountTypes.fidelity, "investment");

  // Venmo on Amex stays needs-review (not its own account).
  const venmo = dbApi.insertRawTransaction(emptyDb, {
    id: "amex-venmo-1",
    date: "2026-08-05",
    rawMerchant: "VENMO PAYMENT 1234",
    amount: 40,
    account: "amex"
  });
  assert.equal(venmo.needsReview, true);
  assert.equal(venmo.direction, "");
  assert.ok(!dbApi.listAccounts(emptyDb).some((a) => a.id === "venmo"));

  // CSV import idempotency
  const csv = [
    "Date,Description,Amount",
    "2026-08-01,COFFEE SHOP,-4.50",
    "2026-08-02,PAYROLL,1000.00"
  ].join("\n");
  const parsed = parseImport({
    text: csv,
    accountId: "uwcu-checking",
    accountType: "cash",
    format: "csv"
  });
  assert.equal(parsed.rows.length, 2);
  const first = await importer.importText(emptyDb, {
    accountId: "uwcu-checking",
    text: csv,
    format: "csv"
  });
  assert.equal(first.inserted, 2);
  const second = await importer.importText(emptyDb, {
    accountId: "uwcu-checking",
    text: csv,
    format: "csv"
  });
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 2);

  // OFX stub
  const ofx = [
    "OFXHEADER:100",
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>",
    "<STMTTRN><TRNTYPE>DEBIT",
    "<DTPOSTED>20260803",
    "<TRNAMT>-12.34",
    "<FITID>ofx-1",
    "<NAME>BOOKSHOP",
    "</STMTTRN>",
    "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"
  ].join("\n");
  const ofxResult = await importer.importText(emptyDb, {
    accountId: "amex",
    text: ofx,
    format: "ofx"
  });
  assert.equal(ofxResult.format, "ofx");
  assert.equal(ofxResult.inserted, 1);

  // UWCU-style PDF statement text (combined checking + savings)
  const pdfText = fs.readFileSync(
    path.join(__dirname, "../sample-data/uwcu-statement-sample.txt"),
    "utf8"
  );
  const pdfParsed = parseImport({
    text: pdfText,
    accountId: "uwcu-checking",
    accountType: "cash",
    format: "pdf"
  });
  assert.ok(pdfParsed.rows.length >= 8);
  const checkingRows = pdfParsed.rows.filter((r) => r.account === "uwcu-checking");
  const savingsRows = pdfParsed.rows.filter((r) => r.account === "uwcu-savings");
  assert.ok(checkingRows.length >= 6);
  assert.ok(savingsRows.length >= 2);
  assert.ok(checkingRows.some((r) => /Versailles/i.test(r.rawMerchant) && r.directionHint === "out"));
  assert.ok(checkingRows.some((r) => /Zelle/i.test(r.rawMerchant) && r.directionHint === "in"));
  assert.ok(savingsRows.some((r) => /MOBILE DEPOSIT/i.test(r.rawMerchant)));
  const pdfImport = await importer.importText(emptyDb, {
    accountId: "uwcu-auto",
    text: pdfText,
    format: "pdf",
    label: "uwcu-july-sample.pdf"
  });
  assert.equal(pdfImport.format, "pdf");
  assert.ok(pdfImport.inserted >= 8);
  assert.ok(pdfImport.batchId);
  assert.ok(pdfImport.byAccount["uwcu-checking"] >= 1);
  assert.ok(pdfImport.byAccount["uwcu-savings"] >= 1);

  const batches = dbApi.listImportBatches(emptyDb);
  assert.ok(batches.some((b) => b.id === pdfImport.batchId));
  assert.equal(
    batches.find((b) => b.id === pdfImport.batchId).label,
    "uwcu-july-sample.pdf"
  );

  const undone = dbApi.deleteImportBatch(emptyDb, pdfImport.batchId);
  assert.equal(undone.deletedTransactions, pdfImport.inserted);
  assert.equal(
    dbApi.listTransactions(emptyDb).filter((tx) => String(tx.id).startsWith("pdf:")).length,
    0
  );

  // SimpleFIN mock sync after mapping — signs match live protocol
  dbApi.updateAccount(emptyDb, "amex", { simplefinAccountId: "sf-amex-1" });
  const beforeSf = dbApi.listTransactions(emptyDb).length;
  const sf = await simplefin.syncToDb(emptyDb, { forceMock: true });
  assert.equal(sf.mode, "mock");
  assert.ok(sf.inserted >= 1);
  assert.equal(dbApi.listTransactions(emptyDb).length, beforeSf + sf.inserted);

  assert.equal(simplefin.directionHintFromSigned(-42.17, "liability"), "out");
  assert.equal(simplefin.directionHintFromSigned(200, "liability"), "in");
  assert.equal(simplefin.directionHintFromSigned(-10, "cash"), "out");

  const traderJoe = dbApi.listTransactions(emptyDb).find((tx) =>
    /trader joe/i.test(tx.rawMerchant || tx.merchant)
  );
  assert.ok(traderJoe);
  assert.equal(traderJoe.direction, "out");
  assert.equal(traderJoe.category, "groceries");

  const paymentSf = dbApi.listTransactions(emptyDb).find((tx) =>
    /payment received/i.test(tx.rawMerchant || tx.merchant)
  );
  assert.ok(paymentSf);
  assert.equal(paymentSf.direction, "in");

  const venmoSf = dbApi.listTransactions(emptyDb).find((tx) =>
    /venmo/i.test(tx.rawMerchant || tx.merchant)
  );
  assert.ok(venmoSf);
  assert.equal(venmoSf.needsReview, true);

  // Re-sync corrects a previously inverted liability direction
  emptyDb
    .prepare(
      `UPDATE transactions SET direction = 'in', category = 'income', committed_at = ?
       WHERE id = ?`
    )
    .run(new Date().toISOString(), traderJoe.id);
  const repaired = await simplefin.syncToDb(emptyDb, { forceMock: true });
  assert.ok(repaired.updated >= 1);
  const traderJoeFixed = dbApi
    .listTransactions(emptyDb)
    .find((tx) => tx.id === traderJoe.id);
  assert.equal(traderJoeFixed.direction, "out");
  assert.equal(traderJoeFixed.category, "groceries");
  assert.equal(traderJoeFixed.committedAt, null);

  // Claim + access URL parsing helpers
  assert.equal(simplefin.modelBalanceFromRemote(-2895.24, "liability"), 2895.24);
  assert.equal(simplefin.modelBalanceFromRemote(19930.59, "investment"), 19930.59);
  const claimUrl = "https://bridge.example/claim/abc";
  const setupToken = Buffer.from(claimUrl).toString("base64");
  assert.equal(simplefin.decodeSetupToken(setupToken), claimUrl);
  const access =
    "https://user:pass@bridge.example/simplefin/abc";
  const parsedAccess = simplefin.parseAccessUrl(access);
  assert.equal(parsedAccess.username, "user");
  assert.equal(parsedAccess.password, "pass");

  // Hub HTTP surface
  const server = createServer(emptyDb, {
    projectRoot: tempRoot,
    syncRoot: path.join(tempRoot, "sync"),
    fetchImpl: async (url, init) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          text: async () => "https://testuser:testpass@bridge.example/access/1"
        };
      }
      return {
        ok: true,
        json: async () => ({
          accounts: [
            {
              id: "sf-remote-2",
              name: "UWCU Checking",
              balance: "10",
              "balance-date": 1,
              transactions: []
            }
          ]
        })
      };
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const accounts = await request(port, "GET", "/api/accounts");
  assert.equal(accounts.status, 200);
  assert.ok(accounts.body.accounts.length >= 6);

  const patch = await request(port, "PATCH", "/api/accounts/amex", {
    label: "Amex Gold"
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.account.label, "Amex Gold");

  const importApi = await request(port, "POST", "/api/import", {
    accountId: "discover",
    text: "Date,Description,Amount\n2026-08-04,NETFLIX.COM,-15.49\n",
    format: "csv"
  });
  assert.equal(importApi.status, 200);
  assert.equal(importApi.body.inserted, 1);

  // Engine still normalizes sample checking accounts
  const sample = Rules.normalizeTransaction({
    id: "t1",
    date: "2026-08-05",
    rawMerchant: "VENMO PAYMENT",
    amount: 10,
    account: "checking"
  });
  assert.equal(sample.needsReview, true);

  const page = await request(port, "GET", "/apps/hub/simplefin.html");
  assert.equal(page.status, 200);
  assert.match(page.text, /SimpleFIN/);

  const money = await request(port, "GET", "/apps/money/money.html");
  assert.equal(money.status, 200);
  assert.match(money.text, /import-file/);
  assert.match(money.text, /import-batches/);
  assert.match(money.text, /simplefin/);

  const importsList = await request(port, "GET", "/api/imports");
  assert.equal(importsList.status, 200);
  assert.ok(Array.isArray(importsList.body.batches));

  const labeled = await request(port, "POST", "/api/import", {
    accountId: "discover",
    text: "Date,Description,Amount\n2026-08-05,SPOTIFY,-10.99\n",
    format: "csv",
    label: "discover-test.csv"
  });
  assert.equal(labeled.status, 200);
  assert.ok(labeled.body.batchId);
  const undo = await request(
    port,
    "DELETE",
    `/api/imports/${encodeURIComponent(labeled.body.batchId)}`
  );
  assert.equal(undo.status, 200);
  assert.equal(undo.body.deletedTransactions, 1);

  server.close();
  emptyDb.close();
  console.log("Accounts + SimpleFIN + import checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
