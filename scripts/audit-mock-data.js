"use strict";

const secretStore = require("../hub/secret-store");
const dbApi = require("../hub/db");

async function main() {
  const key = await secretStore.getOrCreateDatabaseKey(dbApi.DEFAULT_DB_PATH);
  const db = dbApi.openDatabase({
    dbPath: dbApi.DEFAULT_DB_PATH,
    encryptionKey: key
  });
  try {
    const txs = db
      .prepare(
        `SELECT id, account, raw_merchant, amount FROM transactions
         WHERE id LIKE 'tx-%'
            OR id LIKE 'bank-tx-%'
            OR id LIKE 'sf:amex:sf-tx-%'
            OR id LIKE 'sf:%:sf-tx-%'
            OR account IN ('checking', 'savings')
         LIMIT 100`
      )
      .all();
    const allPrefixes = db
      .prepare(
        `SELECT CASE
           WHEN id LIKE 'sf:%' THEN 'sf'
           WHEN id LIKE 'pdf:%' THEN 'pdf'
           WHEN id LIKE 'csv:%' THEN 'csv'
           WHEN id LIKE 'ofx:%' THEN 'ofx'
           WHEN id LIKE 'tx-%' THEN 'tx'
           WHEN id LIKE 'bank-tx-%' THEN 'bank-tx'
           ELSE 'other'
         END AS prefix, COUNT(*) AS c
         FROM transactions GROUP BY 1`
      )
      .all();
    const sync = dbApi.listSyncItems(db);
    const syncSample = sync.slice(0, 40).map((i) => ({
      id: i.id,
      type: i.type,
      source: i.source,
      title: i.data?.title || i.data?.subject || i.data?.kind || ""
    }));
    const accounts = dbApi.listAccounts(db).map((a) => ({
      id: a.id,
      label: a.label,
      opening: a.openingBalance,
      sf: a.simplefinAccountId
    }));
    const offers = db
      .prepare("SELECT id, title, source, account_id FROM rewards_offers")
      .all();
    const meta = db.prepare("SELECT key, value FROM meta").all();

    console.log(
      JSON.stringify(
        {
          txCount: dbApi.listTransactions(db).length,
          prefixes: allPrefixes,
          suspiciousTxs: txs,
          syncCount: sync.length,
          syncSample,
          accounts,
          offers,
          meta
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
