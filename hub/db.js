"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const Rules = require("../engine/rules.js");
const Model = require("../engine/model.js");
const Learned = require("../engine/learned.js");

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

    CREATE TABLE IF NOT EXISTS learned_rules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      match_kind TEXT NOT NULL,
      match_key TEXT NOT NULL,
      effect TEXT NOT NULL,
      effect_value TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 100,
      source TEXT NOT NULL DEFAULT 'user_action',
      evidence_json TEXT,
      hit_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS learned_rules_uq
      ON learned_rules(scope, match_kind, match_key, effect);

    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      term TEXT,
      canvas_course_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS syllabus_sources (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      path TEXT,
      content_hash TEXT,
      parsed_at TEXT,
      raw_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assessments (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      date TEXT,
      time TEXT,
      weight REAL,
      source TEXT NOT NULL DEFAULT 'syllabus',
      confidence TEXT NOT NULL DEFAULT 'high',
      lead_days INTEGER NOT NULL DEFAULT 7,
      confirmed INTEGER NOT NULL DEFAULT 0,
      canvas_date TEXT,
      parsed_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      assessment_id TEXT,
      title TEXT NOT NULL,
      week INTEGER,
      lecture_ref TEXT,
      readings_json TEXT NOT NULL DEFAULT '[]',
      reviewed INTEGER NOT NULL DEFAULT 0,
      reviewed_how TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS assessments_course_idx ON assessments(course_id);
    CREATE INDEX IF NOT EXISTS topics_assessment_idx ON topics(assessment_id);
  `);

  ensureColumn(db, "transactions", "import_batch_id", "TEXT");
  ensureColumn(db, "transactions", "duplicate_of", "TEXT");
  ensureColumn(db, "transactions", "fingerprint", "TEXT");
  ensureColumn(db, "accounts", "holdings_json", "TEXT");
  ensureColumn(db, "accounts", "reported_balance", "REAL");
  ensureColumn(db, "accounts", "reported_at", "TEXT");
  ensureColumn(db, "accounts", "statement_day", "INTEGER");
  ensureColumn(db, "accounts", "due_day", "INTEGER");
  ensureColumn(db, "import_batches", "content_hash", "TEXT");
  backfillFingerprints(db);
  seedCardScheduleDefaults(db);
  setMeta(db, "schemaVersion", "9");
  setMeta(db, "encryption", "sqlcipher");
  seedDefaultBills(db);
  seedRewardsBaselines(db);
}

function seedCardScheduleDefaults(db) {
  // Amex statement often closes ~2nd; due ~25 days later. Discover similar.
  const defaults = [
    { id: "amex", statementDay: 2, dueDay: 27 },
    { id: "discover", statementDay: 15, dueDay: 10 }
  ];
  defaults.forEach((row) => {
    const existing = db.prepare("SELECT id, statement_day, due_day FROM accounts WHERE id = ?").get(row.id);
    if (!existing) return;
    if (existing.statement_day == null) {
      db.prepare("UPDATE accounts SET statement_day = ? WHERE id = ?").run(
        row.statementDay,
        row.id
      );
    }
    if (existing.due_day == null) {
      db.prepare("UPDATE accounts SET due_day = ? WHERE id = ?").run(row.dueDay, row.id);
    }
  });
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
    reportedBalance:
      row.reported_balance == null || row.reported_balance === ""
        ? null
        : Number(row.reported_balance),
    reportedAt: row.reported_at || null,
    statementDay:
      row.statement_day == null || row.statement_day === ""
        ? null
        : Number(row.statement_day),
    dueDay:
      row.due_day == null || row.due_day === "" ? null : Number(row.due_day),
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
  const reportedBalances = {};
  const labels = {};
  const accountHoldings = {};
  accounts.forEach((account) => {
    accountTypes[account.id] = account.type;
    openingBalances[account.id] = account.openingBalance;
    labels[account.id] = account.label;
    if (account.holdings?.length) accountHoldings[account.id] = account.holdings;
    if (account.reportedBalance != null && Number.isFinite(account.reportedBalance)) {
      reportedBalances[account.id] = account.reportedBalance;
    }
  });
  return {
    accountTypes,
    openingBalances,
    reportedBalances,
    labels,
    accounts,
    accountHoldings
  };
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

  if (
    account.reportedBalance !== undefined ||
    account.reportedAt !== undefined ||
    account.statementDay !== undefined ||
    account.dueDay !== undefined
  ) {
    const current = getAccount(db, id);
    db.prepare(`
      UPDATE accounts
      SET reported_balance = @reportedBalance,
          reported_at = @reportedAt,
          statement_day = @statementDay,
          due_day = @dueDay,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      reportedBalance:
        account.reportedBalance !== undefined
          ? account.reportedBalance == null
            ? null
            : Number(account.reportedBalance)
          : current.reportedBalance,
      reportedAt:
        account.reportedAt !== undefined
          ? account.reportedAt
          : current.reportedAt,
      statementDay:
        account.statementDay !== undefined
          ? account.statementDay == null
            ? null
            : Number(account.statementDay)
          : current.statementDay,
      dueDay:
        account.dueDay !== undefined
          ? account.dueDay == null
            ? null
            : Number(account.dueDay)
          : current.dueDay,
      updatedAt: now
    });
  }

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
    holdings: patch.holdings !== undefined ? patch.holdings : existing.holdings,
    reportedBalance:
      patch.reportedBalance !== undefined
        ? patch.reportedBalance
        : existing.reportedBalance,
    reportedAt:
      patch.reportedAt !== undefined ? patch.reportedAt : existing.reportedAt,
    statementDay:
      patch.statementDay !== undefined ? patch.statementDay : existing.statementDay,
    dueDay: patch.dueDay !== undefined ? patch.dueDay : existing.dueDay
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
    engineVersion: String(Model.ENGINE_VERSION || 0),
    asOfDate: getMeta(db, "asOfDate", Model.todayIso())
  };
}

function bumpSettingsStamp(db) {
  setMeta(db, "settingsStamp", new Date().toISOString());
}

function getSettings(db) {
  const maps = getAccountMaps(db);
  let incomeStreamOverrides = {};
  let budgetEnvelopes = {};
  let declinedEnvelopeCategories = [];
  try {
    incomeStreamOverrides = Model.normalizeIncomeOverrides(
      JSON.parse(getMeta(db, "incomeStreamOverrides", "{}") || "{}")
    );
  } catch (_error) {
    incomeStreamOverrides = {};
  }
  try {
    budgetEnvelopes = JSON.parse(getMeta(db, "budgetEnvelopes", "{}") || "{}");
    declinedEnvelopeCategories = JSON.parse(
      getMeta(db, "declinedEnvelopeCategories", "[]") || "[]"
    );
  } catch (_error) {
    budgetEnvelopes = {};
    declinedEnvelopeCategories = [];
  }
  return {
    asOfDate: getMeta(db, "asOfDate", Model.todayIso()),
    weeklySavingsTarget: Number(
      getMeta(
        db,
        "weeklySavingsTarget",
        Model.DEFAULT_CONFIG.weeklySavingsTarget
      )
    ),
    checkingReserve: Number(
      getMeta(db, "checkingReserve", Model.DEFAULT_CONFIG.checkingReserve)
    ),
    incomeStreamOverrides,
    budgetEnvelopes,
    declinedEnvelopeCategories,
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
  if (settings.checkingReserve != null) {
    setMeta(db, "checkingReserve", settings.checkingReserve);
  }
  if (settings.budgetEnvelopes != null) {
    setMeta(db, "budgetEnvelopes", JSON.stringify(settings.budgetEnvelopes || {}));
  }
  if (settings.declinedEnvelopeCategories != null) {
    setMeta(
      db,
      "declinedEnvelopeCategories",
      JSON.stringify(settings.declinedEnvelopeCategories || [])
    );
  }
  if (settings.incomeStreamOverrides != null) {
    const prev = getSettings(db).incomeStreamOverrides || {};
    const incoming = settings.incomeStreamOverrides;
    const merged = { ...prev };
    Object.entries(incoming || {}).forEach(([key, value]) => {
      const normalizedKey = String(key || "")
        .trim()
        .toLowerCase();
      if (!normalizedKey) return;
      if (value == null || value === "" || value.status === "clear") {
        delete merged[normalizedKey];
        return;
      }
      const status =
        typeof value === "string" ? value : value && value.status;
      if (!status) return;
      merged[normalizedKey] = { status: String(status) };
    });
    setMeta(
      db,
      "incomeStreamOverrides",
      JSON.stringify(Model.normalizeIncomeOverrides(merged))
    );
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

function mapLearnedRuleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    matchKind: row.match_kind,
    matchKey: row.match_key,
    effect: row.effect,
    effectValue: Learned.parseEffectValue(row.effect_value),
    priority: row.priority,
    source: row.source,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    hitCount: row.hit_count,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listLearnedRules(db, scope) {
  const rows = scope
    ? db
        .prepare(
          `SELECT * FROM learned_rules WHERE scope = ? ORDER BY priority ASC, updated_at DESC`
        )
        .all(scope)
    : db
        .prepare(`SELECT * FROM learned_rules ORDER BY scope, priority ASC, updated_at DESC`)
        .all();
  return rows.map(mapLearnedRuleRow);
}

function getLearnedRule(db, id) {
  return mapLearnedRuleRow(
    db.prepare("SELECT * FROM learned_rules WHERE id = ?").get(id)
  );
}

function upsertLearnedRule(db, input) {
  const rule = Learned.normalizeRuleInput(input);
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM learned_rules WHERE id = ?").get(rule.id);
  db.prepare(`
    INSERT INTO learned_rules (
      id, scope, match_kind, match_key, effect, effect_value, priority,
      source, evidence_json, hit_count, active, created_at, updated_at
    ) VALUES (
      @id, @scope, @matchKind, @matchKey, @effect, @effectValue, @priority,
      @source, @evidenceJson, @hitCount, @active, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      effect_value = excluded.effect_value,
      priority = excluded.priority,
      source = excluded.source,
      evidence_json = COALESCE(excluded.evidence_json, learned_rules.evidence_json),
      hit_count = MAX(learned_rules.hit_count, excluded.hit_count),
      active = excluded.active,
      updated_at = excluded.updated_at
  `).run({
    id: rule.id,
    scope: rule.scope,
    matchKind: rule.matchKind,
    matchKey: rule.matchKey,
    effect: rule.effect,
    effectValue: Learned.stringifyEffectValue(rule.effectValue),
    priority: rule.priority,
    source: rule.source,
    evidenceJson: rule.evidence ? JSON.stringify(rule.evidence) : null,
    hitCount: rule.hitCount || (existing ? existing.hit_count : 0),
    active: rule.active ? 1 : 0,
    createdAt: existing?.created_at || now,
    updatedAt: now
  });
  if (typeof db._persist === "function") db._persist();
  return getLearnedRule(db, rule.id);
}

function deactivateLearnedRule(db, id) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE learned_rules SET active = 0, updated_at = ? WHERE id = ?`
  ).run(now, id);
  if (typeof db._persist === "function") db._persist();
  return getLearnedRule(db, id);
}

function bumpLearnedHitCounts(db, ruleIds) {
  if (!ruleIds?.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE learned_rules SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?`
  );
  ruleIds.forEach((id) => stmt.run(now, id));
}

function applyLearnedMoneyOverlay(db, normalized) {
  if (!normalized) return normalized;
  const direction = normalized.direction || "";
  if (direction !== "in" && direction !== "out") return normalized;
  const merchant = normalized.merchant || normalized.rawMerchant || "";
  if (Learned.isPeerP2pMerchant(merchant)) return normalized;
  const resolved = Learned.resolveMoney(
    listLearnedRules(db, "money"),
    merchant,
    direction
  );
  if (!resolved) return normalized;
  const next = { ...normalized };
  if (resolved.direction && !next.direction) {
    next.direction = resolved.direction;
  }
  if (resolved.category) {
    const placeholder =
      !next.category || next.category === "uncategorized" || next.category === "";
    if (placeholder) next.category = resolved.category;
  }
  if (resolved.ruleIds?.length) bumpLearnedHitCounts(db, resolved.ruleIds);
  next.needsReview =
    !next.direction ||
    (next.direction === "transfer" && !next.transferAccount) ||
    (next.direction !== "transfer" && !next.category);
  return next;
}

/**
 * Apply a learned category to sibling rows with the same merchant key.
 * Skips committed rows that already have a different non-placeholder category.
 * Never propagates across Venmo/Zelle/PayPal/Cash App.
 */
function applyLearnedCategoryToSimilar(db, merchant, direction, category, options = {}) {
  if (Learned.isPeerP2pMerchant(merchant)) return { updated: 0, ids: [] };
  const key = Learned.merchantKey(merchant, direction);
  if (!key || !category) return { updated: 0, ids: [] };
  const excludeId = options.excludeId || null;
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT id, merchant, raw_merchant, direction, category, committed_at
       FROM transactions
       WHERE direction = ?`
    )
    .all(direction);
  const stmt = db.prepare(`
    UPDATE transactions
    SET category = @category,
        needs_review = @needsReview,
        updated_at = @updatedAt
    WHERE id = @id
  `);
  const ids = [];
  withTransaction(db, () => {
    rows.forEach((row) => {
      if (excludeId && row.id === excludeId) return;
      const rowKey = Learned.merchantKey(row.merchant || row.raw_merchant, direction);
      if (rowKey !== key) return;
      const current = row.category || "";
      const placeholder = !current || current === "uncategorized";
      if (!placeholder && current !== category && row.committed_at) return;
      if (current === category) return;
      const needsReview = !row.direction || !category;
      stmt.run({
        id: row.id,
        category,
        needsReview: needsReview ? 1 : 0,
        updatedAt: now
      });
      ids.push(row.id);
    });
  });
  if (ids.length && typeof db._persist === "function") db._persist();
  return { updated: ids.length, ids };
}

function learnFromMoneyCommit(db, updates, options = {}) {
  const applySimilar = options.applySimilar !== false;
  let similarUpdated = 0;
  const learned = [];
  (updates || []).forEach((row) => {
    const existing = db
      .prepare(
        `SELECT id, merchant, raw_merchant, direction, category FROM transactions WHERE id = ?`
      )
      .get(row.id);
    const merged = {
      id: row.id,
      merchant: existing?.merchant || row.merchant || "",
      rawMerchant: existing?.raw_merchant || row.rawMerchant || "",
      direction: row.direction || existing?.direction || "",
      category: row.category || ""
    };
    Learned.moneyLearnFromCommit(merged).forEach((ruleInput) => {
      const saved = upsertLearnedRule(db, ruleInput);
      learned.push(saved);
      if (applySimilar && ruleInput.effect === "set_category") {
        const result = applyLearnedCategoryToSimilar(
          db,
          merged.merchant || merged.rawMerchant,
          merged.direction,
          ruleInput.effectValue.category,
          { excludeId: row.id }
        );
        similarUpdated += result.updated;
      }
    });
  });
  return { learned, similarUpdated };
}

function learnFromDigestAction(db, actionItem, targetItem) {
  const type = actionItem?.type || "";
  const learned = [];
  if (type === "action.unsubscribe" || type === "signal.junk") {
    Learned.digestLearnFromUnsubscribe(actionItem.data || {}).forEach((rule) => {
      learned.push(upsertLearnedRule(db, rule));
    });
  }
  if (
    type === "action.rsvp.no" ||
    type === "action.dismiss" ||
    type === "action.rsvp.yes" ||
    type === "action.going"
  ) {
    Learned.digestLearnFromTarget(targetItem, type).forEach((ruleInput) => {
      // Threshold: group/calendar drop and from_domain stay inactive until enough
      // distinct declines. Unsubscribe / Going / sender mute remain immediate.
      if (Learned.digestRuleNeedsThreshold(ruleInput)) {
        const existing = getLearnedRule(db, ruleInput.id);
        const threshold = Number(ruleInput.evidence?.threshold) || 2;
        const merged = Learned.mergeThresholdEvidence(
          existing,
          ruleInput,
          threshold
        );
        learned.push(
          upsertLearnedRule(db, {
            ...ruleInput,
            evidence: merged.evidence,
            hitCount: merged.hitCount,
            active: merged.active
          })
        );
      } else {
        learned.push(upsertLearnedRule(db, ruleInput));
      }
    });
  }
  return learned;
}

function resolveDigestLearned(db, message) {
  return Learned.resolveDigest(listLearnedRules(db, "digest"), message);
}

function promoteBillFromSuggestion(db, suggestion) {
  if (!suggestion || !suggestion.amount) {
    throw new Error("Bill suggestion requires amount");
  }
  const seedId = suggestion.seedBillId || null;
  const existing = seedId ? getBill(db, seedId) : null;
  const id =
    existing?.id ||
    suggestion.id ||
    `bill:${String(suggestion.title || suggestion.merchant || "recurring")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)}`;
  const notes = [
    existing?.notes || "",
    suggestion.streamKey ? `stream:${suggestion.streamKey}` : ""
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);
  return upsertBill(db, {
    id,
    title: suggestion.title || existing?.title || suggestion.merchant || "Bill",
    amount: Number(suggestion.amount),
    dueDay: Number(suggestion.dueDay) || existing?.dueDay || 1,
    leadDays: Number(suggestion.leadDays) || existing?.leadDays || 5,
    category: suggestion.category || existing?.category || "",
    active: true,
    notes,
    lastPaidFor: existing?.lastPaidFor || null
  });
}

function computeLiveSnapshot(db, overrideSettings) {
  // Heal unlinked savings moves and card payoffs before totals.
  linkInternalTransfers(db);
  const settings = { ...getSettings(db), ...overrideSettings };
  // Live money view is always "as of today" unless a caller pins a date (tests).
  if (!overrideSettings || overrideSettings.asOfDate == null) {
    settings.asOfDate = Model.todayIso();
  }
  const maps = getAccountMaps(db);
  const transactions = listTransactions(db);
  const accounts = maps.accounts || listAccounts(db);
  const snapshot = Model.computeSnapshot(transactions, {
    ...settings,
    bills: listBills(db),
    reportedBalances: maps.reportedBalances,
    accounts,
    accountLabels: maps.labels
  });
  return enrichSnapshot(db, snapshot, transactions, accounts);
}

function enrichSnapshot(db, snapshot, transactions, accounts) {
  const txs = transactions || listTransactions(db);
  const accountList = accounts || listAccounts(db);
  const months = Learned.buildMonthlyTallies(txs);
  const recurringMarks = Learned.recurringMarksFromStreams(snapshot.recurring || []);
  const existingBills = listBills(db);
  const activeStreamNotes = new Set(
    existingBills
      .map((b) => String(b.notes || ""))
      .flatMap((notes) => {
        const m = notes.match(/stream:([^\s·]+)/);
        return m ? [m[1]] : [];
      })
  );
  const billSuggestions = (snapshot.recurring || [])
    .map((stream) => Learned.billSuggestionFromStream(stream))
    .filter(Boolean)
    .filter((s) => !activeStreamNotes.has(s.streamKey))
    .filter((s) => {
      // Skip if an active bill already matches seed with a real amount.
      if (!s.seedBillId) return true;
      const bill = existingBills.find((b) => b.id === s.seedBillId);
      if (bill && bill.active && Number(bill.amount) > 0) return false;
      return true;
    });
  const cardSchedule = Model.buildCardSchedule(
    txs,
    accountList,
    snapshot,
    snapshot.asOfDate || getSettings(db).asOfDate
  );
  return {
    ...snapshot,
    months,
    recurringMarks,
    billSuggestions,
    cardSchedule
  };
}

/**
 * Re-apply offline categoryFor() to expense rows that are still blank/uncategorized.
 * Does not overwrite a real user-chosen category. Safe to run after rules updates.
 */
function recategorizeTransactions(db, options = {}) {
  const force = Boolean(options.force);
  const rows = db
    .prepare(
      `SELECT id, merchant, raw_merchant, direction, category, committed_at
       FROM transactions`
    )
    .all();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE transactions
    SET category = @category,
        needs_review = @needsReview,
        updated_at = @updatedAt
    WHERE id = @id
  `);
  let updated = 0;
  const byCategory = {};

  withTransaction(db, () => {
    rows.forEach((row) => {
      if (row.direction !== "out" && row.direction !== "in") return;
      const current = row.category || "";
      const isPlaceholder =
        !current || current === "uncategorized" || current === "";
      if (!force && !isPlaceholder) return;
      // Keep income rows as income when already labeled.
      if (row.direction === "in" && current === "income" && !force) return;

      const merchant = row.merchant || row.raw_merchant || "";
      let next =
        row.direction === "in"
          ? Rules.categoryFor(merchant) === "income"
            ? "income"
            : current === "income"
              ? "income"
              : Rules.categoryFor(merchant)
          : Rules.categoryFor(merchant);

      const learned = Learned.resolveMoney(
        listLearnedRules(db, "money"),
        merchant,
        row.direction
      );
      if (learned?.category) next = learned.category;
      if (learned?.direction === "in" && row.direction === "in" && !next) {
        next = "income";
      }

      if (row.direction === "in" && next === "uncategorized") next = "income";
      if (next === current) return;
      if (!force && !isPlaceholder) return;

      const needsReview =
        !row.direction ||
        (row.direction !== "transfer" && !next);
      stmt.run({
        id: row.id,
        category: next,
        needsReview: needsReview ? 1 : 0,
        updatedAt: now
      });
      updated += 1;
      byCategory[next] = (byCategory[next] || 0) + 1;
      if (learned?.ruleIds?.length) bumpLearnedHitCounts(db, learned.ruleIds);
    });
  });

  setMeta(db, "categoryRulesVersion", String(Rules.CATEGORY_RULES_VERSION));
  if (typeof db._persist === "function") db._persist();
  return {
    updated,
    byCategory,
    version: Rules.CATEGORY_RULES_VERSION,
    snapshot: computeLiveSnapshot(db)
  };
}

function healBlankDirections(db) {
  const { accountTypes } = getAccountMaps(db);
  const rows = db
    .prepare(
      `SELECT id, date, raw_merchant, amount, account, direction, category,
              merchant, needs_review, transfer_account, suggested_transfer_account
       FROM transactions
       WHERE direction IS NULL OR direction = ''`
    )
    .all();
  if (!rows.length) return { updated: 0 };
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE transactions
    SET direction = @direction,
        category = @category,
        merchant = @merchant,
        needs_review = @needsReview,
        transfer_account = @transferAccount,
        suggested_transfer_account = @suggestedTransferAccount,
        updated_at = @updatedAt
    WHERE id = @id
  `);
  let updated = 0;
  withTransaction(db, () => {
    rows.forEach((row) => {
      const normalized = Rules.normalizeTransaction(
        {
          id: row.id,
          date: row.date,
          rawMerchant: row.raw_merchant || row.merchant,
          amount: row.amount,
          account: row.account
        },
        accountTypes
      );
      if (!normalized.direction) return;
      if ((row.direction || "") === normalized.direction) return;
      stmt.run({
        id: row.id,
        direction: normalized.direction,
        category: normalized.category || "",
        merchant: normalized.merchant,
        needsReview: normalized.needsReview ? 1 : 0,
        transferAccount: normalized.transferAccount || "",
        suggestedTransferAccount: normalized.suggestedTransferAccount || "",
        updatedAt: now
      });
      updated += 1;
    });
  });
  if (updated) {
    bumpSettingsStamp(db);
    linkInternalTransfers(db);
    if (typeof db._persist === "function") db._persist();
  }
  return { updated };
}

function deactivatePeerP2pCategoryRules(db) {
  const rules = listLearnedRules(db, "money");
  let deactivated = 0;
  rules.forEach((rule) => {
    if (!rule.active) return;
    if (rule.effect !== "set_category") return;
    const hay = `${rule.matchKey || ""} ${rule.evidence?.merchant || ""}`;
    if (!Learned.isPeerP2pMerchant(hay)) return;
    deactivateLearnedRule(db, rule.id);
    deactivated += 1;
  });
  if (deactivated && typeof db._persist === "function") db._persist();
  return { deactivated };
}

function maybeRecategorizeOnBoot(db) {
  const applied = getMeta(db, "categoryRulesVersion", "");
  const engineApplied = getMeta(db, "engineVersion", "");
  const directionApplied = getMeta(db, "directionRulesVersion", "");
  const p2pApplied = getMeta(db, "p2pLearnExceptionVersion", "");
  if (String(engineApplied) !== String(Model.ENGINE_VERSION)) {
    bumpSettingsStamp(db);
    setMeta(db, "engineVersion", String(Model.ENGINE_VERSION));
  }
  const DIRECTION_RULES_VERSION = "2";
  let directionHeal = { updated: 0, skipped: true };
  if (String(directionApplied) !== DIRECTION_RULES_VERSION) {
    directionHeal = { skipped: false, ...healBlankDirections(db) };
    setMeta(db, "directionRulesVersion", DIRECTION_RULES_VERSION);
  }
  let p2pHeal = { deactivated: 0, skipped: true };
  if (String(p2pApplied) !== "1") {
    p2pHeal = { skipped: false, ...deactivatePeerP2pCategoryRules(db) };
    setMeta(db, "p2pLearnExceptionVersion", "1");
  }
  if (String(applied) === String(Rules.CATEGORY_RULES_VERSION)) {
    return {
      skipped: true,
      version: Rules.CATEGORY_RULES_VERSION,
      directionHeal,
      p2pHeal
    };
  }
  return {
    skipped: false,
    ...recategorizeTransactions(db),
    directionHeal,
    p2pHeal
  };
}

function commitTransactions(db, updates, options = {}) {
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

  const learning = learnFromMoneyCommit(db, updates, {
    applySimilar: options.applySimilar !== false
  });

  if (typeof db._persist === "function") db._persist();
  return {
    committedAt: now,
    count: updates.length,
    learned: learning.learned,
    similarUpdated: learning.similarUpdated,
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

function markActionExecuted(db, id, status, detail, extra = {}) {
  const now = new Date().toISOString();
  const item = db.prepare("SELECT * FROM sync_items WHERE id = ?").get(id);
  if (!item) return;
  const payload = {
    status,
    detail,
    how: extra.how || null,
    reversible: extra.how === "inferred"
  };
  db.prepare(
    `UPDATE sync_items
     SET executed = 1, result_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(payload), now, id);
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

function clearBillPaid(db, id) {
  const existing = getBill(db, id);
  if (!existing) throw new Error(`Unknown bill id: ${id}`);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE bills SET last_paid_for = NULL, updated_at = ? WHERE id = ?`
  ).run(now, id);
  if (typeof db._persist === "function") db._persist();
  return getBill(db, id);
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
  let normalized = Rules.normalizeTransaction(raw, accountTypes);
  normalized = applyLearnedMoneyOverlay(db, normalized);
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
    asOfDate: snapshot.asOfDate || null,
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
    months: snapshot.months || [],
    recurringMarks: snapshot.recurringMarks || {},
    billSuggestions: snapshot.billSuggestions || [],
    cardSchedule: snapshot.cardSchedule || [],
    balanceSources: snapshot.balanceSources || {},
    balanceWarnings: snapshot.balanceWarnings || [],
    balances: snapshot.balances,
    holdingBreakdown: snapshot.holdingBreakdown,
    categoryDiagnostics: snapshot.categoryDiagnostics || {
      categories: [],
      leakFlag: null,
      envelopeSuggestions: []
    },
    safeToSpend: {
      period: snapshot.safeToSpend.period,
      periodSource: snapshot.safeToSpend.periodSource,
      fundingMode: snapshot.safeToSpend.fundingMode || "cash-backed",
      nextPayday: snapshot.safeToSpend.nextPayday,
      horizonDays: snapshot.safeToSpend.horizonDays,
      allocationWeeks: snapshot.safeToSpend.allocationWeeks,
      horizonSource: snapshot.safeToSpend.horizonSource,
      amount: snapshot.safeToSpend.remaining,
      income: snapshot.safeToSpend.income,
      weeklyIncome: snapshot.safeToSpend.weeklyIncome,
      incomeReceived: snapshot.safeToSpend.incomeReceived,
      incomeExpected: snapshot.safeToSpend.incomeExpected,
      committed: snapshot.safeToSpend.committed,
      commitments: snapshot.safeToSpend.commitments,
      dueThisWeek: snapshot.safeToSpend.dueThisWeek || [],
      savingsTarget: snapshot.safeToSpend.savingsTarget,
      savingsNeeded: snapshot.safeToSpend.savingsNeeded,
      savingsAlready: snapshot.safeToSpend.savingsAlready,
      savingsRemaining: snapshot.safeToSpend.savingsRemaining,
      spent: snapshot.safeToSpend.spent,
      remaining: snapshot.safeToSpend.remaining,
      cashBackedRemaining: snapshot.safeToSpend.cashBackedRemaining,
      breakdown: snapshot.safeToSpend.breakdown || null,
      incomeOutlook: snapshot.safeToSpend.incomeOutlook || [],
      assumptions: snapshot.safeToSpend.assumptions || [],
      ratchet: snapshot.safeToSpend.ratchet || null
    },
    flags: snapshot.flags || []
  };
}

function mapCourse(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    term: row.term || null,
    canvasCourseId: row.canvas_course_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listCourses(db) {
  return db
    .prepare("SELECT * FROM courses ORDER BY name COLLATE NOCASE")
    .all()
    .map(mapCourse);
}

function upsertCourse(db, course) {
  const now = new Date().toISOString();
  const id = String(course.id || "").trim();
  if (!id) throw new Error("course.id is required");
  const existing = db.prepare("SELECT * FROM courses WHERE id = ?").get(id);
  db.prepare(
    `INSERT INTO courses (id, name, term, canvas_course_id, created_at, updated_at)
     VALUES (@id, @name, @term, @canvasCourseId, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       term = COALESCE(excluded.term, courses.term),
       canvas_course_id = COALESCE(excluded.canvas_course_id, courses.canvas_course_id),
       updated_at = excluded.updated_at`
  ).run({
    id,
    name: String(course.name || id).slice(0, 160),
    term: course.term || null,
    canvasCourseId: course.canvasCourseId || course.canvas_course_id || null,
    createdAt: existing?.created_at || now,
    updatedAt: now
  });
  return mapCourse(db.prepare("SELECT * FROM courses WHERE id = ?").get(id));
}

function mapSyllabusSource(row) {
  if (!row) return null;
  return {
    id: row.id,
    courseId: row.course_id,
    sourceKind: row.source_kind,
    path: row.path || null,
    contentHash: row.content_hash || null,
    parsedAt: row.parsed_at || null,
    rawRef: row.raw_ref || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listSyllabusSources(db, courseId = null) {
  if (courseId) {
    return db
      .prepare(
        "SELECT * FROM syllabus_sources WHERE course_id = ? ORDER BY parsed_at DESC"
      )
      .all(courseId)
      .map(mapSyllabusSource);
  }
  return db
    .prepare("SELECT * FROM syllabus_sources ORDER BY parsed_at DESC")
    .all()
    .map(mapSyllabusSource);
}

function upsertSyllabusSource(db, source) {
  const now = new Date().toISOString();
  const id = String(source.id || "").trim();
  if (!id) throw new Error("syllabus_source.id is required");
  const existing = db.prepare("SELECT * FROM syllabus_sources WHERE id = ?").get(id);
  db.prepare(
    `INSERT INTO syllabus_sources
      (id, course_id, source_kind, path, content_hash, parsed_at, raw_ref, created_at, updated_at)
     VALUES (@id, @courseId, @sourceKind, @path, @contentHash, @parsedAt, @rawRef, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       course_id = excluded.course_id,
       source_kind = excluded.source_kind,
       path = excluded.path,
       content_hash = excluded.content_hash,
       parsed_at = excluded.parsed_at,
       raw_ref = excluded.raw_ref,
       updated_at = excluded.updated_at`
  ).run({
    id,
    courseId: source.courseId,
    sourceKind: source.sourceKind || source.source_kind || "file",
    path: source.path || null,
    contentHash: source.contentHash || source.content_hash || null,
    parsedAt: source.parsedAt || source.parsed_at || now,
    rawRef: source.rawRef || source.raw_ref || null,
    createdAt: existing?.created_at || now,
    updatedAt: now
  });
  return mapSyllabusSource(
    db.prepare("SELECT * FROM syllabus_sources WHERE id = ?").get(id)
  );
}

function mapAssessment(row) {
  if (!row) return null;
  return {
    id: row.id,
    courseId: row.course_id,
    kind: row.kind,
    title: row.title,
    date: row.date || null,
    time: row.time || null,
    weight: row.weight != null ? Number(row.weight) : null,
    source: row.source,
    confidence: row.confidence,
    leadDays: Number(row.lead_days) || 7,
    confirmed: Boolean(row.confirmed),
    canvasDate: row.canvas_date || null,
    parsedDate: row.parsed_date || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listAssessments(db, courseId = null) {
  if (courseId) {
    return db
      .prepare(
        "SELECT * FROM assessments WHERE course_id = ? ORDER BY date IS NULL, date"
      )
      .all(courseId)
      .map(mapAssessment);
  }
  return db
    .prepare("SELECT * FROM assessments ORDER BY date IS NULL, date")
    .all()
    .map(mapAssessment);
}

function upsertAssessment(db, assessment) {
  const now = new Date().toISOString();
  const id = String(assessment.id || "").trim();
  if (!id) throw new Error("assessment.id is required");
  const existing = db.prepare("SELECT * FROM assessments WHERE id = ?").get(id);
  const confirmed =
    assessment.confirmed != null
      ? assessment.confirmed
        ? 1
        : 0
      : existing
        ? existing.confirmed
        : assessment.confidence === "high"
          ? 1
          : 0;
  db.prepare(
    `INSERT INTO assessments
      (id, course_id, kind, title, date, time, weight, source, confidence, lead_days,
       confirmed, canvas_date, parsed_date, created_at, updated_at)
     VALUES (@id, @courseId, @kind, @title, @date, @time, @weight, @source, @confidence, @leadDays,
       @confirmed, @canvasDate, @parsedDate, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       course_id = excluded.course_id,
       kind = excluded.kind,
       title = excluded.title,
       date = excluded.date,
       time = excluded.time,
       weight = excluded.weight,
       source = excluded.source,
       confidence = excluded.confidence,
       lead_days = excluded.lead_days,
       confirmed = excluded.confirmed,
       canvas_date = excluded.canvas_date,
       parsed_date = excluded.parsed_date,
       updated_at = excluded.updated_at`
  ).run({
    id,
    courseId: assessment.courseId,
    kind: assessment.kind || "assignment",
    title: String(assessment.title || "Assessment").slice(0, 160),
    date: assessment.date || null,
    time: assessment.time || null,
    weight: assessment.weight != null ? Number(assessment.weight) : null,
    source: assessment.source || "syllabus",
    confidence: assessment.confidence || "high",
    leadDays: Number(assessment.leadDays != null ? assessment.leadDays : 7),
    confirmed,
    canvasDate: assessment.canvasDate || assessment.canvas_date || null,
    parsedDate:
      assessment.parsedDate ||
      assessment.parsed_date ||
      assessment.date ||
      null,
    createdAt: existing?.created_at || now,
    updatedAt: now
  });
  return mapAssessment(db.prepare("SELECT * FROM assessments WHERE id = ?").get(id));
}

function confirmAssessmentDate(db, assessmentId, date = null) {
  const row = db.prepare("SELECT * FROM assessments WHERE id = ?").get(assessmentId);
  if (!row) return null;
  const nextDate = date || row.date || row.parsed_date;
  db.prepare(
    `UPDATE assessments SET confirmed = 1, confidence = 'high', date = ?, updated_at = ? WHERE id = ?`
  ).run(nextDate, new Date().toISOString(), assessmentId);
  return mapAssessment(
    db.prepare("SELECT * FROM assessments WHERE id = ?").get(assessmentId)
  );
}

function mapTopic(row) {
  if (!row) return null;
  let readings = [];
  try {
    readings = JSON.parse(row.readings_json || "[]");
  } catch (_error) {
    readings = [];
  }
  return {
    id: row.id,
    courseId: row.course_id,
    assessmentId: row.assessment_id || null,
    title: row.title,
    week: row.week != null ? Number(row.week) : null,
    lectureRef: row.lecture_ref || null,
    readings: Array.isArray(readings) ? readings : [],
    reviewed: Boolean(row.reviewed),
    reviewedHow: row.reviewed_how || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listTopics(db, courseId = null) {
  if (courseId) {
    return db
      .prepare(
        "SELECT * FROM topics WHERE course_id = ? ORDER BY week IS NULL, week, title"
      )
      .all(courseId)
      .map(mapTopic);
  }
  return db
    .prepare("SELECT * FROM topics ORDER BY week IS NULL, week, title")
    .all()
    .map(mapTopic);
}

function upsertTopic(db, topic) {
  const now = new Date().toISOString();
  const id = String(topic.id || "").trim();
  if (!id) throw new Error("topic.id is required");
  const existing = db.prepare("SELECT * FROM topics WHERE id = ?").get(id);
  const reviewed =
    topic.reviewed != null ? (topic.reviewed ? 1 : 0) : existing ? existing.reviewed : 0;
  db.prepare(
    `INSERT INTO topics
      (id, course_id, assessment_id, title, week, lecture_ref, readings_json,
       reviewed, reviewed_how, reviewed_at, created_at, updated_at)
     VALUES (@id, @courseId, @assessmentId, @title, @week, @lectureRef, @readingsJson,
       @reviewed, @reviewedHow, @reviewedAt, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       course_id = excluded.course_id,
       assessment_id = excluded.assessment_id,
       title = excluded.title,
       week = excluded.week,
       lecture_ref = excluded.lecture_ref,
       readings_json = excluded.readings_json,
       reviewed = excluded.reviewed,
       reviewed_how = excluded.reviewed_how,
       reviewed_at = excluded.reviewed_at,
       updated_at = excluded.updated_at`
  ).run({
    id,
    courseId: topic.courseId,
    assessmentId: topic.assessmentId || topic.assessment_id || null,
    title: String(topic.title || "Topic").slice(0, 160),
    week: topic.week != null ? Number(topic.week) : null,
    lectureRef: topic.lectureRef || topic.lecture_ref || null,
    readingsJson: JSON.stringify(topic.readings || []),
    reviewed,
    reviewedHow:
      topic.reviewedHow || topic.reviewed_how || existing?.reviewed_how || null,
    reviewedAt: topic.reviewedAt || topic.reviewed_at || existing?.reviewed_at || null,
    createdAt: existing?.created_at || now,
    updatedAt: now
  });
  return mapTopic(db.prepare("SELECT * FROM topics WHERE id = ?").get(id));
}

function markTopicReviewed(db, topicId, how = "manual") {
  const now = new Date().toISOString();
  const row = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
  if (!row) return null;
  db.prepare(
    `UPDATE topics SET reviewed = 1, reviewed_how = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`
  ).run(how, now, now, topicId);
  return mapTopic(db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId));
}

function clearTopicReviewed(db, topicId) {
  const row = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
  if (!row) return null;
  const wasInferred = String(row.reviewed_how || "") === "inferred";
  db.prepare(
    `UPDATE topics SET reviewed = 0, reviewed_how = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), topicId);
  if (wasInferred) {
    try {
      const completion = require("../engine/completion.js");
      completion.skipInference(module.exports, db, topicId);
    } catch (_e) {
      // ignore
    }
  }
  return mapTopic(db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId));
}

function applySyllabusParse(db, parsed, sourceMeta = {}) {
  // Calendar-first: syllabus is enrichment (topics + confirm-me), never deletes live schedule.
  const scheduleMap = require("../engine/schedule-map.js");
  return scheduleMap.applySyllabusEnrichment(module.exports, db, parsed, sourceMeta);
}

function listSyllabusMapChanges(db) {
  try {
    const raw = JSON.parse(getMeta(db, "syllabusMapChanges", "[]"));
    return Array.isArray(raw) ? raw : [];
  } catch (_error) {
    return [];
  }
}

/** Record that a course assessment map was re-parsed / re-reconciled. */
function recordSyllabusMapChange(db, entry = {}) {
  const courseId = String(entry.courseId || "").trim();
  if (!courseId) return listSyllabusMapChanges(db);
  const next = [
    {
      courseId,
      at: entry.at || new Date().toISOString(),
      sourceId: entry.sourceId || null,
      sourceKind: entry.sourceKind || null,
      note: entry.note || "syllabus map re-parsed"
    },
    ...listSyllabusMapChanges(db)
  ].slice(0, 50);
  setMeta(db, "syllabusMapChanges", JSON.stringify(next));
  return next;
}

/**
 * Coverage: a missing exam must never read as all-clear.
 * - No confirmed assessments → "no syllabus loaded" (blocks clearDay), except
 *   bare Google Calendar lecture shells (course:gcal:*) with no Canvas/syllabus.
 * - Confirmed assessments but no topics → soft gap (schedule live; readiness empty).
 */
function coverageGaps(db) {
  const gaps = [];
  listCourses(db).forEach((course) => {
    const allAssessments = listAssessments(db, course.id);
    const confirmed = allAssessments.filter((a) => a.confirmed);
    const topics = listTopics(db, course.id);
    const sources = listSyllabusSources(db, course.id);
    const isGcalShell = String(course.id).startsWith("course:gcal:");
    const hasCanvasOrSyllabus =
      Boolean(course.canvasCourseId) || sources.length > 0;

    if (confirmed.length === 0) {
      // Pending confirm-me dates are not a coverage gap — confirmDates owns those.
      if (allAssessments.length > 0) return;
      if (isGcalShell && !hasCanvasOrSyllabus) return;
      gaps.push({
        courseId: course.id,
        note: `no syllabus loaded for ${course.name}`,
        blocksClear: true
      });
      return;
    }

    if (topics.length === 0) {
      gaps.push({
        courseId: course.id,
        note: `no study topics loaded for ${course.name} (calendar/Canvas schedule is live; optional syllabus/topics would enrich readiness)`,
        blocksClear: false
      });
    } else if (sources.length === 0 && hasCanvasOrSyllabus) {
      gaps.push({
        courseId: course.id,
        note: `no syllabus loaded for ${course.name}`,
        blocksClear: false
      });
    }
  });
  return gaps;
}

function listNeedsALook(db) {
  const confirmDates = listAssessments(db)
    .filter((a) => !a.confirmed)
    .map((a) => ({
      assessmentId: a.id,
      proposedDate: a.date || a.parsedDate,
      source: a.source,
      title: a.title
    }));
  let conflicts = [];
  try {
    conflicts = JSON.parse(getMeta(db, "syllabusConflicts", "[]"));
  } catch (_error) {
    conflicts = [];
  }
  return {
    conflicts: Array.isArray(conflicts) ? conflicts : [],
    confirmDates,
    coverageGaps: coverageGaps(db)
  };
}

function setSyllabusConflicts(db, conflicts) {
  setMeta(db, "syllabusConflicts", JSON.stringify(conflicts || []));
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
  recategorizeTransactions,
  maybeRecategorizeOnBoot,
  healBlankDirections,
  deactivatePeerP2pCategoryRules,
  commitTransactions,
  upsertSyncItem,
  listSyncItems,
  markActionExecuted,
  listLearnedRules,
  getLearnedRule,
  upsertLearnedRule,
  deactivateLearnedRule,
  applyLearnedMoneyOverlay,
  applyLearnedCategoryToSimilar,
  learnFromMoneyCommit,
  learnFromDigestAction,
  resolveDigestLearned,
  promoteBillFromSuggestion,
  listBills,
  getBill,
  upsertBill,
  markBillPaid,
  clearBillPaid,
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
  setMeta,
  listCourses,
  upsertCourse,
  listSyllabusSources,
  upsertSyllabusSource,
  listAssessments,
  upsertAssessment,
  confirmAssessmentDate,
  listTopics,
  upsertTopic,
  markTopicReviewed,
  clearTopicReviewed,
  applySyllabusParse,
  coverageGaps,
  listSyllabusMapChanges,
  recordSyllabusMapChange,
  listNeedsALook,
  setSyllabusConflicts
};
