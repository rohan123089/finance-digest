"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const connectors = require("../hub/connectors/index.js");
const { createServer } = require("../hub/server.js");

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
          const type = res.headers["content-type"] || "";
          resolve({
            status: res.statusCode,
            body: text && type.includes("json") ? JSON.parse(text) : null
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-hub-m3-"));
  const projectRoot = tmpRoot;
  const syncRoot = path.join(tmpRoot, "sync");
  const dbPath = path.join(tmpRoot, "finance.db");
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });

  const key = Buffer.alloc(32, 3);
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    encryptionKey: key,
    samplePath: path.join(__dirname, "../sample-data/transactions.json")
  });

  const beforeCount = dbApi.listTransactions(db).length;
  const result = await connectors.runAll(db, { forceMock: true });
  assert.equal(result.groupme.mode, "mock");
  assert.ok(result.groupme.emitted.length >= 1);
  assert.equal(result.email.mode, "mock");
  assert.ok(result.email.emitted.length >= 1);
  assert.equal(result.bank.mode, "mock");
  assert.ok(result.bank.emitted.length >= 1);
  assert.equal(dbApi.listTransactions(db).length, beforeCount + result.bank.emitted.length);
  assert.equal(dbApi.getConnectorWatermark(db, "groupme"), "998878");

  // Live paths without keychain secrets must fail closed (no silent env fallback).
  // Clear any real laptop secrets for this assertion, then restore.
  const secretStore = require("../hub/secret-store.js");
  const priorSecrets = {};
  for (const name of [
    "groupme.token",
    "groupme.groupId",
    "groupme.groupIds",
    "groupme.groupMeta",
    "email.clientId",
    "email.clientSecret",
    "email.refreshToken",
    "email.1.refreshToken",
    "email.2.refreshToken",
    "email.3.refreshToken",
    "bank.token"
  ]) {
    priorSecrets[name] = await secretStore.getConnectorSecret(name);
    if (priorSecrets[name]) {
      try {
        await secretStore.deleteConnectorSecret(name);
      } catch (_e) {
        // ignore
      }
    }
  }
  try {
    await assert.rejects(
      () => connectors.runGroupMe(db, { forceMock: false }),
      /keychain|token|GroupMe/i
    );
    await assert.rejects(
      () => connectors.runEmail(db, { forceMock: false }),
      /mock|configured|OAuth/i
    );
    await assert.rejects(
      () => connectors.runBank(db, { forceMock: false }),
      /mock|configured|Bank/i
    );

    const server = createServer(db, { projectRoot, syncRoot });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const health = await request(port, "GET", "/api/health");
    assert.ok(["M3", "M4", "M5", "M6", "M7"].includes(health.body.milestone));
    assert.equal(typeof health.body.connectors, "object");
    assert.equal(health.body.connectors["groupme.token"], false);

    const run = await request(port, "POST", "/api/connectors/run", {
      forceMock: true
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.forceMock, true);
    assert.equal(run.body.groupme.mode, "mock");
    assert.equal(typeof run.body.groupme.emitted, "number");
    assert.equal(JSON.stringify(run.body).includes("token"), false);

    const digest = await request(port, "GET", "/api/digest");
    assert.ok(digest.body.detail.today.some((item) => item.kind === "event"));
    assert.ok(digest.body.detail.reading.some((item) => item.source === "newsletter"));

    // Default connector run must not inject mock data.
    const liveDefault = await request(port, "POST", "/api/connectors/run", {});
    assert.equal(liveDefault.status, 200);
    assert.equal(liveDefault.body.forceMock, false);

    await new Promise((resolve) => server.close(resolve));
    db.close();
  } finally {
    for (const [name, value] of Object.entries(priorSecrets)) {
      if (value) await secretStore.setConnectorSecret(name, value);
    }
  }

  console.log("Hub M3 connector checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
