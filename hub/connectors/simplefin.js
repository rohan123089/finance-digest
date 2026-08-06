"use strict";

/**
 * SimpleFIN Bridge connector — claim setup token, fetch /accounts, map to local accounts.
 * Access URL (with basic auth) stays in the OS keychain; never returned to HTML.
 */

const dbApi = require("../db.js");
const secretStore = require("../secret-store.js");

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

function directionHintFromSigned(amount, accountType) {
  if (!Number.isFinite(amount) || amount === 0) return "";
  if (accountType === "liability" || accountType === "external") {
    return amount > 0 ? "out" : "in";
  }
  return amount < 0 ? "out" : "in";
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
    payload = {
      accounts: [
        {
          id: "sf-amex-1",
          name: "Amex Blue",
          currency: "USD",
          balance: "120.50",
          "balance-date": Math.floor(Date.now() / 1000),
          org: { name: "American Express" },
          transactions: [
            {
              id: "sf-tx-1",
              posted: Math.floor(Date.now() / 1000) - 86400,
              amount: "42.17",
              description: "TRADER JOE'S #1"
            },
            {
              id: "sf-tx-2",
              posted: Math.floor(Date.now() / 1000) - 3600,
              amount: "25.00",
              description: "VENMO PAYMENT 9911"
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

    const balance = Number(remoteAccount.balance);
    if (Number.isFinite(balance) && options.updateOpeningBalance) {
      dbApi.updateAccount(db, local.id, { openingBalance: balance });
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
      const result = dbApi.insertRawTransaction(db, raw);
      if (result.inserted) emitted.push(raw);
    });
  });

  dbApi.setConnectorWatermark(db, "simplefin", new Date().toISOString());
  return {
    source: "simplefin",
    mode,
    remote,
    unmapped,
    emitted,
    inserted: emitted.length
  };
}

module.exports = {
  decodeSetupToken,
  parseAccessUrl,
  claimSetupToken,
  fetchAccounts,
  listRemoteAccounts,
  syncToDb
};
