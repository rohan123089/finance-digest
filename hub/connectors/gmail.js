"use strict";

/**
 * Gmail OAuth for the laptop hub.
 * One shared Google OAuth client; up to 3 inbox refresh tokens in the OS keychain.
 */

const crypto = require("node:crypto");
const secretStore = require("../secret-store.js");

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_ACCOUNTS = 3;

/** In-memory CSRF state for the localhost OAuth round-trip. */
const pendingStates = new Map();

function redirectUri(host, port) {
  return `http://${host || "127.0.0.1"}:${Number(port) || 8787}/api/gmail/callback`;
}

function normalizeSlot(slot) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ACCOUNTS) {
    throw new Error(`Gmail account slot must be 1–${MAX_ACCOUNTS}`);
  }
  return n;
}

function slotKeys(slot) {
  const n = normalizeSlot(slot);
  return {
    refreshToken: `email.${n}.refreshToken`,
    address: `email.${n}.address`
  };
}

function pruneStates() {
  const now = Date.now();
  for (const [key, value] of pendingStates.entries()) {
    if (!value || value.expiresAt <= now) pendingStates.delete(key);
  }
}

function createOAuthState(slot = 1) {
  pruneStates();
  const n = normalizeSlot(slot);
  // Encode slot in the state string so callback still knows which inbox
  // even if an older hub build ignored the Map payload shape.
  const state = `${n}.${crypto.randomBytes(24).toString("hex")}`;
  pendingStates.set(state, {
    expiresAt: Date.now() + STATE_TTL_MS,
    slot: n
  });
  return state;
}

function consumeOAuthState(state) {
  pruneStates();
  const key = String(state || "");
  const row = pendingStates.get(key);
  pendingStates.delete(key);
  if (row && row.expiresAt > Date.now()) {
    return { slot: normalizeSlot(row.slot || 1) };
  }
  // Fallback: parse "slot.nonce" if the Map entry was lost (hub restart mid-OAuth).
  const match = /^([1-3])\.[a-f0-9]{32,}$/i.exec(key);
  if (match) return { slot: normalizeSlot(match[1]) };
  return null;
}

/**
 * Copy legacy single-inbox secrets into slot 1 when slot 1 is empty.
 */
async function migrateLegacyAccount() {
  const legacyToken = await secretStore.getConnectorSecret("email.refreshToken");
  if (!legacyToken) return false;
  const slot1 = await secretStore.getConnectorSecret("email.1.refreshToken");
  if (slot1) return false;
  await secretStore.setConnectorSecret("email.1.refreshToken", legacyToken);
  const legacyAddress = await secretStore.getConnectorSecret("email.address");
  if (legacyAddress) {
    await secretStore.setConnectorSecret("email.1.address", legacyAddress);
  }
  return true;
}

async function listAccounts() {
  await migrateLegacyAccount();
  const accounts = [];
  for (let slot = 1; slot <= MAX_ACCOUNTS; slot++) {
    const keys = slotKeys(slot);
    const refreshToken = Boolean(await secretStore.getConnectorSecret(keys.refreshToken));
    const email = (await secretStore.getConnectorSecret(keys.address)) || null;
    accounts.push({
      slot,
      connected: refreshToken,
      email
    });
  }
  return accounts;
}

async function getConnectedRefreshAccounts() {
  await migrateLegacyAccount();
  const out = [];
  for (let slot = 1; slot <= MAX_ACCOUNTS; slot++) {
    const keys = slotKeys(slot);
    let refreshToken = await secretStore.getConnectorSecret(keys.refreshToken);
    if (!refreshToken && slot === 1) {
      // Last-resort legacy read if migrate could not write.
      refreshToken = await secretStore.getConnectorSecret("email.refreshToken");
    }
    if (!refreshToken) continue;
    let address = await secretStore.getConnectorSecret(keys.address);
    if (!address && slot === 1) {
      address = await secretStore.getConnectorSecret("email.address");
    }
    out.push({ slot, refreshToken, address: address || null });
  }
  return out;
}

async function getStatus() {
  await migrateLegacyAccount();
  const clientIdValue = (await secretStore.getConnectorSecret("email.clientId")) || null;
  const clientSecret = Boolean(
    await secretStore.getConnectorSecret("email.clientSecret")
  );
  const accounts = await listAccounts();
  const connectedCount = accounts.filter((a) => a.connected).length;
  const primary = accounts.find((a) => a.connected) || accounts[0];
  return {
    clientId: Boolean(clientIdValue),
    clientIdValue,
    clientSecret,
    refreshToken: connectedCount > 0,
    connected: Boolean(clientIdValue) && clientSecret && connectedCount > 0,
    connectedCount,
    maxAccounts: MAX_ACCOUNTS,
    email: primary?.email || null,
    accounts,
    redirectUri: redirectUri("127.0.0.1", process.env.HUB_PORT || 8787),
    scope: GMAIL_SCOPE
  };
}

async function saveClientCredentials(clientId, clientSecret) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "").trim();
  if (!id) {
    throw new Error("clientId is required");
  }
  if (!secret) {
    const existing = await secretStore.getConnectorSecret("email.clientSecret");
    if (!existing) {
      throw new Error("clientSecret is required (nothing on file yet)");
    }
    await secretStore.setConnectorSecret("email.clientId", id);
    return { ok: true, secretUnchanged: true };
  }
  await secretStore.setConnectorSecret("email.clientId", id);
  await secretStore.setConnectorSecret("email.clientSecret", secret);
  return { ok: true };
}

async function buildAuthUrl(options = {}) {
  const clientId = await secretStore.getConnectorSecret("email.clientId");
  if (!clientId) {
    throw new Error("Save a Google OAuth client id first");
  }
  const slot = normalizeSlot(options.slot || 1);
  const host = options.host || "127.0.0.1";
  const port = options.port || Number(process.env.HUB_PORT || 8787);
  const state = createOAuthState(slot);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(host, port));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  // Force account picker so slot 2/3 can be a different Google login.
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return {
    url: url.toString(),
    state,
    slot,
    redirectUri: redirectUri(host, port)
  };
}

async function exchangeCode(code, options = {}) {
  const clientId = await secretStore.getConnectorSecret("email.clientId");
  const clientSecret = await secretStore.getConnectorSecret("email.clientSecret");
  if (!clientId || !clientSecret) {
    throw new Error("OAuth client credentials are not configured");
  }
  const slot = normalizeSlot(options.slot || 1);
  const keys = slotKeys(slot);
  const host = options.host || "127.0.0.1";
  const port = options.port || Number(process.env.HUB_PORT || 8787);
  const fetchImpl = options.fetchImpl || fetch;

  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(host, port),
      grant_type: "authorization_code"
    })
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(
      `Google token exchange HTTP ${tokenRes.status}${text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }
  const json = await tokenRes.json();
  const existing = await secretStore.getConnectorSecret(keys.refreshToken);
  if (!json.refresh_token && !existing) {
    throw new Error(
      "Google did not return a refresh token. Revoke hub access at myaccount.google.com/permissions and try Connect again."
    );
  }
  if (json.refresh_token) {
    await secretStore.setConnectorSecret(keys.refreshToken, json.refresh_token);
    if (slot === 1) {
      // Keep legacy keys in sync for older CLI / docs.
      await secretStore.setConnectorSecret("email.refreshToken", json.refresh_token);
    }
  }

  let email = null;
  if (json.access_token) {
    try {
      const profileRes = await fetchImpl(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        {
          headers: {
            Authorization: `Bearer ${json.access_token}`,
            Accept: "application/json"
          }
        }
      );
      if (profileRes.ok) {
        const profile = await profileRes.json();
        email = profile.emailAddress || null;
        if (email) {
          await secretStore.setConnectorSecret(keys.address, email);
          if (slot === 1) {
            await secretStore.setConnectorSecret("email.address", email);
          }
        }
      }
    } catch (_error) {
      // Profile is optional — refresh token is the important part.
    }
  }

  return {
    ok: true,
    slot,
    email,
    hasRefreshToken: Boolean(
      json.refresh_token || (await secretStore.getConnectorSecret(keys.refreshToken))
    )
  };
}

async function disconnectAccount(slot) {
  const keys = slotKeys(slot);
  for (const name of [keys.refreshToken, keys.address]) {
    try {
      await secretStore.deleteConnectorSecret(name);
    } catch (_error) {
      // ignore missing
    }
  }
  if (normalizeSlot(slot) === 1) {
    for (const name of ["email.refreshToken", "email.address"]) {
      try {
        await secretStore.deleteConnectorSecret(name);
      } catch (_error) {
        // ignore
      }
    }
  }
  return { ok: true, slot: normalizeSlot(slot) };
}

async function disconnect(options = {}) {
  if (options.slot != null) {
    return disconnectAccount(options.slot);
  }
  for (let slot = 1; slot <= MAX_ACCOUNTS; slot++) {
    await disconnectAccount(slot);
  }
  for (const name of ["email.clientId", "email.clientSecret"]) {
    try {
      await secretStore.deleteConnectorSecret(name);
    } catch (_error) {
      // ignore missing
    }
  }
  return { ok: true };
}

module.exports = {
  GMAIL_SCOPE,
  MAX_ACCOUNTS,
  redirectUri,
  normalizeSlot,
  slotKeys,
  getStatus,
  listAccounts,
  getConnectedRefreshAccounts,
  migrateLegacyAccount,
  saveClientCredentials,
  buildAuthUrl,
  exchangeCode,
  consumeOAuthState,
  disconnect,
  disconnectAccount,
  // test helpers
  _pendingStates: pendingStates,
  createOAuthState
};
