"use strict";

const dbApi = require("../db.js");
const { parseImport } = require("./parse.js");

function importText(db, options = {}) {
  const accountId = options.accountId;
  const account = dbApi.getAccount(db, accountId);
  if (!account) throw new Error(`Unknown account: ${accountId}`);

  const parsed = parseImport({
    text: options.text,
    accountId,
    accountType: account.type,
    format: options.format || "auto"
  });

  let inserted = 0;
  let skipped = 0;
  parsed.rows.forEach((row) => {
    const result = dbApi.insertRawTransaction(db, row);
    if (result.inserted) inserted += 1;
    else skipped += 1;
  });

  return {
    ok: true,
    accountId,
    format: parsed.format,
    parsed: parsed.rows.length,
    inserted,
    skipped,
    snapshot: dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db))
  };
}

module.exports = { importText };
