"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const rewards = require("../engine/rewards.js");
const rewardsWeb = require("../hub/connectors/rewards-web.js");
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
  const asOfDate = "2026-08-06";
  const rules = [
    {
      id: "rule:discover:*",
      accountId: "discover",
      category: "*",
      ratePct: 1,
      capUsd: null,
      priority: 0,
      source: "seed"
    },
    {
      id: "rule:amex:*",
      accountId: "amex",
      category: "*",
      ratePct: 1,
      capUsd: null,
      priority: 0,
      source: "seed"
    },
    {
      id: "rule:amex:groceries",
      accountId: "amex",
      category: "groceries",
      ratePct: 3,
      capUsd: 100,
      priority: 10,
      source: "seed"
    }
  ];
  const offers = [
    {
      id: "offer:discover:gas",
      accountId: "discover",
      title: "5% gas",
      category: "transportation",
      merchantContains: "",
      ratePct: 5,
      startsOn: "2026-07-01",
      endsOn: "2026-09-30",
      source: "web",
      active: true
    }
  ];
  const txs = [
    {
      id: "1",
      date: "2026-08-01",
      account: "amex",
      direction: "out",
      category: "transportation",
      merchant: "SHELL",
      amount: 40
    },
    {
      id: "2",
      date: "2026-08-02",
      account: "amex",
      direction: "out",
      category: "groceries",
      merchant: "TRADER JOE",
      amount: 80
    },
    {
      id: "3",
      date: "2026-08-03",
      account: "amex",
      direction: "out",
      category: "groceries",
      merchant: "WHOLE FOODS",
      amount: 50
    }
  ];

  const result = rewards.optimize(txs, rules, offers, { asOfDate, windowDays: 90 });
  assert.ok(result.byCategory.some((r) => r.category === "transportation"));
  const gas = result.byCategory.find((r) => r.category === "transportation");
  assert.equal(gas.bestCard, "discover");
  assert.ok(gas.missedUsd > 0);
  assert.ok(result.pointers.length >= 1);

  // Cap: groceries Amex 3% only on first $100 → $3, then 1% on $30 = $0.30 → $3.30 actual
  const groceries = result.byCategory.find((r) => r.category === "groceries");
  assert.ok(groceries.actualEarn <= 3.3 + 0.01);

  // Manual primacy
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-rewards-"));
  const dbPath = path.join(tmpRoot, "finance.db");
  const key = Buffer.alloc(32, 3);
  const db = dbApi.openDatabase({ dbPath, encryptionKey: key });
  assert.ok(dbApi.listRewardsRules(db).some((r) => r.accountId === "discover"));

  dbApi.upsertRewardsOffer(db, {
    id: "offer:discover:web:groceries:2026Q3",
    accountId: "discover",
    title: "Manual groceries 5%",
    category: "groceries",
    ratePct: 5,
    startsOn: "2026-07-01",
    endsOn: "2026-09-30",
    source: "manual",
    active: true
  });
  await rewardsWeb.syncRewards(db, { forceMock: true });
  const manual = dbApi.getRewardsOffer(db, "offer:discover:web:groceries:2026Q3");
  assert.equal(manual.source, "manual");
  assert.equal(manual.title, "Manual groceries 5%");

  const mockSync = await rewardsWeb.syncRewards(db, { forceMock: true });
  assert.equal(mockSync.mode, "mock");
  assert.ok(mockSync.upserted >= 1);

  // Failed live fetch leaves manual intact
  const beforeManual = dbApi.getRewardsOffer(db, "offer:discover:web:groceries:2026Q3");
  const failed = await rewardsWeb.syncRewards(db, {
    forceMock: false,
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  assert.equal(failed.mode, "skipped");
  assert.equal(
    dbApi.getRewardsOffer(db, "offer:discover:web:groceries:2026Q3").title,
    beforeManual.title
  );

  const server = createServer(db, {
    projectRoot: tmpRoot,
    syncRoot: path.join(tmpRoot, "sync")
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const api = await request(port, "GET", "/api/rewards/optimize");
  assert.equal(api.status, 200);
  assert.equal(api.body.kind, "rewards");

  const refresh = await request(port, "POST", "/api/rewards/refresh", {
    forceMock: true
  });
  assert.equal(refresh.status, 200);
  assert.equal(refresh.body.mode, "mock");

  const money = await request(port, "GET", "/apps/money/money.html");
  assert.match(money.text, /rewards-optimize/);
  assert.match(money.text, /Card rewards/);

  server.close();
  db.close();
  console.log("Rewards optimizer checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
