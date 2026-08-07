"use strict";

/**
 * UWCU (and similar) statement PDF import.
 *
 * Real UWCU "View Document" downloads from the browser are Skia print PDFs:
 * image-only, no text layer. We OCR embedded page images, then split
 * REWARDS CHECKING / SAVINGS ACCOUNT sections into local accounts.
 */

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const pdfParse = require("pdf-parse");
const { createCanvas } = require("@napi-rs/canvas");
const Tesseract = require("tesseract.js");

const CHECKING_HEADER_RE =
  /\b(?:REWARDS\s+CHECKING|CHECKING\s+ACCOUNT|FREE\s+CHECKING|EVERYDAY\s+CHECKING)\b/i;
const SAVINGS_HEADER_RE = /\bSAVINGS\s+ACCOUNT\b/i;
const STOP_SECTION_RE =
  /\b(?:DEPOSIT\s+ACCOUNT\s+SUMMARY|Checking\s+Account\s+Summary|savings\s+Account\s+Summary|We're here for whatever|Equal Housing Opportunity)\b/i;

const SKIP_LINE_RE =
  /^(?:page\s*:?\s*\d|statement\s+(?:of account|period|date|summary|from)|account\s+(?:number|summary)|member\s+number|total\s+|beginning\s+balance|ending\s+balance|previous\s+(?:balance|statement)|new\s+balance|average\s+|avg\s+daily|interest\s+period|annual\s+percentage|dividend\s+rate|rate\s+summary|eff-date|continued|-{2,}\s*continued|date\s+activity|all\s+transactions|balance\s+fo|withdrawals\s+deposits|transaction\s+history|\*+|uwcu\.?org|po\s+box|#\w+)/i;

const FEE_NOTE_RE = /\binternational\s+transaction\s+fee\b|^\*+|\$\d+\.\d{2}\s+international/i;
const BALANCE_FORWARD_RE = /\bbalance\s+fo/i;

const IN_HINT_RE =
  /\b(?:deposit|credit|payroll|direct\s*dep|ach\s*credit|dividend|interest\s*(?:paid|credit)|refund|reversal|transfer\s+from|wire\s+in|cashout|zelle(?!\s+\w+\s+\d{3}-)|mobile\s+deposit)\b/i;
const OUT_HINT_RE =
  /\b(?:withdrawal|debit|purchase|pos\s|atm|fee|charge|payment|transfer\s+to|check\s+#|ach\s*debit|wire\s+out|web\s+pmts|epayment)\b/i;

/** Money tokens: 1,234.56 / .05 / 1,234.56- (UWCU withdrawal marker) */
const MONEY_TOKEN_RE = /(\d{1,3}(?:,\d{3})*\.\d{2}|\.\d{2})(-)?/g;

function isPdfBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return false;
  return buf.subarray(0, 5).toString("utf8") === "%PDF-";
}

function parseMoneyToken(amountText, trailingMinus) {
  const cleaned = String(amountText || "")
    .replace(/[$,]/g, "")
    .trim();
  let amount = Number(cleaned);
  if (!Number.isFinite(amount)) return NaN;
  amount = Math.round(amount * 100) / 100;
  if (trailingMinus) amount = -Math.abs(amount);
  return amount;
}

function roundCents(n) {
  return Math.round(Number(n) * 100) / 100;
}

function normalizeStatementDate(value, statementYear) {
  const raw = String(value || "").trim();
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!mdy) return "";
  const month = mdy[1].padStart(2, "0");
  const day = mdy[2].padStart(2, "0");
  let year = mdy[3];
  if (!year) {
    year = statementYear ? String(statementYear) : String(new Date().getFullYear());
  } else if (year.length === 2) {
    year = `20${year}`;
  }
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

function inferStatementYear(text) {
  const period = String(text || "").match(
    /\bStatement\s+Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/i
  );
  if (period) {
    const y = period[3];
    return Number(y.length === 2 ? `20${y}` : y);
  }
  const any = String(text || "").match(/\b(20\d{2})\b/);
  return any ? Number(any[1]) : new Date().getFullYear();
}

function directionFromDescription(description, signedAmount, accountType) {
  // Trailing "-" on UWCU amounts is authoritative over keyword guesses
  // (e.g. "Web Branch:zelle … 40.00-" is money out).
  if (Number.isFinite(signedAmount) && signedAmount < 0) return "out";
  if (IN_HINT_RE.test(description)) return "in";
  if (OUT_HINT_RE.test(description)) return "out";
  if (!Number.isFinite(signedAmount) || signedAmount === 0) return "";
  if (accountType === "liability" || accountType === "external") {
    return signedAmount > 0 ? "out" : "in";
  }
  return signedAmount > 0 ? "in" : "out";
}

function extractEmbeddedImages(buffer) {
  const s = buffer.toString("latin1");
  const images = [];
  const re =
    /<<([^>]*\/Subtype\s*\/Image[^>]*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = re.exec(s))) {
    const dict = match[1];
    const raw = Buffer.from(match[2], "latin1");
    const width = Number((dict.match(/\/Width\s+(\d+)/) || [])[1] || 0);
    const height = Number((dict.match(/\/Height\s+(\d+)/) || [])[1] || 0);
    const colorSpace = (dict.match(/\/ColorSpace\s*\/(\w+)/) || [])[1] || "";
    const filter = (dict.match(/\/Filter\s*\/(\w+)/) || [])[1] || "";
    const length = Number((dict.match(/\/Length\s+(\d+)/) || [])[1] || raw.length);
    if (!width || !height || width < 200 || height < 200) continue;
    images.push({
      width,
      height,
      colorSpace,
      filter,
      data: raw.slice(0, length)
    });
  }
  return images;
}

function decodeImageBytes(img) {
  let bytes = img.data;
  if (img.filter === "FlateDecode") bytes = zlib.inflateSync(bytes);
  return bytes;
}

function imageToPng(img, bytes) {
  const { width, height, colorSpace } = img;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  const grayExpected = width * height;
  const rgbExpected = width * height * 3;
  const asGray =
    colorSpace === "DeviceGray" ||
    (colorSpace !== "DeviceRGB" && bytes.length === grayExpected);

  if (asGray && bytes.length >= grayExpected) {
    for (let i = 0; i < grayExpected; i += 1) {
      const v = bytes[i];
      const o = i * 4;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  } else if (bytes.length >= rgbExpected) {
    for (let i = 0; i < width * height; i += 1) {
      const s = i * 3;
      const o = i * 4;
      out[o] = bytes[s];
      out[o + 1] = bytes[s + 1];
      out[o + 2] = bytes[s + 2];
      out[o + 3] = 255;
    }
  } else {
    throw new Error(
      `Unsupported PDF image (${colorSpace || "unknown"} ${bytes.length}b ${width}x${height})`
    );
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer("image/png");
}

async function ocrPdfImages(buffer) {
  const images = extractEmbeddedImages(buffer);
  if (!images.length) {
    throw new Error(
      "PDF has no readable text or page images. Re-download the UWCU e-statement (not a blank print)."
    );
  }

  const worker = await Tesseract.createWorker("eng");
  const parts = [];
  try {
    for (const img of images) {
      let bytes;
      try {
        bytes = decodeImageBytes(img);
      } catch {
        continue;
      }
      let png;
      try {
        png = imageToPng(img, bytes);
      } catch {
        continue;
      }
      const result = await worker.recognize(png);
      const text = String(result.data?.text || "").trim();
      if (text.length >= 40) parts.push(text);
    }
  } finally {
    await worker.terminate();
  }

  if (!parts.length) {
    throw new Error("OCR found no statement text in the PDF images.");
  }
  return parts.join("\n\n");
}

async function extractPdfText(buffer) {
  try {
    const data = await pdfParse(buffer);
    const text = String(data.text || "").replace(/\r\n/g, "\n").trim();
    if (text.length >= 80) return { text, method: "text" };
  } catch {
    // fall through to OCR
  }
  const text = await ocrPdfImages(buffer);
  return { text, method: "ocr" };
}

function collectMoneyTokens(line) {
  const out = [];
  const re = new RegExp(MONEY_TOKEN_RE.source, "g");
  let m;
  while ((m = re.exec(line))) {
    out.push({
      raw: m[0],
      index: m.index,
      value: parseMoneyToken(m[1], Boolean(m[2]))
    });
  }
  return out.filter((t) => Number.isFinite(t.value));
}

function resolveAccountId(headerLine, fallbackAccountId) {
  if (SAVINGS_HEADER_RE.test(headerLine)) return "uwcu-savings";
  if (CHECKING_HEADER_RE.test(headerLine)) return "uwcu-checking";
  return fallbackAccountId;
}

function stableRowId(accountId, date, merchant, amount) {
  const Duplicates = require("../../engine/duplicates.js");
  const digest = crypto
    .createHash("sha256")
    .update(
      Duplicates.fingerprint(accountId, date, amount, merchant)
    )
    .digest("hex")
    .slice(0, 16);
  return `pdf:${accountId}:${digest}`;
}

/**
 * Parse UWCU-style OCR/text into rows, splitting checking vs savings sections.
 */
function rowsFromPdfText(text, accountId, accountType, options = {}) {
  const body = String(text || "");
  const year = inferStatementYear(body);
  const accountTypes = options.accountTypes || {};
  const lines = body
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const out = [];
  let currentAccountId = accountId;
  let pending = null;
  let lastBalance = null;
  let collecting = true;

  function accountTypeFor(id) {
    return accountTypes[id] || accountType || "cash";
  }

  function flushPending() {
    if (!pending) return;
    const row = pending;
    pending = null;
    if (!row.date || !row.description || !row.amounts.length) return;
    if (BALANCE_FORWARD_RE.test(row.description)) {
      if (row.amounts.length) lastBalance = roundCents(Math.abs(row.amounts[row.amounts.length - 1]));
      return;
    }

    let signed;
    let balance = null;
    // UWCU lines are: amount [optional trailing -] + running balance.
    // Ignore extra OCR money tokens (fee footnotes, etc.).
    if (row.amounts.length >= 2) {
      balance = roundCents(Math.abs(row.amounts[row.amounts.length - 1]));
      signed = row.amounts[row.amounts.length - 2];
    } else if (row.amounts.length === 1 && lastBalance != null) {
      // OCR sometimes drops the txn amount and only leaves the new balance.
      const only = roundCents(Math.abs(row.amounts[0]));
      const delta = roundCents(only - lastBalance);
      if (Math.abs(delta) >= 0.01 && Math.abs(delta) < only) {
        signed = delta;
        balance = only;
      } else {
        signed = row.amounts[0];
      }
    } else {
      signed = row.amounts[0];
    }
    if (!Number.isFinite(signed) || signed === 0) return;

    // If OCR dropped the trailing "-", infer from balance movement.
    if (
      balance != null &&
      lastBalance != null &&
      Math.abs(Math.abs(signed) - Math.abs(roundCents(balance - lastBalance))) < 0.02
    ) {
      signed = roundCents(balance - lastBalance);
    } else if (
      balance != null &&
      lastBalance != null &&
      signed > 0 &&
      balance < lastBalance - 0.005
    ) {
      signed = -Math.abs(signed);
    }

    const rawMerchant = row.description
      .replace(/\s*-{2,}\s*continued on next page.*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (!rawMerchant || SKIP_LINE_RE.test(rawMerchant)) return;

    const abs = roundCents(Math.abs(signed));
    if (!abs) return;
    out.push({
      id: stableRowId(currentAccountId, row.date, rawMerchant, abs),
      date: row.date,
      rawMerchant,
      amount: abs,
      account: currentAccountId,
      directionHint: directionFromDescription(
        rawMerchant,
        signed,
        accountTypeFor(currentAccountId)
      )
    });
    if (balance != null) lastBalance = roundCents(balance);
  }

  for (const line of lines) {
    if (CHECKING_HEADER_RE.test(line) || SAVINGS_HEADER_RE.test(line)) {
      flushPending();
      currentAccountId = resolveAccountId(line, accountId);
      lastBalance = null;
      collecting = true;
      continue;
    }
    if (STOP_SECTION_RE.test(line)) {
      flushPending();
      collecting = false;
      continue;
    }
    if (!collecting) continue;
    if (SKIP_LINE_RE.test(line)) {
      flushPending();
      continue;
    }

    const dated = line.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+)$/);
    if (dated) {
      const dateToken = dated[1];
      const rest = dated[2];
      const tokens = collectMoneyTokens(rest);
      // Merchant continuation: MM/DD/YY NAME with no amounts
      if (!tokens.length && /\/\d{2,4}$/.test(dateToken) && pending) {
        pending.description = `${pending.description} ${rest}`.trim();
        continue;
      }
      flushPending();
      let description = rest;
      if (tokens.length) {
        description = rest.slice(0, tokens[0].index).trim();
      }
      if (BALANCE_FORWARD_RE.test(description)) {
        if (tokens.length) lastBalance = roundCents(Math.abs(tokens[tokens.length - 1].value));
        pending = null;
        continue;
      }
      if (!description) continue;
      // Keep only the last two money tokens from the dated line (txn + balance).
      const capped =
        tokens.length <= 2 ? tokens : tokens.slice(tokens.length - 2);
      pending = {
        date: normalizeStatementDate(dateToken, year),
        description,
        amounts: capped.map((t) => t.value)
      };
      continue;
    }

    if (FEE_NOTE_RE.test(line)) continue;

    if (pending && !collectMoneyTokens(line).length && !/^\d{1,2}\/\d{1,2}/.test(line)) {
      pending.description = `${pending.description} ${line}`.trim();
      continue;
    }

    // Continuation lines: merchant text only — never extra money tokens
    // (OCR fee footnotes like "$0.05 INTERNATIONAL…" corrupt amount/balance).
    if (pending) {
      const descPart = line.replace(MONEY_TOKEN_RE, "").trim();
      if (descPart && !FEE_NOTE_RE.test(line) && !/^\*/.test(descPart)) {
        pending.description = `${pending.description} ${descPart}`.trim();
      }
    }
  }

  flushPending();
  return out;
}

async function rowsFromPdfBuffer(buffer, accountId, accountType, options = {}) {
  const extracted = await extractPdfText(buffer);
  return {
    text: extracted.text,
    method: extracted.method,
    rows: rowsFromPdfText(extracted.text, accountId, accountType, options)
  };
}

module.exports = {
  isPdfBuffer,
  extractPdfText,
  ocrPdfImages,
  rowsFromPdfText,
  rowsFromPdfBuffer,
  normalizeStatementDate,
  parseMoneyToken,
  collectMoneyTokens,
  extractEmbeddedImages
};
