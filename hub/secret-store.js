"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const keytar = require("keytar");
const { DEFAULT_DB_PATH } = require("./db.js");

const SERVICE = "Shelf Finance Hub";

const CONNECTOR_ACCOUNTS = Object.freeze({
  "groupme.token": "connector:groupme.token",
  "groupme.groupId": "connector:groupme.groupId",
  "email.clientId": "connector:email.clientId",
  "email.clientSecret": "connector:email.clientSecret",
  "email.refreshToken": "connector:email.refreshToken",
  "email.address": "connector:email.address",
  "canvas.token": "connector:canvas.token",
  "canvas.baseUrl": "connector:canvas.baseUrl",
  "bank.token": "connector:bank.token",
  "bank.endpoint": "connector:bank.endpoint",
  "simplefin.accessUrl": "connector:simplefin.accessUrl",
  "ai.cloudKey": "connector:ai.cloudKey",
  "ai.cloudBaseUrl": "connector:ai.cloudBaseUrl",
  "ai.cloudModel": "connector:ai.cloudModel"
});

function accountForDatabase(dbPath) {
  const normalized = path.resolve(dbPath).toLowerCase();
  const id = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `database-key:${id}`;
}

async function getOrCreateDatabaseKey(dbPath = DEFAULT_DB_PATH) {
  const account = accountForDatabase(dbPath);
  const stored = await keytar.getPassword(SERVICE, account);
  if (stored) {
    const key = Buffer.from(stored, "base64");
    if (key.length !== 32) {
      throw new Error("The database key in the OS keychain is invalid");
    }
    return key;
  }

  const key = crypto.randomBytes(32);
  await keytar.setPassword(SERVICE, account, key.toString("base64"));
  return key;
}

function connectorAccount(name) {
  const account = CONNECTOR_ACCOUNTS[name];
  if (!account) {
    throw new Error(
      `Unknown connector secret '${name}'. Expected one of: ${Object.keys(CONNECTOR_ACCOUNTS).join(", ")}`
    );
  }
  return account;
}

async function getConnectorSecret(name) {
  return keytar.getPassword(SERVICE, connectorAccount(name));
}

async function setConnectorSecret(name, value) {
  if (value == null || String(value).length === 0) {
    throw new Error(`Refusing to store an empty secret for ${name}`);
  }
  await keytar.setPassword(SERVICE, connectorAccount(name), String(value));
  return true;
}

async function deleteConnectorSecret(name) {
  return keytar.deletePassword(SERVICE, connectorAccount(name));
}

async function listConfiguredConnectors() {
  const configured = {};
  for (const name of Object.keys(CONNECTOR_ACCOUNTS)) {
    configured[name] = Boolean(await getConnectorSecret(name));
  }
  return configured;
}

module.exports = {
  SERVICE,
  CONNECTOR_ACCOUNTS,
  accountForDatabase,
  getOrCreateDatabaseKey,
  getConnectorSecret,
  setConnectorSecret,
  deleteConnectorSecret,
  listConfiguredConnectors
};
