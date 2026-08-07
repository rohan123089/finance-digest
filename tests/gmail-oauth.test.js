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

async function main() {
  assert.equal(
    gmail.redirectUri("127.0.0.1", 8787),
    "http://127.0.0.1:8787/api/gmail/callback"
  );

  const prior = {
    clientId: await secretStore.getConnectorSecret("email.clientId"),
    clientSecret: await secretStore.getConnectorSecret("email.clientSecret"),
    refreshToken: await secretStore.getConnectorSecret("email.refreshToken"),
    address: await secretStore.getConnectorSecret("email.address")
  };

  async function restorePrior() {
    await gmail.disconnect();
    for (const [name, value] of [
      ["email.clientId", prior.clientId],
      ["email.clientSecret", prior.clientSecret],
      ["email.refreshToken", prior.refreshToken],
      ["email.address", prior.address]
    ]) {
      if (value) await secretStore.setConnectorSecret(name, value);
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-gmail-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 3);
  const db = dbApi.openDatabase({ dbPath, encryptionKey: key });

  const server = createServer(db, {
    projectRoot: tempRoot,
    syncRoot: path.join(tempRoot, "sync"),
    fetchImpl: async (url, init) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access-test",
            refresh_token: "refresh-test",
            expires_in: 3600,
            token_type: "Bearer"
          })
        };
      }
      if (String(url).includes("/gmail/v1/users/me/profile")) {
        return {
          ok: true,
          json: async () => ({ emailAddress: "digest@example.com" })
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

    const badAuth = await request(port, "GET", "/api/gmail/auth-url");
    assert.equal(badAuth.status, 400);

    const saved = await request(port, "POST", "/api/gmail/client", {
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: "test-secret"
    });
    assert.equal(saved.status, 200);

    const auth = await request(port, "GET", "/api/gmail/auth-url");
    assert.equal(auth.status, 200);
    assert.match(auth.body.url, /accounts\.google\.com/);
    assert.match(auth.body.url, /gmail\.readonly/);
    assert.ok(auth.body.state);

    gmail._pendingStates.set("state-test", { expiresAt: Date.now() + 60_000 });
    const callback = await request(
      port,
      "GET",
      "/api/gmail/callback?code=abc&state=state-test"
    );
    assert.equal(callback.status, 302);
    assert.match(callback.headers.location, /connected=1/);
    assert.match(callback.headers.location, /digest%40example\.com/);

    assert.equal(
      await secretStore.getConnectorSecret("email.refreshToken"),
      "refresh-test"
    );
    assert.equal(
      await secretStore.getConnectorSecret("email.address"),
      "digest@example.com"
    );

    const status1 = await request(port, "GET", "/api/gmail/status");
    assert.equal(status1.body.connected, true);
    assert.equal(status1.body.email, "digest@example.com");
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
