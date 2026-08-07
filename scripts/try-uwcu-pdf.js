"use strict";

/**
 * One-shot: OCR + parse a UWCU PDF without writing to the live DB.
 * Usage: node scripts/try-uwcu-pdf.js "path\to\statement.pdf"
 */

const fs = require("node:fs");
const path = require("node:path");
const { rowsFromPdfBuffer } = require("../hub/import/pdf.js");

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/try-uwcu-pdf.js <pdf>");
    process.exit(1);
  }
  const absolute = path.resolve(filePath);
  const buffer = fs.readFileSync(absolute);
  console.log("OCR+parse", absolute, `(${buffer.length} bytes)…`);
  const started = Date.now();
  const result = await rowsFromPdfBuffer(buffer, "uwcu-checking", "cash", {
    accountTypes: { "uwcu-checking": "cash", "uwcu-savings": "cash" }
  });
  const summary = {
    method: result.method,
    ms: Date.now() - started,
    rows: result.rows.length,
    byAccount: result.rows.reduce((acc, row) => {
      acc[row.account] = (acc[row.account] || 0) + 1;
      return acc;
    }, {}),
    sample: result.rows.slice(0, 8).map((r) => ({
      account: r.account,
      date: r.date,
      merchant: r.rawMerchant.slice(0, 60),
      amount: r.amount,
      dir: r.directionHint
    }))
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
