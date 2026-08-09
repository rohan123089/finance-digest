"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const ai = require("../hub/ai.js");
const sync = require("../hub/sync.js");
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
            body: text && type.includes("json") ? JSON.parse(text) : null,
            text
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
  const html = fs.readFileSync(
    path.join(__dirname, "../apps/digest/digest.html"),
    "utf8"
  );
  assert.match(html, /Shelf\.ai\.propose/);
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /\/api\/ai/);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-hub-m5-"));
  const projectRoot = tmpRoot;
  const syncRoot = path.join(tmpRoot, "sync");
  const dbPath = path.join(tmpRoot, "finance.db");
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });

  const key = Buffer.alloc(32, 6);
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    encryptionKey: key,
    samplePath: path.join(__dirname, "../sample-data/transactions.json")
  });

  assert.equal(ai.getAiMode(db), "OFF");
  const off = await ai.propose(db);
  assert.equal(off.proposal, null);
  assert.equal(off.mutatesRecords, false);

  const before = dbApi.listTransactions(db).length;
  ai.setAiMode(db, "LOCAL");
  const local = await ai.propose(db);
  assert.equal(local.mode, "LOCAL");
  assert.equal(local.mutatesRecords, false);
  assert.equal(local.proposal.mutations.length, 0);
  assert.ok(local.proposal.flags.length >= 1);
  assert.equal("transactions" in local.input, false);
  assert.equal("balances" in local.input, false);
  assert.equal(JSON.stringify(local.input).includes("rawMerchant"), false);
  assert.equal(dbApi.listTransactions(db).length, before);

  ai.setAiMode(db, "CLOUD");
  const cloud = await ai.propose(db);
  assert.equal(cloud.mode, "CLOUD");
  assert.equal(cloud.mutatesRecords, false);
  assert.equal(cloud.proposal.mutations.length, 0);

  const digest = sync.buildDigest(db);
  assert.ok(digest.detail.today.some((item) => item.kind === "nudge"));

  const server = createServer(db, { projectRoot, syncRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const health = await request(port, "GET", "/api/health");
  assert.ok(["M5", "M6", "M7"].includes(health.body.milestone));
  assert.equal(health.body.aiMode, "CLOUD");

  const mode = await request(port, "POST", "/api/ai/mode", { mode: "LOCAL" });
  assert.equal(mode.body.mode, "LOCAL");

  const propose = await request(port, "POST", "/api/ai/propose", {});
  assert.equal(propose.status, 200);
  assert.equal(propose.body.mutatesRecords, false);
  assert.equal(propose.body.proposal.mutations.length, 0);
  assert.equal("balances" in propose.body.input, false);

  const listed = await request(port, "GET", "/api/ai/proposals");
  assert.ok(listed.body.proposals.length >= 1);
  assert.ok(listed.body.proposals.every((row) => Array.isArray(row.mutations)));

  await new Promise((resolve) => server.close(resolve));
  db.close();
  console.log("Hub M5 gated AI checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
