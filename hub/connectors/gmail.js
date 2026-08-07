"use strict";

/**
 * Gmail OAuth for the laptop hub.
 * Client id/secret + refresh token live in the OS keychain only.
 */

const crypto = require("node:crypto");
const secretStore = require("../secret-store.js");

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const STATE_TTL_MS = 15 * 60 * 1000;

/** In-memory CSRF state for the localhost OAuth round-trip. */
const pendingStates = new Map();

function redirectUri(host, port) {
  return `http://${host || "127.0.0.1"}:${Number(port) || 8787}/api/gmail/callback`;
}

function pruneStates() {
  const now = Date.now();
  for (const [key, value] of pendingStates.entries()) {
    if (!value || value.expiresAt <= now) pendingStates.delete(key);
  }
}

function createOAuthState() {
  pruneStates();
  const state = crypto.randomBytes(24).toString("hex");
  pendingStates.set(state, { expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

function consumeOAuthState(state) {
  pruneStates();
  const row = pendingStates.get(String(state || ""));
  pendingStates.delete(String(state || ""));
  return Boolean(row && row.expiresAt > Date.now());
}

async function getStatus() {
  const clientId = Boolean(await secretStore.getConnectorSecret("email.clientId"));
  const clientSecret = Boolean(
    await secretStore.getConnectorSecret("email.clientSecret")
  );
  const refreshToken = Boolean(
    await secretStore.getConnectorSecret("email.refreshToken")
  );
  const email = (await secretStore.getConnectorSecret("email.address")) || null;
  return {
    clientId,
    clientSecret,
    refreshToken,
    connected: clientId && clientSecret && refreshToken,
    email,
    redirectUri: redirectUri("127.0.0.1", process.env.HUB_PORT || 8787),
    scope: GMAIL_SCOPE
  };
}

async function saveClientCredentials(clientId, clientSecret) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "").trim();
  if (!id || !secret) {
    throw new Error("clientId and clientSecret are required");
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
  const host = options.host || "127.0.0.1";
  const port = options.port || Number(process.env.HUB_PORT || 8787);
  const state = createOAuthState();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(host, port));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return { url: url.toString(), state, redirectUri: redirectUri(host, port) };
}

async function exchangeCode(code, options = {}) {
  const clientId = await secretStore.getConnectorSecret("email.clientId");
  const clientSecret = await secretStore.getConnectorSecret("email.clientSecret");
  if (!clientId || !clientSecret) {
    throw new Error("OAuth client credentials are not configured");
  }
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
    throw new Error(`Google token exchange HTTP ${tokenRes.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = await tokenRes.json();
  if (!json.refresh_token && !(await secretStore.getConnectorSecret("email.refreshToken"))) {
    throw new Error(
      "Google did not return a refresh token. Revoke hub access at myaccount.google.com/permissions and try Connect again."
    );
  }
  if (json.refresh_token) {
    await secretStore.setConnectorSecret("email.refreshToken", json.refresh_token);
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
        if (email) await secretStore.setConnectorSecret("email.address", email);
      }
    } catch (_error) {
      // Profile is optional — refresh token is the important part.
    }
  }

  return {
    ok: true,
    email,
    hasRefreshToken: Boolean(
      json.refresh_token || (await secretStore.getConnectorSecret("email.refreshToken"))
    )
  };
}

async function disconnect() {
  for (const name of [
    "email.clientId",
    "email.clientSecret",
    "email.refreshToken",
    "email.address"
  ]) {
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
  redirectUri,
  getStatus,
  saveClientCredentials,
  buildAuthUrl,
  exchangeCode,
  consumeOAuthState,
  disconnect,
  // test helpers
  _pendingStates: pendingStates,
  createOAuthState
};
