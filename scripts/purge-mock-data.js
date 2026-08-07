"use strict";

/**
 * Remove leftover demo/seed artifacts from the live hub DB.
 * Does not touch real SimpleFIN / import transactions.
 */

const secretStore = require("../hub/secret-store");
const dbApi = require("../hub/db");
const sync = require("../hub/sync");
const path = require("node:path");

async function main() {
  const projectRoot = path.join(__dirname, "..");
  const syncRoot = process.env.HUB_SYNC_ROOT || path.join(projectRoot, "sync");
  const key = await secretStore.getOrCreateDatabaseKey(dbApi.DEFAULT_DB_PATH);
  const db = dbApi.openDatabase({
    dbPath: dbApi.DEFAULT_DB_PATH,
    encryptionKey: key
  });
  try {
    const demoTx = dbApi.purgeDemoTransactions(db);
    const fakeTx = db
      .prepare(
        `DELETE FROM transactions
         WHERE id LIKE 'bank-tx-%'
            OR id LIKE '%:sf-tx-%'
            OR id IN ('sf-tx-1', 'sf-tx-2')`
      )
      .run();

    // Deactivate $0 template bills so Digest doesn't show fake rent/etc.
    const bills = db
      .prepare(
        `UPDATE bills SET active = 0, updated_at = ?
         WHERE amount <= 0 AND active = 1`
      )
      .run(new Date().toISOString());

    // Drop stale sample-seed marker if demo rows are gone.
    if (dbApi.getMeta(db, "seededFrom")) {
      db.prepare("DELETE FROM meta WHERE key = ?").run("seededFrom");
    }

    // Remove mock-shaped life sync items (UWCU statement emails from connectors mock, etc.)
    const mockSync = db
      .prepare(
        `DELETE FROM sync_items
         WHERE id LIKE 'life:%'
            OR id LIKE 'groupme:%'
            OR id LIKE 'sms:%'
            OR id LIKE 'mail-%'
            OR source IN ('mock', 'demo')`
      )
      .run();

    const aiCleared = db.prepare("DELETE FROM ai_proposals").run();
    dbApi.setMeta(db, "aiMode", "OFF");

    await sync.publishDown(db, projectRoot, syncRoot);

    console.log(
      JSON.stringify(
        {
          ok: true,
          deletedDemoTx: demoTx.deleted,
          deletedFakeConnectorTx: fakeTx.changes || 0,
          deactivatedZeroBills: bills.changes || 0,
          deletedMockSyncItems: mockSync.changes || 0,
          clearedAiProposals: aiCleared.changes || 0,
          aiMode: "OFF",
          clearedSeededFrom: true,
          transactionsRemaining: dbApi.listTransactions(db).length
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
