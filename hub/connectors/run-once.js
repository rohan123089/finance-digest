"use strict";

const path = require("node:path");
const dbApi = require("../db.js");
const secretStore = require("../secret-store.js");
const sync = require("../sync.js");
const connectors = require("./index.js");

async function main() {
  const projectRoot = path.join(__dirname, "..");
  const syncRoot = process.env.HUB_SYNC_ROOT || path.join(projectRoot, "sync");
  const dbPath = process.env.HUB_DB_PATH || dbApi.DEFAULT_DB_PATH;
  const encryptionKey = await secretStore.getOrCreateDatabaseKey(dbPath);
  const db = dbApi.openDatabase({ dbPath, encryptionKey });
  const forceMock = process.env.HUB_CONNECTORS_LIVE !== "1";
  try {
    const result = await connectors.runAll(db, { forceMock });
    await sync.publishDown(db, projectRoot, syncRoot);
    console.log(
      JSON.stringify(
        {
          ok: true,
          forceMock,
          groupme: { mode: result.groupme.mode, emitted: result.groupme.emitted.length },
          sms: { mode: result.sms.mode, emitted: result.sms.emitted.length },
          email: { mode: result.email.mode, emitted: result.email.emitted.length },
          bank: { mode: result.bank.mode, emitted: result.bank.emitted.length },
          simplefin: {
            mode: result.simplefin.mode,
            inserted: result.simplefin.inserted,
            unmapped: result.simplefin.unmapped?.length || 0
          }
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
