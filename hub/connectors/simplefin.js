"use strict";

/**
 * SimpleFIN Bridge connector — claim setup token, fetch /accounts, map to local accounts.
 * Access URL (with basic auth) stays in the OS keychain; never returned to HTML.
 */

const dbApi = require("../db.js");
const secretStore = require("../secret-store.js");
const Model = require("../../engine/model.js");

function decodeSetupToken(setupToken) {
  const trimmed = String(setupToken || "").trim();
  if (!trimmed) throw new Error("SimpleFIN setup token is required");
  let claimUrl;
  try {
    claimUrl = Buffer.from(trimmed, "base64").toString("utf8").trim();
  } catch (_error) {
    throw new Error("SimpleFIN setup token is not valid base64");
  }
  if (!/^https:\/\//i.test(claimUrl)) {
    throw new Error("SimpleFIN setup token did not decode to an https claim URL");
  }
  return claimUrl;
}

function parseAccessUrl(accessUrl) {
  const url = new URL(String(accessUrl).trim());
  if (!url.username || !url.password) {
    throw new Error("SimpleFIN access URL must include basic-auth credentials");
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  const base = url.toString().replace(/\/$/, "");
  return { base, username, password };
}

async function claimSetupToken(setupToken, options = {}) {
  const claimUrl = decodeSetupToken(setupToken);
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(claimUrl, { method: "POST" });
  if (!response.ok) {
    throw new Error(`SimpleFIN claim HTTP ${response.status}`);
  }
  const accessUrl = (await response.text()).trim();
  if (!/^https:\/\//i.test(accessUrl)) {
    throw new Error("SimpleFIN claim did not return an access URL");
  }
  parseAccessUrl(accessUrl);
  await secretStore.setConnectorSecret("simplefin.accessUrl", accessUrl);
  return { ok: true, claimed: true };
}

async function fetchAccounts(options = {}) {
  const accessUrl =
    options.accessUrl || (await secretStore.getConnectorSecret("simplefin.accessUrl"));
  if (!accessUrl) {
    throw new Error("SimpleFIN access URL is not configured in the OS keychain");
  }
  const { base, username, password } = parseAccessUrl(accessUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(`${base}/accounts`);
  url.searchParams.set("version", "2");
  if (options.startDate != null) {
    const start =
      typeof options.startDate === "number"
        ? options.startDate
        : Math.floor(new Date(options.startDate).getTime() / 1000);
    url.searchParams.set("start-date", String(start));
  }
  if (options.pending) url.searchParams.set("pending", "1");

  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) throw new Error(`SimpleFIN accounts HTTP ${response.status}`);
  return response.json();
}

function epochToDate(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return new Date().toISOString().slice(0, 10);
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * SimpleFIN signs are uniform across account types:
 * positive = money into the account, negative = money out.
 * Credit-card purchases are negative; payments/credits are positive.
 * (Do not use Amex-CSV “positive = charge” here.)
 */
function directionHintFromSigned(amount, _accountType) {
  if (!Number.isFinite(amount) || amount === 0) return "";
  return amount < 0 ? "out" : "in";
}

/**
 * SimpleFIN: assets positive, debts negative.
 * Model: cash/investment positive owned; liability/external positive owed.
 */
function modelBalanceFromRemote(remoteBalance, accountType) {
  const value = Number(remoteBalance);
  if (!Number.isFinite(value)) return null;
  if (accountType === "liability" || accountType === "external") {
    return -value;
  }
  return value;
}

function listRemoteAccounts(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  return accounts.map((account) => ({
    id: String(account.id),
    name: account.name || account.id,
    currency: account.currency || "USD",
    balance: Number(account.balance),
    balanceDate: account["balance-date"]
      ? epochToDate(account["balance-date"])
      : null,
    org: account.org?.name || account.org?.domain || null,
    transactionCount: Array.isArray(account.transactions)
      ? account.transactions.length
      : 0
  }));
}

async function syncToDb(db, options = {}) {
  const forceMock = options.forceMock === true;
  let payload;
  let mode = "live";

  if (forceMock) {
    mode = "mock";
    // Signs match live SimpleFIN: debts have negative balances;
    // purchases negative, payments/credits positive.
    payload = {
      accounts: [
        {
          id: "sf-amex-1",
          name: "Amex Blue",
          currency: "USD",
          balance: "-120.50",
          "balance-date": Math.floor(Date.now() / 1000),
          org: { name: "American Express" },
          transactions: [
            {
              id: "sf-tx-1",
              posted: Math.floor(Date.now() / 1000) - 86400,
              amount: "-42.17",
              description: "TRADER JOE'S #1"
            },
            {
              id: "sf-tx-2",
              posted: Math.floor(Date.now() / 1000) - 3600,
              amount: "-25.00",
              description: "VENMO PAYMENT 9911"
            },
            {
              id: "sf-tx-3",
              posted: Math.floor(Date.now() / 1000) - 7200,
              amount: "200.00",
              description: "PAYMENT RECEIVED - THANK YOU"
            }
          ]
        }
      ]
    };
  } else {
    const startDate =
      options.startDate ||
      dbApi.getConnectorWatermark(db, "simplefin-start") ||
      Math.floor(Date.now() / 1000) - 90 * 24 * 3600;
    payload = await fetchAccounts({
      startDate,
      fetchImpl: options.fetchImpl,
      accessUrl: options.accessUrl
    });
  }

  const remote = listRemoteAccounts(payload);
  const emitted = [];
  const unmapped = [];
  let insertedCount = 0;
  let updatedCount = 0;

  (payload.accounts || []).forEach((remoteAccount) => {
    const sfId = String(remoteAccount.id);
    let local = dbApi.findAccountBySimplefinId(db, sfId);
    if (!local && options.autoMapByName) {
      const name = String(remoteAccount.name || "").toLowerCase();
      const candidates = dbApi.listAccounts(db);
      local =
        candidates.find((account) => name.includes(account.id.replace(/-/g, " "))) ||
        candidates.find((account) => name.includes(account.label.toLowerCase())) ||
        null;
      if (local) {
        dbApi.updateAccount(db, local.id, { simplefinAccountId: sfId });
        local = dbApi.getAccount(db, local.id);
      }
    }
    if (!local) {
      unmapped.push({
        id: sfId,
        name: remoteAccount.name || sfId,
        balance: Number(remoteAccount.balance)
      });
      return;
    }

    const remoteBalance = Number(remoteAccount.balance);
    const modelBalance = modelBalanceFromRemote(remoteBalance, local.type);
    const shouldUpdateOpening =
      options.updateOpeningBalance !== false && modelBalance != null;
    if (shouldUpdateOpening) {
      // Live institution balance is source of truth for SimpleFIN-linked cards/
      // banks. Opening is reconciled from *this account's own* txs only —
      // UWCU→Amex payment transfers must not double-count against Amex's feed.
      const maps = dbApi.getAccountMaps(db);
      const ownTxs = dbApi.listTransactions(db).filter((tx) => tx.account === local.id);
      const activity = Model.accountActivityDelta(
        ownTxs,
        local.id,
        local.type,
        maps.accountTypes
      );
      const opening = Model.openingFromRemoteBalance(modelBalance, activity);
      const holdings = Model.normalizeHoldings(remoteAccount.holdings || []);
      dbApi.updateAccount(db, local.id, {
        openingBalance: opening,
        reportedBalance: modelBalance,
        reportedAt: new Date().toISOString(),
        holdings
      });
      local = dbApi.getAccount(db, local.id);
    } else if (modelBalance != null) {
      dbApi.updateAccount(db, local.id, {
        reportedBalance: modelBalance,
        reportedAt: new Date().toISOString(),
        holdings: Array.isArray(remoteAccount.holdings)
          ? Model.normalizeHoldings(remoteAccount.holdings)
          : undefined
      });
    } else if (Array.isArray(remoteAccount.holdings)) {
      dbApi.updateAccount(db, local.id, {
        holdings: Model.normalizeHoldings(remoteAccount.holdings)
      });
    }

    const txs = Array.isArray(remoteAccount.transactions)
      ? remoteAccount.transactions
      : [];
    txs.forEach((tx) => {
      const amount = Number(tx.amount);
      if (!Number.isFinite(amount)) return;
      const raw = {
        id: `sf:${local.id}:${tx.id || `${tx.posted}-${tx.description}`}`,
        date: epochToDate(tx.posted),
        rawMerchant: String(tx.description || tx.payee || "SimpleFIN").slice(0, 200),
        amount: Math.abs(amount),
        account: local.id,
        directionHint: directionHintFromSigned(amount, local.type)
      };
      const result = dbApi.upsertRawTransactionFromSync(db, raw);
      if (result.inserted) {
        insertedCount += 1;
        emitted.push(raw);
      } else if (result.updated) {
        updatedCount += 1;
        emitted.push(raw);
      }
    });
  });

  dbApi.setConnectorWatermark(db, "simplefin", new Date().toISOString());
  const linked = dbApi.linkInternalTransfers(db);
  return {
    source: "simplefin",
    mode,
    remote,
    unmapped,
    emitted,
    inserted: insertedCount,
    updated: updatedCount,
    linkedTransfers: linked.linked || 0
  };
}

/**
 * Background SimpleFIN balance/tx pull. Default every 30 minutes while hub runs.
 * Set HUB_SIMPLEFIN_POLL_MS=0 (or HUB_SIMPLEFIN_AUTO=0) to disable.
 */
function startAutoSync(db, options = {}) {
  const envPoll = process.env.HUB_SIMPLEFIN_POLL_MS;
  const envAuto = process.env.HUB_SIMPLEFIN_AUTO;
  if (envAuto === "0" || envAuto === "false") {
    return { enabled: false, intervalMs: 0, stop() {} };
  }
  const intervalMs = Number(
    envPoll != null && envPoll !== ""
      ? envPoll
      : options.intervalMs != null
        ? options.intervalMs
        : 30 * 60 * 1000
  );
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { enabled: false, intervalMs: 0, stop() {} };
  }

  let timer = null;
  let running = false;
  const onResult =
    typeof options.onResult === "function" ? options.onResult : async () => {};
  const log =
    typeof options.log === "function" ? options.log : (msg) => console.log(msg);

  async function tick(reason) {
    if (running) return;
    running = true;
    try {
      const accessUrl = await secretStore.getConnectorSecret("simplefin.accessUrl");
      if (!accessUrl) {
        dbApi.setMeta(db, "simplefinAutoSync", JSON.stringify({
          enabled: true,
          intervalMs,
          lastAttemptAt: new Date().toISOString(),
          lastStatus: "skipped",
          reason: "not configured"
        }));
        return;
      }
      const result = await syncToDb(db, {
        fetchImpl: options.fetchImpl,
        updateOpeningBalance: options.updateOpeningBalance !== false
      });
      dbApi.setMeta(db, "simplefinAutoSync", JSON.stringify({
        enabled: true,
        intervalMs,
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastStatus: result.mode || "ok",
        reason: reason || "poll",
        inserted: result.inserted || 0,
        updated: result.updated || 0
      }));
      await onResult(result);
      log(
        `SimpleFIN auto-sync (${reason || "poll"}): ${result.mode}, ` +
          `+${result.inserted || 0} tx, updated openings/balances`
      );
    } catch (error) {
      dbApi.setMeta(db, "simplefinAutoSync", JSON.stringify({
        enabled: true,
        intervalMs,
        lastAttemptAt: new Date().toISOString(),
        lastStatus: "error",
        reason: reason || "poll",
        error: error.message || String(error)
      }));
      log(`SimpleFIN auto-sync failed: ${error.message || error}`);
    } finally {
      running = false;
    }
  }

  // First pull shortly after boot so payments land without opening SimpleFIN UI.
  const bootDelayMs = Number(options.bootDelayMs != null ? options.bootDelayMs : 8000);
  const bootTimer = setTimeout(() => tick("boot"), Math.max(0, bootDelayMs));
  timer = setInterval(() => tick("interval"), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  if (typeof bootTimer.unref === "function") bootTimer.unref();

  dbApi.setMeta(db, "simplefinAutoSync", JSON.stringify({
    enabled: true,
    intervalMs,
    startedAt: new Date().toISOString()
  }));

  return {
    enabled: true,
    intervalMs,
    stop() {
      clearTimeout(bootTimer);
      if (timer) clearInterval(timer);
      timer = null;
    },
    runNow: () => tick("manual")
  };
}

function readAutoSyncStatus(db) {
  try {
    return JSON.parse(dbApi.getMeta(db, "simplefinAutoSync", "null"));
  } catch (_error) {
    return null;
  }
}

module.exports = {
  decodeSetupToken,
  parseAccessUrl,
  claimSetupToken,
  fetchAccounts,
  listRemoteAccounts,
  modelBalanceFromRemote,
  directionHintFromSigned,
  syncToDb,
  startAutoSync,
  readAutoSyncStatus
};
