"use strict";

/**
 * Remove Milestone-1 demo transactions (tx-*) and legacy checking/savings
 * accounts that were seeded alongside real imports.
 */
const secretStore = require("../hub/secret-store");
const dbApi = require("../hub/db");
const Model = require("../engine/model");

async function main() {
  const encryptionKey = await secretStore.getOrCreateDatabaseKey(dbApi.DEFAULT_DB_PATH);
  const db = dbApi.openDatabase({ dbPath: dbApi.DEFAULT_DB_PATH, encryptionKey });
  const before = dbApi.listTransactions(db).length;
  const result = dbApi.purgeDemoTransactions(db);
  dbApi.saveSettings(db, { asOfDate: Model.todayIso() });
  const after = dbApi.listTransactions(db).length;
  const snap = dbApi.computeLiveSnapshot(db);
  console.log(
    JSON.stringify(
      {
        deleted: result.deleted,
        transactionsBefore: before,
        transactionsAfter: after,
        asOfDate: Model.todayIso(),
        snapshot: {
          netWorth: snap.netWorth,
          liquid: snap.liquid,
          invested: snap.invested,
          owed: snap.owed,
          expensesThisMonth: snap.expensesThisMonth,
          balances: snap.balances
        }
      },
      null,
      2
    )
  );
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
