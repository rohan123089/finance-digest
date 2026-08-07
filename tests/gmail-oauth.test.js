"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const dbApi = require("../hub/db.js");
const { createServer } = require("../hub/server.js");
const gmail = require("../hub/connectors/gmail.js");
const secretStore = require("../hub/secret-store.js");

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch (_error) {
            parsed = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const SECRET_NAMES = [
  "email.clientId",
  "email.clientSecret",
  "email.refreshToken",
  "email.address",
  "email.1.refreshToken",
  "email.1.address",
  "email.2.refreshToken",
  "email.2.address",
  "email.3.refreshToken",
  "email.3.address"
];

async function main() {
  assert.equal(
    gmail.redirectUri("127.0.0.1", 8787),
    "http://127.0.0.1:8787/api/gmail/callback"
  );
  assert.equal(gmail.MAX_ACCOUNTS, 3);

  const prior = {};
  for (const name of SECRET_NAMES) {
    prior[name] = await secretStore.getConnectorSecret(name);
  }

  async function restorePrior() {
    await gmail.disconnect();
    for (const name of SECRET_NAMES) {
      if (prior[name]) await secretStore.setConnectorSecret(name, prior[name]);
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-gmail-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 3);
  const db = dbApi.openDatabase({ dbPath, encryptionKey: key });

  let profileEmail = "digest@example.com";
  const server = createServer(db, {
    projectRoot: tempRoot,
    syncRoot: path.join(tempRoot, "sync"),
    fetchImpl: async (url, init) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access-test",
            refresh_token: `refresh-${profileEmail}`,
            expires_in: 3600,
            token_type: "Bearer"
          })
        };
      }
      if (String(url).includes("/gmail/v1/users/me/profile")) {
        return {
          ok: true,
          json: async () => ({ emailAddress: profileEmail })
        };
      }
      throw new Error(`Unexpected fetch ${url} ${init?.method || "GET"}`);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await gmail.disconnect();

    const status0 = await request(port, "GET", "/api/gmail/status");
    assert.equal(status0.status, 200);
    assert.equal(status0.body.connected, false);
    assert.equal(status0.body.maxAccounts, 3);
    assert.equal(status0.body.accounts.length, 3);

    const badAuth = await request(port, "GET", "/api/gmail/auth-url?slot=1");
    assert.equal(badAuth.status, 400);

    const saved = await request(port, "POST", "/api/gmail/client", {
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: "test-secret"
    });
    assert.equal(saved.status, 200);

    const auth = await request(port, "GET", "/api/gmail/auth-url?slot=1");
    assert.equal(auth.status, 200);
    assert.match(auth.body.url, /accounts\.google\.com/);
    assert.match(auth.body.url, /gmail\.readonly/);
    assert.match(auth.body.url, /select_account/);
    assert.equal(auth.body.slot, 1);
    assert.ok(auth.body.state);

    gmail._pendingStates.set("1.state-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      expiresAt: Date.now() + 60_000,
      slot: 1
    });
    profileEmail = "digest@example.com";
    const callback = await request(
      port,
      "GET",
      "/api/gmail/callback?code=abc&state=1.state-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert.equal(callback.status, 302);
    assert.match(callback.headers.location, /connected=1/);
    assert.match(callback.headers.location, /slot=1/);
    assert.match(callback.headers.location, /digest%40example\.com/);

    assert.equal(
      await secretStore.getConnectorSecret("email.1.refreshToken"),
      "refresh-digest@example.com"
    );
    assert.equal(
      await secretStore.getConnectorSecret("email.1.address"),
      "digest@example.com"
    );

    const status1 = await request(port, "GET", "/api/gmail/status");
    assert.equal(status1.body.connected, true);
    assert.equal(status1.body.connectedCount, 1);
    assert.equal(status1.body.accounts[0].email, "digest@example.com");
    assert.equal(status1.body.clientIdValue, "test-client.apps.googleusercontent.com");

    // Keep secret on file when updating client id only
    const idOnly = await request(port, "POST", "/api/gmail/client", {
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: ""
    });
    assert.equal(idOnly.status, 200);
    assert.equal(idOnly.body.secretUnchanged, true);

    // Second inbox
    gmail._pendingStates.set("2.state-two-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
      expiresAt: Date.now() + 60_000,
      slot: 2
    });
    profileEmail = "school@example.com";
    const callback2 = await request(
      port,
      "GET",
      "/api/gmail/callback?code=def&state=2.state-two-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert.equal(callback2.status, 302);
    assert.match(callback2.headers.location, /slot=2/);
    assert.equal(
      await secretStore.getConnectorSecret("email.2.address"),
      "school@example.com"
    );

    const status2 = await request(port, "GET", "/api/gmail/status");
    assert.equal(status2.body.connectedCount, 2);

    const drop2 = await request(port, "POST", "/api/gmail/disconnect", { slot: 2 });
    assert.equal(drop2.status, 200);
    assert.equal(await secretStore.getConnectorSecret("email.2.refreshToken"), null);
    assert.equal(
      await secretStore.getConnectorSecret("email.1.address"),
      "digest@example.com"
    );

    const status3 = await request(port, "GET", "/api/gmail/status");
    assert.equal(status3.body.connectedCount, 1);
  } finally {
    server.close();
    db.close();
    await restorePrior();
  }

  console.log("Gmail OAuth hub connect checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
