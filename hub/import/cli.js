"use strict";

/**
 * CLI: npm run import:file -- --account uwcu-checking --file path.pdf [--format csv|ofx|pdf|auto]
 */

const fs = require("node:fs");
const path = require("node:path");
const dbApi = require("../db.js");
const secretStore = require("../secret-store.js");
const { importText } = require("./index.js");
const { isPdfBuffer } = require("./pdf.js");

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
      "Usage: node hub/import/cli.js --account <id> --file <path> [--format csv|ofx|pdf|auto]"
    );
    process.exit(1);
  }

  const absolute = path.resolve(filePath);
  const buffer = fs.readFileSync(absolute);
  const projectRoot = path.join(__dirname, "..");
  const dbPath = process.env.HUB_DB_PATH || dbApi.DEFAULT_DB_PATH;
  const encryptionKey = await secretStore.getOrCreateDatabaseKey(dbPath);
  const db = dbApi.openDatabase({ dbPath, encryptionKey });
  try {
    const opts = { accountId, format, label: path.basename(absolute) };
    if (isPdfBuffer(buffer) || /\.pdf$/i.test(absolute) || format === "pdf") {
      opts.base64 = buffer.toString("base64");
      opts.format = format === "auto" ? "pdf" : format;
    } else {
      opts.text = buffer.toString("utf8");
    }
    const result = await importText(db, opts);
    console.log(JSON.stringify({ ...result, file: absolute, projectRoot }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
