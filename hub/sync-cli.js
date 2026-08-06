"use strict";

const path = require("node:path");
const dbApi = require("./db.js");
const secretStore = require("./secret-store.js");
const sync = require("./sync.js");

async function main() {
  const projectRoot = path.join(__dirname, "..");
  const syncRoot = process.env.HUB_SYNC_ROOT || path.join(projectRoot, "sync");
  const dbPath = process.env.HUB_DB_PATH || dbApi.DEFAULT_DB_PATH;
  const encryptionKey = await secretStore.getOrCreateDatabaseKey(dbPath);
  const db = dbApi.openDatabase({ dbPath, encryptionKey });
  try {
    const processed = await sync.ingestAllPending(db, projectRoot, syncRoot);
    console.log(JSON.stringify({ ok: true, processed }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
