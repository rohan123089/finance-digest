"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const Rules = require("../engine/rules.js");
const Model = require("../engine/model.js");

const ROOT = path.join(__dirname, "..");
const DEFAULT_DB_PATH = path.join(ROOT, "data", "finance.db");
const SAMPLE_PATH = path.join(ROOT, "sample-data", "transactions.json");

const STARTER_ACCOUNTS = [
  { id: "uwcu-checking", label: "UWCU Checking", type: "cash", openingBalance: 0 },
  { id: "uwcu-savings", label: "UWCU Savings", type: "cash", openingBalance: 0 },
  { id: "amex", label: "Amex", type: "liability", openingBalance: 0 },
  { id: "discover", label: "Discover", type: "liability", openingBalance: 0 },
  { id: "vanguard", label: "Vanguard", type: "investment", openingBalance: 0 },
  {
    id: "outside-payments",
    label: "Outside payments",
    type: "external",
    openingBalance: 0
  }
];

const SAMPLE_ACCOUNTS = [
  { id: "checking", label: "Checking", type: "cash", openingBalance: 6200 },
  { id: "savings", label: "Savings", type: "cash", openingBalance: 12000 },
  { id: "vanguard", label: "Vanguard", type: "investment", openingBalance: 28000 },
  {
    id: "outside-payments",
    label: "Outside payments",
    type: "external",
    openingBalance: 0
  }
];

/**
 * Opens a SQLCipher-compatible better-sqlite3 database. Key retrieval is kept
 * outside this module so the database layer never falls back to an environment
 * variable or a hardcoded passphrase.
 */

function openDatabase(options = {}) {
  const dbPath = options.dbPath || process.env.HUB_DB_PATH || DEFAULT_DB_PATH;
  const suppliedKey = options.encryptionKey || options.passphrase;
  if (!suppliedKey) {
    throw new Error("An OS-keychain database key is required");
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.key(
      Buffer.isBuffer(suppliedKey)
        ? suppliedKey
        : Buffer.from(String(suppliedKey), "utf8")
    );
    db.pragma("foreign_keys=ON");
    db._dbPath = dbPath;
    // better-sqlite3 writes directly to the encrypted database. Retained as a
    // compatibility hook for the existing data functions.
    db._persist = function persist() {};

    migrate(db);
    seedStarterAccounts(db);

    const seedSample =
      options.seedSample === true || process.env.HUB_SEED_SAMPLE === "1";
    if (countTransactions(db) === 0 && seedSample) {
      ensureSampleAccounts(db);
      seed(db, options.samplePath || SAMPLE_PATH);
    }
    return db;
  } catch (error) {
    db.close();
    throw new Error(`Unable to open encrypted database: ${error.message}`);
  }
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

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      opening_balance REAL NOT NULL DEFAULT 0,
      simplefin_account_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

  setMeta(db, "schemaVersion", "2");
  setMeta(db, "encryption", "sqlcipher");
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

function countAccounts(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c;
}

function rowToAccount(row) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    openingBalance: row.opening_balance,
    simplefinAccountId: row.simplefin_account_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listAccounts(db) {
  return db
    .prepare("SELECT * FROM accounts ORDER BY label COLLATE NOCASE, id")
    .all()
    .map(rowToAccount);
}

function getAccount(db, id) {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return row ? rowToAccount(row) : null;
}

function getAccountMaps(db) {
  const accounts = listAccounts(db);
  const accountTypes = {};
  const openingBalances = {};
  const labels = {};
  accounts.forEach((account) => {
    accountTypes[account.id] = account.type;
    openingBalances[account.id] = account.openingBalance;
    labels[account.id] = account.label;
  });
  return { accountTypes, openingBalances, labels, accounts };
}

function upsertAccountRow(db, account) {
  const now = new Date().toISOString();
  const type = String(account.type || "").toLowerCase();
  if (!Rules.VALID_ACCOUNT_TYPES.has(type)) {
    throw new Error(`Invalid account type: ${account.type}`);
  }
  const id = String(account.id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Account id is required");
  const label = String(account.label || id).trim();
  const openingBalance = Number(account.openingBalance);
  const simplefinAccountId =
    account.simplefinAccountId == null || account.simplefinAccountId === ""
      ? null
      : String(account.simplefinAccountId);

  db.prepare(`
    INSERT INTO accounts (
      id, label, type, opening_balance, simplefin_account_id, created_at, updated_at
    ) VALUES (
      @id, @label, @type, @openingBalance, @simplefinAccountId, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      type = excluded.type,
      opening_balance = excluded.opening_balance,
      simplefin_account_id = excluded.simplefin_account_id,
      updated_at = excluded.updated_at
  `).run({
    id,
    label,
    type,
    openingBalance: Number.isFinite(openingBalance) ? openingBalance : 0,
    simplefinAccountId,
    createdAt: now,
    updatedAt: now
  });
  return getAccount(db, id);
}

function createAccount(db, account) {
  if (getAccount(db, account.id)) {
    throw new Error(`Account already exists: ${account.id}`);
  }
  const created = upsertAccountRow(db, account);
  if (typeof db._persist === "function") db._persist();
  return created;
}

function updateAccount(db, id, patch) {
  const existing = getAccount(db, id);
  if (!existing) throw new Error(`Unknown account: ${id}`);
  const next = {
    id,
    label: patch.label != null ? patch.label : existing.label,
    type: patch.type != null ? patch.type : existing.type,
    openingBalance:
      patch.openingBalance != null ? patch.openingBalance : existing.openingBalance,
    simplefinAccountId:
      patch.simplefinAccountId !== undefined
        ? patch.simplefinAccountId
        : existing.simplefinAccountId
  };
  const updated = upsertAccountRow(db, next);
  if (typeof db._persist === "function") db._persist();
  return updated;
}

function findAccountBySimplefinId(db, simplefinAccountId) {
  const row = db
    .prepare("SELECT * FROM accounts WHERE simplefin_account_id = ?")
    .get(String(simplefinAccountId));
  return row ? rowToAccount(row) : null;
}

function seedStarterAccounts(db) {
  if (countAccounts(db) > 0) return;
  withTransaction(db, () => {
    STARTER_ACCOUNTS.forEach((account) => upsertAccountRow(db, account));
  });
  setMeta(db, "accountsSeeded", "starter");
}

function ensureSampleAccounts(db) {
  withTransaction(db, () => {
    SAMPLE_ACCOUNTS.forEach((account) => {
      if (!getAccount(db, account.id)) upsertAccountRow(db, account);
    });
  });
}

function seed(db, samplePath) {
  const raw = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const { accountTypes } = getAccountMaps(db);
  const normalized = Rules.normalizeTransactions(raw, accountTypes);
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
  const maps = getAccountMaps(db);
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
    ),
    accountTypes: maps.accountTypes,
    openingBalances: maps.openingBalances,
    accountLabels: maps.labels
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
  const { accountTypes } = getAccountMaps(db);
  const normalized = Rules.normalizeTransaction(raw, accountTypes);
  const now = new Date().toISOString();
  const result = db.prepare(`
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
  return { ...normalized, inserted: result.changes > 0 };
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
    expenses: snapshot.expenses,
    spendingByCategory: snapshot.spendingByCategory,
    recurring: snapshot.recurring,
    balances: snapshot.balances,
    safeToSpend: {
      period: snapshot.safeToSpend.period,
      amount: snapshot.safeToSpend.remaining,
      weeklyIncome: snapshot.safeToSpend.weeklyIncome,
      committed: snapshot.safeToSpend.committed,
      savingsTarget: snapshot.safeToSpend.savingsTarget,
      spent: snapshot.safeToSpend.spent,
      remaining: snapshot.safeToSpend.remaining
    },
    flags: []
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  STARTER_ACCOUNTS,
  openDatabase,
  listAccounts,
  getAccount,
  getAccountMaps,
  createAccount,
  updateAccount,
  findAccountBySimplefinId,
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
