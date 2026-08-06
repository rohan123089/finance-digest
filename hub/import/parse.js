"use strict";

/**
 * Parse CSV / OFX text into raw transaction rows for a single local account.
 */

const crypto = require("node:crypto");

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = cells[index] ?? "";
    });
    return obj;
  });
  return { headers, rows };
}

function pickField(row, names) {
  for (const name of names) {
    const key = Object.keys(row).find((k) => k === name || k.replace(/\s+/g, "") === name);
    if (key != null && row[key] !== "") return row[key];
  }
  return "";
}

function parseAmount(value) {
  const cleaned = String(value || "")
    .replace(/[$,]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .trim();
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : NaN;
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${year.padStart(4, "0")}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  const ofx = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (ofx) return `${ofx[1]}-${ofx[2]}-${ofx[3]}`;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return "";
}

function stableId(accountId, date, merchant, amount, index) {
  const digest = crypto
    .createHash("sha256")
    .update(`${accountId}|${date}|${merchant}|${amount}|${index}`)
    .digest("hex")
    .slice(0, 16);
  return `csv:${accountId}:${digest}`;
}

function directionHintFromSigned(amount, accountType) {
  if (!Number.isFinite(amount) || amount === 0) return "";
  if (accountType === "liability" || accountType === "external") {
    // Positive charge increases owed → out; payment/credit → in
    return amount > 0 ? "out" : "in";
  }
  // Cash/investment: negative usually means money out
  return amount < 0 ? "out" : "in";
}

function rowsFromCsv(text, accountId, accountType) {
  const { rows } = parseCsv(text);
  const out = [];
  rows.forEach((row, index) => {
    const date = normalizeDate(
      pickField(row, ["date", "trans date", "transaction date", "posted date", "post date"])
    );
    const rawMerchant = pickField(row, [
      "description",
      "rawmerchant",
      "merchant",
      "payee",
      "name",
      "memo"
    ]);
    const amount = parseAmount(
      pickField(row, ["amount", "amt", "transaction amount", "debit", "credit"])
    );
    if (!date || !rawMerchant || !Number.isFinite(amount)) return;
    const bankId = pickField(row, ["id", "transaction id", "reference", "ref"]);
    out.push({
      id: bankId ? `csv:${accountId}:${bankId}` : stableId(accountId, date, rawMerchant, amount, index),
      date,
      rawMerchant,
      amount: Math.abs(amount),
      account: accountId,
      directionHint: directionHintFromSigned(amount, accountType)
    });
  });
  return out;
}

function rowsFromOfx(text, accountId, accountType) {
  const body = String(text || "");
  const blocks = body.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  const out = [];
  blocks.forEach((block, index) => {
    const fitid = (block.match(/<FITID>([^<\r\n>]+)/i) || [])[1] || "";
    const posted = (block.match(/<DTPOSTED>([^<\r\n>]+)/i) || [])[1] || "";
    const amountRaw = (block.match(/<TRNAMT>([^<\r\n>]+)/i) || [])[1] || "";
    const name =
      (block.match(/<NAME>([^<\r\n>]+)/i) || [])[1] ||
      (block.match(/<MEMO>([^<\r\n>]+)/i) || [])[1] ||
      "";
    const date = normalizeDate(String(posted).trim());
    const amount = parseAmount(amountRaw);
    const rawMerchant = String(name).trim();
    if (!date || !rawMerchant || !Number.isFinite(amount)) return;
    out.push({
      id: fitid
        ? `ofx:${accountId}:${fitid}`
        : stableId(accountId, date, rawMerchant, amount, index),
      date,
      rawMerchant,
      amount: Math.abs(amount),
      account: accountId,
      directionHint: directionHintFromSigned(amount, accountType)
    });
  });
  return out;
}

function detectFormat(text, explicit) {
  if (explicit && explicit !== "auto") return explicit;
  const sample = String(text || "").slice(0, 400).toUpperCase();
  if (sample.includes("<OFX") || sample.includes("<STMTTRN>") || sample.includes("OFXHEADER")) {
    return "ofx";
  }
  return "csv";
}

function parseImport({ text, accountId, accountType, format }) {
  if (!accountId) throw new Error("accountId is required");
  const resolved = detectFormat(text, format);
  const rows =
    resolved === "ofx"
      ? rowsFromOfx(text, accountId, accountType)
      : rowsFromCsv(text, accountId, accountType);
  return { format: resolved, rows };
}

module.exports = {
  parseImport,
  detectFormat,
  rowsFromCsv,
  rowsFromOfx,
  parseCsv,
  normalizeDate,
  directionHintFromSigned
};
