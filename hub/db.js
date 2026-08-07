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

    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      cadence TEXT NOT NULL DEFAULT 'monthly',
      due_day INTEGER NOT NULL,
      lead_days INTEGER NOT NULL DEFAULT 3,
      category TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      last_paid_for TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rewards_rules (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      category TEXT NOT NULL,
      rate_pct REAL NOT NULL,
      cap_usd REAL,
      priority INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'seed',
      valid_from TEXT,
      valid_to TEXT,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rewards_offers (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      merchant_contains TEXT NOT NULL DEFAULT '',
      rate_pct REAL NOT NULL,
      starts_on TEXT,
      ends_on TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      url TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT '',
      extract_method TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      inserted_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      by_account_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  ensureColumn(db, "transactions", "import_batch_id", "TEXT");
  ensureColumn(db, "transactions", "duplicate_of", "TEXT");
  ensureColumn(db, "transactions", "fingerprint", "TEXT");
  ensureColumn(db, "accounts", "holdings_json", "TEXT");
  ensureColumn(db, "import_batches", "content_hash", "TEXT");
  backfillFingerprints(db);
  setMeta(db, "schemaVersion", "6");
  setMeta(db, "encryption", "sqlcipher");
  seedDefaultBills(db);
  seedRewardsBaselines(db);
}

function backfillFingerprints(db) {
  const Duplicates = require("../engine/duplicates.js");
  const rows = db
    .prepare(
      `SELECT id, account, date, amount, raw_merchant, merchant, fingerprint
       FROM transactions
       WHERE fingerprint IS NULL OR fingerprint = ''`
    )
    .all();
  if (!rows.length) return;
  const update = db.prepare(
    `UPDATE transactions SET fingerprint = ? WHERE id = ?`
  );
  const run = db.transaction(() => {
    rows.forEach((row) => {
      const fp = Duplicates.fingerprint(
        row.account,
        row.date,
        row.amount,
        row.raw_merchant || row.merchant
      );
      update.run(fp, row.id);
    });
  });
  run();
}

function ensureColumn(db, table, column, sqlType) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }
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

function seedDefaultBills(db) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM bills").get().c;
  if (count > 0) return;
  const now = new Date().toISOString();
  const defaults = [
    {
      id: "bill:rent",
      title: "Rent",
      amount: 0,
      dueDay: 1,
      leadDays: 5,
      category: "housing",
      active: 0,
      notes: "Enable and set your rent amount in Money → Bills"
    },
    {
      id: "bill:utilities",
      title: "Utilities",
      amount: 0,
      dueDay: 15,
      leadDays: 3,
      category: "utilities",
      active: 0,
      notes: "Enable and set amount when ready"
    },
    {
      id: "bill:subscriptions",
      title: "Subscriptions bundle",
      amount: 0,
      dueDay: 1,
      leadDays: 3,
      category: "subscriptions",
      active: 0,
      notes: "Enable and set amount when ready"
    }
  ];
  const stmt = db.prepare(`
    INSERT INTO bills (
      id, title, amount, cadence, due_day, lead_days, category, active,
      last_paid_for, notes, created_at, updated_at
    ) VALUES (
      @id, @title, @amount, 'monthly', @dueDay, @leadDays, @category, @active,
      NULL, @notes, @now, @now
    )
  `);
  defaults.forEach((bill) => {
    stmt.run({ ...bill, now });
  });
}

function seedRewardsBaselines(db) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM rewards_rules").get().c;
  if (count > 0) return;
  const now = new Date().toISOString();
  const seeds = [
    {
      id: "rule:discover:*",
      accountId: "discover",
      category: "*",
      ratePct: 1,
      capUsd: null,
      priority: 0,
      notes: "Discover baseline cash back"
    },
    {
      id: "rule:amex:*",
      accountId: "amex",
      category: "*",
      ratePct: 1,
      capUsd: null,
      priority: 0,
      notes: "Amex default — edit for your product"
    },
    {
      id: "rule:amex:groceries",
      accountId: "amex",
      category: "groceries",
      ratePct: 3,
      capUsd: 6000,
      priority: 10,
      notes: "Seed; edit to match your Amex"
    },
    {
      id: "rule:amex:transportation",
      accountId: "amex",
      category: "transportation",
      ratePct: 2,
      capUsd: null,
      priority: 10,
      notes: "Seed gas/transit; edit to match your Amex"
    },
    {
      id: "rule:amex:dining",
      accountId: "amex",
      category: "dining",
      ratePct: 1,
      capUsd: null,
      priority: 5,
      notes: "Seed; edit to match your Amex"
    }
  ];
  const insert = db.prepare(`
    INSERT INTO rewards_rules (
      id, account_id, category, rate_pct, cap_usd, priority, source,
      valid_from, valid_to, notes, updated_at
    ) VALUES (
      @id, @accountId, @category, @ratePct, @capUsd, @priority, 'seed',
      NULL, NULL, @notes, @updatedAt
    )
  `);
  seeds.forEach((row) =>
    insert.run({
      id: row.id,
      accountId: row.accountId,
      category: row.category,
      ratePct: row.ratePct,
      capUsd: row.capUsd,
      priority: row.priority,
      notes: row.notes,
      updatedAt: now
    })
  );
  setMeta(db, "rewardsSeeded", "1");
}

function rowToRewardsRule(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    category: row.category,
    ratePct: row.rate_pct,
    capUsd: row.cap_usd == null ? null : row.cap_usd,
    priority: row.priority,
    source: row.source,
    validFrom: row.valid_from || null,
    validTo: row.valid_to || null,
    notes: row.notes || "",
    updatedAt: row.updated_at
  };
}

function rowToRewardsOffer(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    category: row.category || "",
    merchantContains: row.merchant_contains || "",
    ratePct: row.rate_pct,
    startsOn: row.starts_on || null,
    endsOn: row.ends_on || null,
    source: row.source,
    url: row.url || "",
    active: Boolean(row.active),
    updatedAt: row.updated_at
  };
}

function listRewardsRules(db) {
  return db
    .prepare(
      "SELECT * FROM rewards_rules ORDER BY account_id, priority DESC, category"
    )
    .all()
    .map(rowToRewardsRule);
}

function getRewardsRule(db, id) {
  const row = db.prepare("SELECT * FROM rewards_rules WHERE id = ?").get(id);
  return row ? rowToRewardsRule(row) : null;
}

function upsertRewardsRule(db, rule, options = {}) {
  const existing = getRewardsRule(db, rule.id);
  if (existing && existing.source === "manual" && options.fromWeb) {
    return existing;
  }
  const now = new Date().toISOString();
  const source = rule.source || existing?.source || "manual";
  db.prepare(`
    INSERT INTO rewards_rules (
      id, account_id, category, rate_pct, cap_usd, priority, source,
      valid_from, valid_to, notes, updated_at
    ) VALUES (
      @id, @accountId, @category, @ratePct, @capUsd, @priority, @source,
      @validFrom, @validTo, @notes, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      account_id = excluded.account_id,
      category = excluded.category,
      rate_pct = excluded.rate_pct,
      cap_usd = excluded.cap_usd,
      priority = excluded.priority,
      source = CASE
        WHEN rewards_rules.source = 'manual' THEN rewards_rules.source
        ELSE excluded.source
      END,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      notes = CASE
        WHEN rewards_rules.source = 'manual' AND excluded.source != 'manual'
          THEN rewards_rules.notes
        ELSE excluded.notes
      END,
      updated_at = excluded.updated_at
    WHERE rewards_rules.source != 'manual' OR excluded.source = 'manual'
  `).run({
    id: String(rule.id),
    accountId: String(rule.accountId),
    category: String(rule.category || "*"),
    ratePct: Number(rule.ratePct) || 0,
    capUsd: rule.capUsd == null || rule.capUsd === "" ? null : Number(rule.capUsd),
    priority: Number(rule.priority) || 0,
    source,
    validFrom: rule.validFrom || null,
    validTo: rule.validTo || null,
    notes: rule.notes || "",
    updatedAt: now
  });
  if (typeof db._persist === "function") db._persist();
  return getRewardsRule(db, rule.id);
}

function deleteRewardsRule(db, id) {
  const existing = getRewardsRule(db, id);
  if (!existing) throw new Error(`Unknown rewards rule: ${id}`);
  db.prepare("DELETE FROM rewards_rules WHERE id = ?").run(id);
  if (typeof db._persist === "function") db._persist();
  return { ok: true, id };
}

function listRewardsOffers(db, options = {}) {
  let rows = db
    .prepare(
      "SELECT * FROM rewards_offers ORDER BY active DESC, ends_on, account_id, title"
    )
    .all()
    .map(rowToRewardsOffer);
  if (options.activeOnly) rows = rows.filter((row) => row.active);
  return rows;
}

function getRewardsOffer(db, id) {
  const row = db.prepare("SELECT * FROM rewards_offers WHERE id = ?").get(id);
  return row ? rowToRewardsOffer(row) : null;
}

function upsertRewardsOffer(db, offer, options = {}) {
  const existing = getRewardsOffer(db, offer.id);
  if (existing && existing.source === "manual" && options.fromWeb) {
    return existing;
  }
  const now = new Date().toISOString();
  const source = offer.source || existing?.source || "manual";
  db.prepare(`
    INSERT INTO rewards_offers (
      id, account_id, title, category, merchant_contains, rate_pct,
      starts_on, ends_on, source, url, active, updated_at
    ) VALUES (
      @id, @accountId, @title, @category, @merchantContains, @ratePct,
      @startsOn, @endsOn, @source, @url, @active, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      account_id = excluded.account_id,
      title = excluded.title,
      category = excluded.category,
      merchant_contains = excluded.merchant_contains,
      rate_pct = excluded.rate_pct,
      starts_on = excluded.starts_on,
      ends_on = excluded.ends_on,
      source = CASE
        WHEN rewards_offers.source = 'manual' THEN rewards_offers.source
        ELSE excluded.source
      END,
      url = excluded.url,
      active = excluded.active,
      updated_at = excluded.updated_at
    WHERE rewards_offers.source != 'manual' OR excluded.source = 'manual'
  `).run({
    id: String(offer.id),
    accountId: String(offer.accountId),
    title: String(offer.title || "Offer"),
    category: String(offer.category || ""),
    merchantContains: String(offer.merchantContains || ""),
    ratePct: Number(offer.ratePct) || 0,
    startsOn: offer.startsOn || null,
    endsOn: offer.endsOn || null,
    source,
    url: offer.url || "",
    active: offer.active === false || offer.active === 0 ? 0 : 1,
    updatedAt: now
  });
  if (typeof db._persist === "function") db._persist();
  return getRewardsOffer(db, offer.id);
}

function deleteRewardsOffer(db, id) {
  const existing = getRewardsOffer(db, id);
  if (!existing) throw new Error(`Unknown rewards offer: ${id}`);
  db.prepare("DELETE FROM rewards_offers WHERE id = ?").run(id);
  if (typeof db._persist === "function") db._persist();
  return { ok: true, id };
}

function rowToBill(row) {
  return {
    id: row.id,
    title: row.title,
    amount: Number(row.amount) || 0,
    cadence: row.cadence || "monthly",
    dueDay: Number(row.due_day) || 1,
    leadDays: Number(row.lead_days) || 3,
    category: row.category || "",
    active: Boolean(row.active),
    lastPaidFor: row.last_paid_for || null,
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listBills(db) {
  return db
    .prepare("SELECT * FROM bills ORDER BY due_day ASC, title ASC")
    .all()
    .map(rowToBill);
}

function getBill(db, id) {
  const row = db.prepare("SELECT * FROM bills WHERE id = ?").get(id);
  return row ? rowToBill(row) : null;
}

function upsertBill(db, bill) {
  if (!bill?.id || !bill?.title) {
    throw new Error("Bill requires id and title");
  }
  const now = new Date().toISOString();
  const dueDay = Math.max(1, Math.min(31, Number(bill.dueDay) || 1));
  const leadDays = Math.max(0, Math.min(28, Number(bill.leadDays != null ? bill.leadDays : 3)));
  const active = bill.active === false || bill.active === 0 ? 0 : 1;
  db.prepare(`
    INSERT INTO bills (
      id, title, amount, cadence, due_day, lead_days, category, active,
      last_paid_for, notes, created_at, updated_at
    ) VALUES (
      @id, @title, @amount, @cadence, @dueDay, @leadDays, @category, @active,
      @lastPaidFor, @notes, @now, @now
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      amount = excluded.amount,
      cadence = excluded.cadence,
      due_day = excluded.due_day,
      lead_days = excluded.lead_days,
      category = excluded.category,
      active = excluded.active,
      last_paid_for = excluded.last_paid_for,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run({
    id: String(bill.id),
    title: String(bill.title).slice(0, 120),
    amount: Number(bill.amount) || 0,
    cadence: bill.cadence || "monthly",
    dueDay,
    leadDays,
    category: bill.category || "",
    active,
    lastPaidFor: bill.lastPaidFor || null,
    notes: bill.notes || "",
    now
  });
  if (typeof db._persist === "function") db._persist();
  return getBill(db, bill.id);
}

function markBillPaid(db, id, periodKey) {
  const existing = getBill(db, id);
  if (!existing) throw new Error(`Unknown bill id: ${id}`);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE bills SET last_paid_for = ?, updated_at = ? WHERE id = ?`
  ).run(periodKey || existing.lastPaidFor, now, id);
  if (typeof db._persist === "function") db._persist();
  return getBill(db, id);
}

function deleteBill(db, id) {
  db.prepare("DELETE FROM bills WHERE id = ?").run(id);
  if (typeof db._persist === "function") db._persist();
}

function rowToAccount(row) {
  let holdings = [];
  if (row.holdings_json) {
    try {
      holdings = Model.normalizeHoldings(JSON.parse(row.holdings_json));
    } catch (_error) {
      holdings = [];
    }
  }
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    openingBalance: row.opening_balance,
    simplefinAccountId: row.simplefin_account_id || null,
    holdings,
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
  const accountHoldings = {};
  accounts.forEach((account) => {
    accountTypes[account.id] = account.type;
    openingBalances[account.id] = account.openingBalance;
    labels[account.id] = account.label;
    if (account.holdings?.length) accountHoldings[account.id] = account.holdings;
  });
  return { accountTypes, openingBalances, labels, accounts, accountHoldings };
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

  const holdingsJson =
    account.holdings != null
      ? JSON.stringify(Model.normalizeHoldings(account.holdings))
      : null;

  db.prepare(`
    INSERT INTO accounts (
      id, label, type, opening_balance, simplefin_account_id, holdings_json,
      created_at, updated_at
    ) VALUES (
      @id, @label, @type, @openingBalance, @simplefinAccountId, @holdingsJson,
      @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      type = excluded.type,
      opening_balance = excluded.opening_balance,
      simplefin_account_id = excluded.simplefin_account_id,
      holdings_json = COALESCE(excluded.holdings_json, accounts.holdings_json),
      updated_at = excluded.updated_at
  `).run({
    id,
    label,
    type,
    openingBalance: Number.isFinite(openingBalance) ? openingBalance : 0,
    simplefinAccountId,
    holdingsJson,
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
  bumpSettingsStamp(db);
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
        : existing.simplefinAccountId,
    holdings: patch.holdings !== undefined ? patch.holdings : existing.holdings
  };
  const updated = upsertAccountRow(db, next);
  bumpSettingsStamp(db);
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
    duplicateOf: row.duplicate_of || "",
    fingerprint: row.fingerprint || "",
    importBatchId: row.import_batch_id || "",
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

/** Rows changed after `since` (ISO timestamp). Empty since → full list. */
function listTransactionsSince(db, since) {
  const cursor = String(since || "").trim();
  if (!cursor) return listTransactions(db);
  return db
    .prepare(
      `SELECT * FROM transactions
       WHERE updated_at > ? OR IFNULL(committed_at, '') > ?
       ORDER BY date DESC, id DESC`
    )
    .all(cursor, cursor)
    .map(rowToTransaction);
}

function getDataCursors(db) {
  const tx = db
    .prepare("SELECT MAX(updated_at) AS m, COUNT(*) AS c FROM transactions")
    .get();
  const bills = db.prepare("SELECT MAX(updated_at) AS m FROM bills").get();
  let sync = { m: null };
  try {
    sync = db.prepare("SELECT MAX(updated_at) AS m FROM sync_items").get() || sync;
  } catch (_error) {
    // table may be absent in older fixtures
  }
  return {
    txCursor: tx?.m || "",
    txCount: Number(tx?.c) || 0,
    billsCursor: bills?.m || "",
    syncCursor: sync?.m || "",
    settingsStamp: getMeta(db, "settingsStamp", "0"),
    asOfDate: getMeta(db, "asOfDate", Model.todayIso())
  };
}

function bumpSettingsStamp(db) {
  setMeta(db, "settingsStamp", new Date().toISOString());
}

function getSettings(db) {
  const maps = getAccountMaps(db);
  return {
    asOfDate: getMeta(db, "asOfDate", Model.todayIso()),
    weeklySavingsTarget: Number(
      getMeta(
        db,
        "weeklySavingsTarget",
        Model.DEFAULT_CONFIG.weeklySavingsTarget
      )
    ),
    accountTypes: maps.accountTypes,
    openingBalances: maps.openingBalances,
    accountLabels: maps.labels,
    accountHoldings: maps.accountHoldings
  };
}

function saveSettings(db, settings) {
  if (settings.asOfDate != null) setMeta(db, "asOfDate", settings.asOfDate);
  if (settings.weeklySavingsTarget != null) {
    setMeta(db, "weeklySavingsTarget", settings.weeklySavingsTarget);
  }
  bumpSettingsStamp(db);
  if (typeof db._persist === "function") db._persist();
}

function purgeDemoTransactions(db) {
  const result = db
    .prepare(
      `DELETE FROM transactions
       WHERE id LIKE 'tx-%'
          OR account IN ('checking', 'savings')`
    )
    .run();
  // Drop legacy demo-only accounts if they were inserted by HUB_SEED_SAMPLE.
  db.prepare(
    `DELETE FROM accounts WHERE id IN ('checking', 'savings')`
  ).run();
  if (typeof db._persist === "function") db._persist();
  return { deleted: result.changes || 0 };
}

function computeLiveSnapshot(db, overrideSettings) {
  // Heal unlinked savings moves and card payoffs before totals.
  linkInternalTransfers(db);
  const settings = { ...getSettings(db), ...overrideSettings };
  // Live money view is always "as of today" unless a caller pins a date (tests).
  if (!overrideSettings || overrideSettings.asOfDate == null) {
    settings.asOfDate = Model.todayIso();
  }
  return Model.computeSnapshot(listTransactions(db), {
    ...settings,
    bills: listBills(db)
  });
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
  const Duplicates = require("../engine/duplicates.js");
  const { accountTypes } = getAccountMaps(db);
  const normalized = Rules.normalizeTransaction(raw, accountTypes);
  const now = new Date().toISOString();
  const fp =
    raw.fingerprint ||
    Duplicates.fingerprint(
      normalized.account,
      normalized.date,
      normalized.amount,
      raw.rawMerchant || normalized.merchant
    );

  const existingById = db
    .prepare("SELECT id FROM transactions WHERE id = ?")
    .get(normalized.id);
  if (existingById) {
    return { ...normalized, inserted: false, reason: "id" };
  }

  const existingByFp = db
    .prepare(
      `SELECT id FROM transactions
       WHERE fingerprint = ?
         AND (duplicate_of IS NULL OR duplicate_of = '')
       LIMIT 1`
    )
    .get(fp);
  if (existingByFp) {
    return {
      ...normalized,
      id: existingByFp.id,
      inserted: false,
      reason: "fingerprint",
      duplicateOf: existingByFp.id
    };
  }

  const result = db.prepare(`
    INSERT INTO transactions (
      id, date, raw_merchant, amount, account, account_type, direction, category,
      merchant, needs_review, transfer_account, suggested_transfer_account,
      committed_at, updated_at, import_batch_id, duplicate_of, fingerprint
    ) VALUES (
      @id, @date, @rawMerchant, @amount, @account, @accountType, @direction, @category,
      @merchant, @needsReview, @transferAccount, @suggestedTransferAccount,
      NULL, @updatedAt, @importBatchId, @duplicateOf, @fingerprint
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
    updatedAt: now,
    importBatchId: raw.importBatchId || null,
    duplicateOf: raw.duplicateOf || null,
    fingerprint: fp
  });
  if (typeof db._persist === "function") db._persist();
  return {
    ...normalized,
    fingerprint: fp,
    inserted: result.changes > 0,
    reason: result.changes > 0 ? "inserted" : "id"
  };
}

/**
 * Insert or refresh a connector-sourced row. Re-applies direction/category from
 * the feed when the row already exists and the user has not committed it.
 * Always refreshes SimpleFIN liability/external rows so a prior sign bug can
 * be corrected on the next live sync (even if previously committed).
 */
function upsertRawTransactionFromSync(db, raw) {
  const inserted = insertRawTransaction(db, raw);
  if (inserted.inserted) {
    return { ...inserted, updated: false };
  }
  if (inserted.reason !== "id") {
    return { ...inserted, updated: false };
  }

  const existing = db
    .prepare(
      `SELECT id, direction, category, needs_review, committed_at, account_type,
              transfer_account, suggested_transfer_account, merchant, raw_merchant
       FROM transactions WHERE id = ?`
    )
    .get(raw.id);
  if (!existing) {
    return { ...inserted, updated: false };
  }

  const isSimplefin = String(raw.id).startsWith("sf:");
  const isLiabilityLike =
    existing.account_type === "liability" || existing.account_type === "external";
  const allowRefresh =
    !existing.committed_at || (isSimplefin && isLiabilityLike);
  if (!allowRefresh) {
    return { ...inserted, updated: false };
  }

  const { accountTypes } = getAccountMaps(db);
  const normalized = Rules.normalizeTransaction(raw, accountTypes);
  const directionChanged = (existing.direction || "") !== (normalized.direction || "");
  const categoryChanged = (existing.category || "") !== (normalized.category || "");
  const reviewChanged =
    Boolean(existing.needs_review) !== Boolean(normalized.needsReview);
  if (!directionChanged && !categoryChanged && !reviewChanged) {
    return { ...inserted, updated: false };
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE transactions
    SET direction = @direction,
        category = @category,
        merchant = @merchant,
        raw_merchant = @rawMerchant,
        needs_review = @needsReview,
        transfer_account = @transferAccount,
        suggested_transfer_account = @suggestedTransferAccount,
        committed_at = NULL,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id: raw.id,
    direction: normalized.direction || "",
    category: normalized.category || "",
    merchant: normalized.merchant,
    rawMerchant: raw.rawMerchant,
    needsReview: normalized.needsReview ? 1 : 0,
    transferAccount: normalized.transferAccount || "",
    suggestedTransferAccount: normalized.suggestedTransferAccount || "",
    updatedAt: now
  });
  if (typeof db._persist === "function") db._persist();
  return {
    ...normalized,
    inserted: false,
    updated: true,
    reason: "updated"
  };
}

function findImportBatchByContentHash(db, contentHash) {
  if (!contentHash) return null;
  const row = db
    .prepare(
      `SELECT * FROM import_batches
       WHERE content_hash = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(contentHash);
  if (!row) return null;
  const stillPresent = db
    .prepare(
      `SELECT COUNT(*) AS c FROM transactions WHERE import_batch_id = ?`
    )
    .get(row.id);
  return {
    id: row.id,
    createdAt: row.created_at,
    format: row.format,
    extractMethod: row.extract_method,
    label: row.label,
    accountId: row.account_id,
    insertedCount: row.inserted_count,
    skippedCount: row.skipped_count,
    byAccount: safeJson(row.by_account_json, {}),
    contentHash: row.content_hash || "",
    transactionsRemaining: stillPresent?.c || 0
  };
}

function linkInternalTransfers(db) {
  const Duplicates = require("../engine/duplicates.js");
  const maps = getAccountMaps(db);
  const now = new Date().toISOString();

  // Promote bank-side card payoffs that landed as expenses into transfers.
  let promoted = 0;
  listTransactions(db)
    .filter(
      (tx) =>
        !tx.duplicateOf &&
        tx.direction === "out" &&
        (maps.accountTypes[tx.account] || tx.accountType) === "cash"
    )
    .forEach((tx) => {
      const target = Duplicates.inferCardPaymentTarget(
        tx.merchant || tx.rawMerchant,
        maps.accountTypes
      );
      if (!target || target === tx.account) return;
      db.prepare(
        `UPDATE transactions
         SET direction = 'transfer',
             category = '',
             transfer_account = @transferAccount,
             merchant = CASE
               WHEN lower(merchant) LIKE '%amex%' OR lower(raw_merchant) LIKE '%amex%'
                 OR lower(merchant) LIKE '%american express%'
                 OR lower(raw_merchant) LIKE '%american express%'
               THEN 'Amex Payment'
               WHEN lower(merchant) LIKE '%discover%' OR lower(raw_merchant) LIKE '%discover%'
               THEN 'Discover Payment'
               ELSE merchant
             END,
             needs_review = 0,
             updated_at = @updatedAt
         WHERE id = @id
           AND (duplicate_of IS NULL OR duplicate_of = '')`
      ).run({
        id: tx.id,
        transferAccount: target,
        updatedAt: now
      });
      promoted += 1;
    });

  const txs = listTransactions(db).filter((tx) => !tx.duplicateOf);
  const pairs = Duplicates.findTransferPairs(txs, {
    accountTypes: maps.accountTypes,
    maxDays: 5
  });
  let linked = 0;
  pairs.forEach((pair) => {
    if (!pair.sourceAlreadyTransfer) {
      db.prepare(
        `UPDATE transactions
         SET direction = 'transfer',
             category = '',
             transfer_account = @transferAccount,
             needs_review = 0,
             updated_at = @updatedAt
         WHERE id = @id
           AND (duplicate_of IS NULL OR duplicate_of = '')`
      ).run({
        id: pair.sourceId,
        transferAccount: pair.transferAccount,
        updatedAt: now
      });
    }
    db.prepare(
      `UPDATE transactions
       SET duplicate_of = @sourceId,
           direction = '',
           category = '',
           needs_review = 0,
           updated_at = @updatedAt
       WHERE id = @targetId
         AND (duplicate_of IS NULL OR duplicate_of = '')`
    ).run({
      sourceId: pair.sourceId,
      targetId: pair.targetId,
      updatedAt: now
    });
    linked += 1;
  });
  if ((linked || promoted) && typeof db._persist === "function") db._persist();
  return { linked, promoted, pairs };
}

function createImportBatch(db, batch) {
  const id = batch.id || `imp:${Date.now().toString(36)}:${cryptoRandom(4)}`;
  const createdAt = batch.createdAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO import_batches (
      id, created_at, format, extract_method, label, account_id,
      inserted_count, skipped_count, by_account_json, content_hash
    ) VALUES (
      @id, @createdAt, @format, @extractMethod, @label, @accountId,
      @insertedCount, @skippedCount, @byAccountJson, @contentHash
    )
  `).run({
    id,
    createdAt,
    format: batch.format || "",
    extractMethod: batch.extractMethod || "",
    label: batch.label || "",
    accountId: batch.accountId || "",
    insertedCount: batch.insertedCount || 0,
    skippedCount: batch.skippedCount || 0,
    byAccountJson: JSON.stringify(batch.byAccount || {}),
    contentHash: batch.contentHash || null
  });
  if (typeof db._persist === "function") db._persist();
  return { id, createdAt };
}

function updateImportBatchCounts(db, id, counts) {
  db.prepare(`
    UPDATE import_batches
    SET inserted_count = @insertedCount,
        skipped_count = @skippedCount,
        by_account_json = @byAccountJson
    WHERE id = @id
  `).run({
    id,
    insertedCount: counts.insertedCount || 0,
    skippedCount: counts.skippedCount || 0,
    byAccountJson: JSON.stringify(counts.byAccount || {})
  });
  if (typeof db._persist === "function") db._persist();
}

function deleteImportBatch(db, id) {
  if (id === "legacy-orphans") {
    return deleteOrphanImports(db);
  }
  const batch = getImportBatch(db, id);
  if (!batch) throw new Error(`Unknown import: ${id}`);
  const txResult = db
    .prepare("DELETE FROM transactions WHERE import_batch_id = ?")
    .run(id);
  db.prepare("DELETE FROM import_batches WHERE id = ?").run(id);
  if (typeof db._persist === "function") db._persist();
  return {
    ok: true,
    id,
    deletedTransactions: txResult.changes || 0,
    batch,
    snapshot: redactSnapshot(computeLiveSnapshot(db))
  };
}

function countOrphanImports(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM transactions
       WHERE (import_batch_id IS NULL OR import_batch_id = '')
         AND (id LIKE 'pdf:%' OR id LIKE 'csv:%' OR id LIKE 'ofx:%')`
    )
    .get();
  return row?.c || 0;
}

function deleteOrphanImports(db) {
  const result = db
    .prepare(
      `DELETE FROM transactions
       WHERE (import_batch_id IS NULL OR import_batch_id = '')
         AND (id LIKE 'pdf:%' OR id LIKE 'csv:%' OR id LIKE 'ofx:%')`
    )
    .run();
  if (typeof db._persist === "function") db._persist();
  return {
    ok: true,
    id: "legacy-orphans",
    deletedTransactions: result.changes || 0,
    batch: {
      id: "legacy-orphans",
      label: "Older imports (before undo tracking)",
      insertedCount: result.changes || 0
    },
    snapshot: redactSnapshot(computeLiveSnapshot(db))
  };
}

function listImportBatches(db, limit = 20) {
  const batches = db
    .prepare(
      `SELECT * FROM import_batches
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(Math.max(1, Math.min(100, Number(limit) || 20)))
    .map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      format: row.format,
      extractMethod: row.extract_method,
      label: row.label,
      accountId: row.account_id,
      insertedCount: row.inserted_count,
      skippedCount: row.skipped_count,
      byAccount: safeJson(row.by_account_json, {}),
      contentHash: row.content_hash || ""
    }));

  const orphanCount = countOrphanImports(db);
  if (orphanCount > 0) {
    batches.push({
      id: "legacy-orphans",
      createdAt: "",
      format: "",
      extractMethod: "",
      label: "Older imports (before undo tracking)",
      accountId: "",
      insertedCount: orphanCount,
      skippedCount: 0,
      byAccount: {}
    });
  }
  return batches;
}

function getImportBatch(db, id) {
  if (id === "legacy-orphans") {
    const count = countOrphanImports(db);
    if (!count) return null;
    return {
      id: "legacy-orphans",
      createdAt: "",
      format: "",
      extractMethod: "",
      label: "Older imports (before undo tracking)",
      accountId: "",
      insertedCount: count,
      skippedCount: 0,
      byAccount: {}
    };
  }
  const row = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    format: row.format,
    extractMethod: row.extract_method,
    label: row.label,
    accountId: row.account_id,
    insertedCount: row.inserted_count,
    skippedCount: row.skipped_count,
    byAccount: safeJson(row.by_account_json, {})
  };
}

function cryptoRandom(bytes) {
  return require("node:crypto").randomBytes(bytes).toString("hex");
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text || "null") ?? fallback;
  } catch {
    return fallback;
  }
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
    expensesThisMonth: snapshot.expensesThisMonth,
    spendingMonth: snapshot.spendingMonth,
    spendingByCategory: snapshot.spendingByCategory,
    recurring: snapshot.recurring,
    balances: snapshot.balances,
    holdingBreakdown: snapshot.holdingBreakdown,
    safeToSpend: {
      period: snapshot.safeToSpend.period,
      periodSource: snapshot.safeToSpend.periodSource,
      nextPayday: snapshot.safeToSpend.nextPayday,
      horizonDays: snapshot.safeToSpend.horizonDays,
      amount: snapshot.safeToSpend.remaining,
      income: snapshot.safeToSpend.income,
      weeklyIncome: snapshot.safeToSpend.weeklyIncome,
      committed: snapshot.safeToSpend.committed,
      commitments: snapshot.safeToSpend.commitments,
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
  listTransactionsSince,
  getDataCursors,
  bumpSettingsStamp,
  getSettings,
  saveSettings,
  purgeDemoTransactions,
  computeLiveSnapshot,
  commitTransactions,
  upsertSyncItem,
  listSyncItems,
  markActionExecuted,
  listBills,
  getBill,
  upsertBill,
  markBillPaid,
  deleteBill,
  listRewardsRules,
  getRewardsRule,
  upsertRewardsRule,
  deleteRewardsRule,
  listRewardsOffers,
  getRewardsOffer,
  upsertRewardsOffer,
  deleteRewardsOffer,
  getCursor,
  setCursor,
  setConnectorWatermark,
  getConnectorWatermark,
  insertRawTransaction,
  upsertRawTransactionFromSync,
  findImportBatchByContentHash,
  linkInternalTransfers,
  createImportBatch,
  updateImportBatchCounts,
  listImportBatches,
  getImportBatch,
  deleteImportBatch,
  saveAiProposal,
  listAiProposals,
  redactSnapshot,
  getMeta,
  setMeta
};
