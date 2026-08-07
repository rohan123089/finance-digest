"use strict";

const crypto = require("node:crypto");
const dbApi = require("../db.js");
const { parseImport } = require("./parse.js");
const { extractPdfText, isPdfBuffer, rowsFromPdfText } = require("./pdf.js");
const Duplicates = require("../../engine/duplicates.js");

function contentHashFrom(text, base64) {
  const hash = crypto.createHash("sha256");
  if (base64) hash.update(Buffer.from(String(base64), "base64"));
  else hash.update(String(text || ""), "utf8");
  return hash.digest("hex");
}

async function importText(db, options = {}) {
  const accountId = options.accountId;
  const account = dbApi.getAccount(db, accountId);
  if (!account && accountId !== "uwcu-auto") {
    throw new Error(`Unknown account: ${accountId}`);
  }

  let text = options.text;
  let format = options.format || "auto";
  let extractMethod = "text";
  const maps = dbApi.getAccountMaps(db);
  const fallbackAccountId =
    accountId === "uwcu-auto" ? "uwcu-checking" : accountId;
  const fallbackType =
    account?.type || maps.accountTypes[fallbackAccountId] || "cash";

  const preHash = contentHashFrom(options.text, options.base64);
  const prior = dbApi.findImportBatchByContentHash(db, preHash);
  if (prior && prior.transactionsRemaining > 0) {
    return {
      ok: true,
      accountId: fallbackAccountId,
      format: prior.format || format,
      extractMethod: prior.extractMethod || "",
      label: prior.label,
      batchId: prior.id,
      parsed: 0,
      inserted: 0,
      skipped: prior.transactionsRemaining,
      linkedTransfers: 0,
      byAccount: prior.byAccount || {},
      duplicateFile: true,
      message: `Same file already imported (${prior.label || prior.id}) — skipped`,
      snapshot: dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db))
    };
  }

  if (options.base64) {
    const buffer = Buffer.from(String(options.base64), "base64");
    if (isPdfBuffer(buffer) || format === "pdf") {
      const extracted = await extractPdfText(buffer);
      text = extracted.text;
      extractMethod = extracted.method;
      format = "pdf";
    } else if (text == null) {
      text = buffer.toString("utf8");
    }
  }

  if (text == null) throw new Error("text or base64 is required");

  let rows;
  let resolvedFormat = format;
  if (format === "pdf" || (format === "auto" && options.base64)) {
    rows = rowsFromPdfText(text, fallbackAccountId, fallbackType, {
      accountTypes: maps.accountTypes
    });
    resolvedFormat = "pdf";
  } else {
    const parsed = parseImport({
      text,
      accountId: fallbackAccountId,
      accountType: fallbackType,
      format
    });
    rows = parsed.rows;
    resolvedFormat = parsed.format;
    if (resolvedFormat === "pdf") {
      rows = rowsFromPdfText(text, fallbackAccountId, fallbackType, {
        accountTypes: maps.accountTypes
      });
    }
  }

  if (resolvedFormat === "pdf" && rows.length === 0) {
    throw new Error(
      "No transactions found in PDF after OCR. Try the official UWCU e-statement download, or drop the file in chat so we can tune the parser."
    );
  }

  const label =
    String(options.label || options.fileName || "").trim().slice(0, 180) ||
    `${resolvedFormat.toUpperCase()} import`;

  const batch = dbApi.createImportBatch(db, {
    format: resolvedFormat,
    extractMethod,
    label,
    accountId: fallbackAccountId,
    insertedCount: 0,
    skippedCount: 0,
    byAccount: {},
    contentHash: preHash
  });

  let inserted = 0;
  let skipped = 0;
  const byAccount = {};
  rows.forEach((row) => {
    const target = dbApi.getAccount(db, row.account);
    if (!target) {
      skipped += 1;
      return;
    }
    const result = dbApi.insertRawTransaction(db, {
      ...row,
      importBatchId: batch.id,
      fingerprint: Duplicates.fingerprint(
        row.account,
        row.date,
        row.amount,
        row.rawMerchant
      )
    });
    if (result.inserted) {
      inserted += 1;
      byAccount[row.account] = (byAccount[row.account] || 0) + 1;
    } else {
      skipped += 1;
    }
  });

  const linked = dbApi.linkInternalTransfers(db);

  dbApi.updateImportBatchCounts(db, batch.id, {
    insertedCount: inserted,
    skippedCount: skipped,
    byAccount
  });

  return {
    ok: true,
    accountId: fallbackAccountId,
    format: resolvedFormat,
    extractMethod,
    label,
    batchId: batch.id,
    parsed: rows.length,
    inserted,
    skipped,
    linkedTransfers: linked.linked || 0,
    byAccount,
    duplicateFile: false,
    snapshot: dbApi.redactSnapshot(dbApi.computeLiveSnapshot(db))
  };
}

module.exports = { importText };
