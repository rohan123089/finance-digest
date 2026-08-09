"use strict";

/**
 * Parse CSV / OFX / statement-PDF text into raw transaction rows
 * for a single local account.
 */

const crypto = require("node:crypto");
const { rowsFromPdfText } = require("./pdf.js");

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
  const keys = Object.keys(row);
  for (const name of names) {
    const want = String(name || "")
      .toLowerCase()
      .replace(/\s+/g, "");
    const key = keys.find(
      (k) =>
        String(k || "")
          .toLowerCase()
          .replace(/\s+/g, "") === want
    );
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
  const Duplicates = require("../../engine/duplicates.js");
  const digest = crypto
    .createHash("sha256")
    .update(
      `${Duplicates.fingerprint(accountId, date, amount, merchant)}|${index}`
    )
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
  let endingBalance = null;
  let endingBalanceDate = "";
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
    const debit = parseAmount(
      pickField(row, ["debit", "withdrawal", "withdrawals", "amount debit"])
    );
    const credit = parseAmount(
      pickField(row, ["credit", "deposit", "deposits", "amount credit"])
    );
    let amount = parseAmount(
      pickField(row, ["amount", "amt", "transaction amount"])
    );
    if (!Number.isFinite(amount)) {
      if (Number.isFinite(debit) && debit !== 0) amount = -Math.abs(debit);
      else if (Number.isFinite(credit) && credit !== 0) amount = Math.abs(credit);
    }
    const balance = parseAmount(
      pickField(row, ["balance", "running balance", "ending balance", "available balance"])
    );
    // Newest statement balance wins (UWCU exports are often newest-first).
    if (Number.isFinite(balance) && date && (!endingBalanceDate || date >= endingBalanceDate)) {
      endingBalanceDate = date;
      endingBalance = roundCents(Math.abs(balance));
    }
    if (!date || !rawMerchant || !Number.isFinite(amount) || amount === 0) return;
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
  out.endingBalance = endingBalance;
  out.endingBalanceDate = endingBalanceDate || null;
  return out;
}

function roundCents(value) {
  return Math.round(Number(value) * 100) / 100;
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
  // Extracted PDF / statement paste: dated lines without CSV headers
  const raw = String(text || "");
  if (
    /\b(?:statement\s+(?:of\s+account|period)|transaction\s+history|beginning\s+balance|ending\s+balance|rewards\s+checking|savings\s+account|date\s+activity)\b/i.test(
      raw
    ) ||
    (/^\d{1,2}\/\d{1,2}/m.test(raw) && !/,/.test(raw.split(/\n/, 1)[0] || ""))
  ) {
    return "pdf";
  }
  return "csv";
}

function parseImport({ text, accountId, accountType, format }) {
  if (!accountId) throw new Error("accountId is required");
  const resolved = detectFormat(text, format);
  let rows;
  if (resolved === "ofx") {
    rows = rowsFromOfx(text, accountId, accountType);
  } else if (resolved === "pdf") {
    rows = rowsFromPdfText(text, accountId, accountType);
  } else {
    rows = rowsFromCsv(text, accountId, accountType);
  }
  return {
    format: resolved,
    rows,
    endingBalance: Number.isFinite(rows.endingBalance) ? rows.endingBalance : null,
    endingBalanceDate: rows.endingBalanceDate || null,
    endingBalancesByAccount: rows.endingBalancesByAccount || null
  };
}

module.exports = {
  parseImport,
  detectFormat,
  rowsFromCsv,
  rowsFromOfx,
  rowsFromPdfText,
  parseCsv,
  normalizeDate,
  directionHintFromSigned
};
