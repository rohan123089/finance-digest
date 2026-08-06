"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const ai = require("../hub/ai.js");
const connectors = require("../hub/connectors/index.js");
const pairing = require("../hub/pairing.js");
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-hub-m6-"));
  const projectRoot = tmpRoot;
  const syncRoot = path.join(tmpRoot, "sync");
  const dbPath = path.join(tmpRoot, "finance.db");
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });

  const key = Buffer.alloc(32, 11);
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    encryptionKey: key,
    samplePath: path.join(__dirname, "../sample-data/transactions.json")
  });

  // Pairing QR encodes the sync key but the HTTP JSON must not echo payloadText.
  const card = await pairing.buildPairing(projectRoot, {
    hubUrl: "http://127.0.0.1:8787"
  });
  assert.match(card.svg, /<svg/i);
  assert.equal(typeof card.fingerprint, "string");
  assert.match(card.payloadText, /shelf-sync-key/);

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/chat/completions")) {
      const body = JSON.parse(init.body);
      const user = body.messages.find((m) => m.role === "user");
      assert.doesNotMatch(user.content, /rawMerchant/);
      assert.doesNotMatch(user.content, /balances/);
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "cloud ok",
                    flags: [
                      {
                        id: "flag-cloud",
                        trigger: "owed",
                        why: "test",
                        action: "Pay outside payments",
                        value: 1,
                        deadline: null,
                        confidence: 0.5
                      }
                    ],
                    mutations: [{ evil: true }]
                  })
                }
              }
            ]
          };
        }
      };
    }
    if (href.includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        async json() {
          return { access_token: "test-access" };
        }
      };
    }
    if (href.includes("gmail.googleapis.com") && href.includes("/messages?")) {
      return {
        ok: true,
        async json() {
          return { messages: [{ id: "m1" }] };
        }
      };
    }
    if (href.includes("gmail.googleapis.com") && href.includes("/messages/m1")) {
      return {
        ok: true,
        async json() {
          return {
            id: "m1",
            snippet: "Read https://example.com/live-piece thanks",
            internalDate: "1722816000000"
          };
        }
      };
    }
    if (href.includes("https://bank.example/transactions")) {
      return {
        ok: true,
        async json() {
          return {
            transactions: [
              {
                id: "bank-live-1",
                date: "2026-08-05",
                rawMerchant: "LIVE CAFE",
                amount: 9.5,
                account: "checking"
              }
            ]
          };
        }
      };
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  };

  try {
    // CLOUD with mocked provider — mutations from the model must be stripped.
    process.env.HUB_TEST_FORCE = "1";
    const secretStore = require("../hub/secret-store.js");
    const origGet = secretStore.getConnectorSecret;
    secretStore.getConnectorSecret = async (name) => {
      if (name === "ai.cloudKey") return "sk-test";
      if (name === "ai.cloudBaseUrl") return "https://api.openai.com/v1";
      if (name === "ai.cloudModel") return "gpt-4o-mini";
      if (name === "email.clientId") return "cid";
      if (name === "email.clientSecret") return "csecret";
      if (name === "email.refreshToken") return "refresh";
      if (name === "bank.token") return "bank-token";
      if (name === "bank.endpoint") return "https://bank.example/transactions";
      if (name === "groupme.token") return null;
      return origGet(name);
    };

    ai.setAiMode(db, "CLOUD");
    const before = dbApi.listTransactions(db).length;
    const cloud = await ai.propose(db);
    assert.equal(cloud.mode, "CLOUD");
    assert.equal(cloud.proposal.mutations.length, 0);
    assert.ok(cloud.proposal.flags.some((f) => f.id === "flag-cloud"));
    assert.equal(dbApi.listTransactions(db).length, before);

    const email = await connectors.runEmail(db, { forceMock: false });
    assert.equal(email.mode, "live");
    assert.ok(email.emitted.some((item) => item.data.url.includes("live-piece")));

    const bank = await connectors.runBank(db, { forceMock: false });
    assert.equal(bank.mode, "live");
    assert.equal(bank.emitted.length, 1);
    assert.ok(dbApi.listTransactions(db).some((row) => row.id === "bank-live-1"));

    secretStore.getConnectorSecret = origGet;

    const server = createServer(db, { projectRoot, syncRoot });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const health = await request(port, "GET", "/api/health");
    assert.ok(["M6", "M7"].includes(health.body.milestone));
    assert.equal(health.body.pairingPath, "/apps/hub/pairing.html");

    const pair = await request(port, "GET", "/api/sync/pairing");
    assert.equal(pair.status, 200);
    assert.match(pair.body.svg, /<svg/i);
    assert.equal(typeof pair.body.fingerprint, "string");
    assert.equal("payloadText" in pair.body, false);
    assert.equal(JSON.stringify(pair.body).includes('"key"'), false);

    const page = await request(port, "GET", "/apps/hub/pairing.html");
    assert.equal(page.status, 200);
    assert.match(page.text, /Pair phone/);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    global.fetch = originalFetch;
  }

  db.close();
  console.log("Hub M6 extensions (CLOUD AI, QR pairing, live email/bank) passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
