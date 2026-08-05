"use strict";

const path = require("node:path");
const dbApi = require("../db.js");
const connectors = require("./index.js");

async function main() {
  const db = dbApi.openDatabase({
    dbPath: process.env.HUB_DB_PATH,
    passphrase: process.env.HUB_DB_PASSPHRASE
  });
  try {
    const result = await connectors.runAll(db, { forceMock: true });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
