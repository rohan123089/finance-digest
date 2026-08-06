"use strict";

/**
 * CLI: npm run import:file -- --account amex --file path.csv [--format csv|ofx|auto]
 */

const fs = require("node:fs");
const path = require("node:path");
const dbApi = require("../db.js");
const secretStore = require("../secret-store.js");
const { importText } = require("./index.js");

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  const accountId = readArg("--account");
  const filePath = readArg("--file");
  const format = readArg("--format") || "auto";
  if (!accountId || !filePath) {
    console.error(
      "Usage: node hub/import/cli.js --account <id> --file <path> [--format csv|ofx|auto]"
    );
    process.exit(1);
  }

  const absolute = path.resolve(filePath);
  const text = fs.readFileSync(absolute, "utf8");
  const projectRoot = path.join(__dirname, "..");
  const dbPath = process.env.HUB_DB_PATH || dbApi.DEFAULT_DB_PATH;
  const encryptionKey = await secretStore.getOrCreateDatabaseKey(dbPath);
  const db = dbApi.openDatabase({ dbPath, encryptionKey });
  try {
    const result = importText(db, { accountId, text, format });
    console.log(JSON.stringify({ ...result, file: absolute, projectRoot }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
