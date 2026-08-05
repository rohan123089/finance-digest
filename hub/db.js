"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const Rules = require("../engine/rules.js");
const Model = require("../engine/model.js");

const ROOT = path.join(__dirname, "..");
const DEFAULT_DB_PATH = path.join(ROOT, "data", "finance.db.enc");
const SAMPLE_PATH = path.join(ROOT, "sample-data", "transactions.json");

/**
 * Encrypted-at-rest SQLite using Node's built-in node:sqlite plus AES-256-GCM
 * envelope encryption of the DB file. Chosen because native SQLCipher builds
 * (better-sqlite3 + SQLCipher) require Visual Studio tooling on Windows.
 */

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(String(passphrase), salt, 210000, 32, "sha512");
}

function encryptDbFile(plainPath, encPath, passphrase) {
  const plain = fs.readFileSync(plainPath);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([
    Buffer.from("FDDB1"),
    salt,
    iv,
    tag,
    encrypted
  ]);
  fs.writeFileSync(encPath, payload);
}

function decryptDbFile(encPath, plainPath, passphrase) {
  const payload = fs.readFileSync(encPath);
  const magic = payload.subarray(0, 5).toString("utf8");
  if (magic !== "FDDB1") {
    throw new Error("Unrecognized encrypted database format");
  }
  const salt = payload.subarray(5, 21);
  const iv = payload.subarray(21, 33);
  const tag = payload.subarray(33, 49);
  const encrypted = payload.subarray(49);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    fs.writeFileSync(plainPath, plain);
  } catch (error) {
    throw new Error(
      `Unable to decrypt database (wrong passphrase?): ${error.message}`
    );
  }
}

function openDatabase(options = {}) {
  const encPath = options.dbPath || process.env.HUB_DB_PATH || DEFAULT_DB_PATH;
  const passphrase =
    options.passphrase ||
    process.env.HUB_DB_PASSPHRASE ||
    "dev-passphrase-change-me";
  const plainPath = `${encPath}.work.sqlite`;

  fs.mkdirSync(path.dirname(encPath), { recursive: true });

  if (fs.existsSync(encPath)) {
    decryptDbFile(encPath, plainPath, passphrase);
  } else if (fs.existsSync(plainPath)) {
    fs.rmSync(plainPath);
  }

  const db = new DatabaseSync(plainPath);
  db._encPath = encPath;
  db._plainPath = plainPath;
  db._passphrase = passphrase;
  db._persist = function persist() {
    encryptDbFile(plainPath, encPath, passphrase);
  };
  const originalClose = db.close.bind(db);
  db.close = function closeEncrypted() {
    try {
      db._persist();
    } finally {
      originalClose();
      try {
        fs.rmSync(plainPath, { force: true });
      } catch (_error) {
        // ignore cleanup races
      }
    }
  };

  migrate(db);
  if (countTransactions(db) === 0) {
    seed(db, options.samplePath || SAMPLE_PATH);
    db._persist();
  }
  return db;
}

function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (_rollbackError) {
      // ignore
    }
    throw error;
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      raw_merchant TEXT NOT NULL,
      amount REAL NOT NULL,
      account TEXT NOT NULL,
      account_type TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      merchant TEXT NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      transfer_account TEXT NOT NULL DEFAULT '',
      suggested_transfer_account TEXT NOT NULL DEFAULT '',
      committed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT,
      at TEXT,
      collected_at TEXT,
      data_json TEXT NOT NULL,
      executed INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_cursors (
      name TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      target_ref_json TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      executed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connector_watermarks (
      source TEXT PRIMARY KEY,
      watermark TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_proposals (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      prompt_summary TEXT,
      proposal_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0
    );
  `);

  setMeta(db, "schemaVersion", "1");
  setMeta(db, "encryption", "aes-256-gcm-envelope");
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function getMeta(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function countTransactions(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM transactions").get().c;
}

function seed(db, samplePath) {
  const raw = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const normalized = Rules.normalizeTransactions(raw);
  const insert = db.prepare(`
    INSERT INTO transactions (
      id, date, raw_merchant, amount, account, account_type, direction, category,
      merchant, needs_review, transfer_account, suggested_transfer_account,
      committed_at, updated_at
    ) VALUES (
      @id, @date, @rawMerchant, @amount, @account, @accountType, @direction, @category,
      @merchant, @needsReview, @transferAccount, @suggestedTransferAccount,
      @committedAt, @updatedAt
    )
  `);

  const now = new Date().toISOString();
  withTransaction(db, () => {
    normalized.forEach((row, index) => {
      insert.run({
        id: row.id,
        date: row.date,
        rawMerchant: raw[index].rawMerchant,
        amount: row.amount,
        account: row.account,
        accountType: row.accountType,
        direction: row.direction || "",
        category: row.category || "",
        merchant: row.merchant,
        needsReview: row.needsReview ? 1 : 0,
        transferAccount: row.transferAccount || "",
        suggestedTransferAccount: row.suggestedTransferAccount || "",
        committedAt: null,
        updatedAt: now
      });
    });
  });
  setMeta(db, "seededFrom", samplePath);
}

function rowToTransaction(row) {
  return {
    id: row.id,
    date: row.date,
    rawMerchant: row.raw_merchant,
    amount: row.amount,
    account: row.account,
    accountType: row.account_type,
    direction: row.direction || "",
    category: row.category || "",
    merchant: row.merchant,
    needsReview: Boolean(row.needs_review),
    transferAccount: row.transfer_account || "",
    suggestedTransferAccount: row.suggested_transfer_account || "",
    committedAt: row.committed_at,
    updatedAt: row.updated_at
  };
}

function listTransactions(db) {
  return db
    .prepare("SELECT * FROM transactions ORDER BY date DESC, id DESC")
    .all()
    .map(rowToTransaction);
}

function getSettings(db) {
  return {
    asOfDate: getMeta(db, "asOfDate", Model.DEFAULT_CONFIG.asOfDate),
    monthlyIncome: Number(
      getMeta(db, "monthlyIncome", Model.DEFAULT_CONFIG.monthlyIncome)
    ),
    weeklyIncome: Number(
      getMeta(db, "weeklyIncome", Model.DEFAULT_CONFIG.monthlyIncome / 4.345)
    ),
    weeklySavingsTarget: Number(
      getMeta(
        db,
        "weeklySavingsTarget",
        Model.DEFAULT_CONFIG.weeklySavingsTarget
      )
    )
  };
}

function saveSettings(db, settings) {
  if (settings.asOfDate != null) setMeta(db, "asOfDate", settings.asOfDate);
  if (settings.monthlyIncome != null) {
    setMeta(db, "monthlyIncome", settings.monthlyIncome);
  }
  if (settings.weeklyIncome != null) {
    setMeta(db, "weeklyIncome", settings.weeklyIncome);
  }
  if (settings.weeklySavingsTarget != null) {
    setMeta(db, "weeklySavingsTarget", settings.weeklySavingsTarget);
  }
  if (typeof db._persist === "function") db._persist();
}

function computeLiveSnapshot(db, overrideSettings) {
  const settings = { ...getSettings(db), ...overrideSettings };
  return Model.computeSnapshot(listTransactions(db), settings);
}

function commitTransactions(db, updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("Commit requires at least one explicit update");
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE transactions
    SET direction = @direction,
        category = @category,
        transfer_account = @transferAccount,
        needs_review = @needsReview,
        committed_at = @committedAt,
        updated_at = @updatedAt
    WHERE id = @id
  `);

  withTransaction(db, () => {
    updates.forEach((row) => {
      const existing = db
        .prepare("SELECT id FROM transactions WHERE id = ?")
        .get(row.id);
      if (!existing) throw new Error(`Unknown transaction id: ${row.id}`);
      const direction = row.direction || "";
      const category = direction === "transfer" ? "" : row.category || "";
      const transferAccount =
        direction === "transfer" ? row.transferAccount || "" : "";
      const needsReview =
        !direction ||
        (direction === "transfer" && !transferAccount) ||
        (direction !== "transfer" && !category);
      stmt.run({
        id: row.id,
        direction,
        category,
        transferAccount,
        needsReview: needsReview ? 1 : 0,
        committedAt: now,
        updatedAt: now
      });
    });
  });
  if (typeof db._persist === "function") db._persist();
  return {
    committedAt: now,
    count: updates.length,
    transactions: listTransactions(db),
    snapshot: computeLiveSnapshot(db)
  };
}

function upsertSyncItem(db, item) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_items (
      id, type, source, at, collected_at, data_json, executed, result_json, updated_at
    ) VALUES (
      @id, @type, @source, @at, @collectedAt, @dataJson, @executed, @resultJson, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      source = excluded.source,
      at = excluded.at,
      collected_at = excluded.collected_at,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run({
    id: item.id,
    type: item.type,
    source: item.source || null,
    at: item.at || null,
    collectedAt: item.collectedAt || null,
    dataJson: JSON.stringify(item.data || {}),
    executed: 0,
    resultJson: null,
    updatedAt: now
  });
  if (typeof db._persist === "function") db._persist();
}

function listSyncItems(db) {
  return db
    .prepare("SELECT * FROM sync_items ORDER BY updated_at DESC")
    .all()
    .map((row) => ({
      id: row.id,
      type: row.type,
      source: row.source,
      at: row.at,
      collectedAt: row.collected_at,
      data: JSON.parse(row.data_json),
      executed: Boolean(row.executed),
      result: row.result_json ? JSON.parse(row.result_json) : null,
      updatedAt: row.updated_at
    }));
}

function markActionExecuted(db, id, status, detail) {
  const now = new Date().toISOString();
  const item = db.prepare("SELECT * FROM sync_items WHERE id = ?").get(id);
  if (!item) return;
  db.prepare(
    `UPDATE sync_items
     SET executed = 1, result_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify({ status, detail }), now, id);
  db.prepare(`
    INSERT INTO action_log (id, type, target_ref_json, status, detail, executed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      detail = excluded.detail,
      executed_at = excluded.executed_at
  `).run(
    id,
    item.type,
    JSON.stringify(JSON.parse(item.data_json).targetRef || null),
    status,
    detail || "",
    now
  );
  if (typeof db._persist === "function") db._persist();
}

function getCursor(db, name) {
  const row = db
    .prepare("SELECT value_json FROM sync_cursors WHERE name = ?")
    .get(name);
  return row ? JSON.parse(row.value_json) : {};
}

function setCursor(db, name, value) {
  db.prepare(`
    INSERT INTO sync_cursors(name, value_json) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json
  `).run(name, JSON.stringify(value));
  if (typeof db._persist === "function") db._persist();
}

function setConnectorWatermark(db, source, watermark) {
  db.prepare(`
    INSERT INTO connector_watermarks(source, watermark, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      watermark = excluded.watermark,
      updated_at = excluded.updated_at
  `).run(source, String(watermark), new Date().toISOString());
  if (typeof db._persist === "function") db._persist();
}

function getConnectorWatermark(db, source) {
  const row = db
    .prepare("SELECT watermark FROM connector_watermarks WHERE source = ?")
    .get(source);
  return row ? row.watermark : null;
}

function insertRawTransaction(db, raw) {
  const normalized = Rules.normalizeTransaction(raw);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions (
      id, date, raw_merchant, amount, account, account_type, direction, category,
      merchant, needs_review, transfer_account, suggested_transfer_account,
      committed_at, updated_at
    ) VALUES (
      @id, @date, @rawMerchant, @amount, @account, @accountType, @direction, @category,
      @merchant, @needsReview, @transferAccount, @suggestedTransferAccount,
      NULL, @updatedAt
    )
    ON CONFLICT(id) DO NOTHING
  `).run({
    id: normalized.id,
    date: normalized.date,
    rawMerchant: raw.rawMerchant,
    amount: normalized.amount,
    account: normalized.account,
    accountType: normalized.accountType,
    direction: normalized.direction || "",
    category: normalized.category || "",
    merchant: normalized.merchant,
    needsReview: normalized.needsReview ? 1 : 0,
    transferAccount: normalized.transferAccount || "",
    suggestedTransferAccount: normalized.suggestedTransferAccount || "",
    updatedAt: now
  });
  if (typeof db._persist === "function") db._persist();
  return normalized;
}

function saveAiProposal(db, proposal) {
  db.prepare(`
    INSERT INTO ai_proposals (id, mode, prompt_summary, proposal_json, created_at, accepted)
    VALUES (@id, @mode, @promptSummary, @proposalJson, @createdAt, 0)
  `).run({
    id: proposal.id,
    mode: proposal.mode,
    promptSummary: proposal.promptSummary || "",
    proposalJson: JSON.stringify(proposal.body),
    createdAt: proposal.createdAt
  });
  if (typeof db._persist === "function") db._persist();
}

function listAiProposals(db) {
  return db
    .prepare("SELECT * FROM ai_proposals ORDER BY created_at DESC")
    .all()
    .map((row) => ({
      id: row.id,
      mode: row.mode,
      promptSummary: row.prompt_summary,
      body: JSON.parse(row.proposal_json),
      createdAt: row.created_at,
      accepted: Boolean(row.accepted)
    }));
}

function redactSnapshot(snapshot) {
  return {
    netWorth: snapshot.netWorth,
    liquid: snapshot.liquid,
    invested: snapshot.invested,
    savingsRatePct: Math.round(snapshot.savingsRate * 1000) / 10,
    recurringMonthly: snapshot.recurringMonthly,
    runwayMonths: Math.round(snapshot.runwayMonths * 10) / 10,
    owed: snapshot.owed,
    safeToSpend: {
      period: snapshot.safeToSpend.period,
      amount: snapshot.safeToSpend.remaining,
      spent: snapshot.safeToSpend.spent,
      remaining: snapshot.safeToSpend.remaining
    },
    flags: []
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  openDatabase,
  listTransactions,
  getSettings,
  saveSettings,
  computeLiveSnapshot,
  commitTransactions,
  upsertSyncItem,
  listSyncItems,
  markActionExecuted,
  getCursor,
  setCursor,
  setConnectorWatermark,
  getConnectorWatermark,
  insertRawTransaction,
  saveAiProposal,
  listAiProposals,
  redactSnapshot,
  getMeta,
  setMeta
};
