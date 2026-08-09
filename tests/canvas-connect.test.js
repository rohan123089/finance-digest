"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const dbApi = require("../hub/db.js");
const { createServer } = require("../hub/server.js");
const canvas = require("../hub/connectors/canvas.js");
const secretStore = require("../hub/secret-store.js");
const sync = require("../hub/sync.js");

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
          resolve({ status: res.statusCode, body: parsed, text });
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
    canvas.normalizeBaseUrl("canvas.wisc.edu"),
    "https://canvas.wisc.edu"
  );

  const signals = canvas.signalsFromPayload({
    todo: [
      {
        assignment: {
          id: 11,
          name: "Essay",
          due_at: "2026-08-10T23:59:00Z",
          html_url: "https://canvas.example/courses/1/assignments/11"
        },
        context_code: "course_1"
      }
    ],
    upcoming: [
      {
        id: "event_9",
        title: "Lab",
        start_at: "2026-08-09T15:00:00Z",
        context_code: "course_1"
      }
    ],
    missing: []
  });
  assert.equal(signals.length, 2);
  assert.equal(signals[0].data.domain, "school");
  assert.equal(signals[1].type, "signal.event");

  const prior = {
    token: await secretStore.getConnectorSecret("canvas.token"),
    baseUrl: await secretStore.getConnectorSecret("canvas.baseUrl")
  };

  async function restorePrior() {
    await canvas.disconnect();
    if (prior.token) await secretStore.setConnectorSecret("canvas.token", prior.token);
    if (prior.baseUrl) {
      await secretStore.setConnectorSecret("canvas.baseUrl", prior.baseUrl);
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-canvas-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 4);
  const db = dbApi.openDatabase({ dbPath, encryptionKey: key });
  const syncRoot = path.join(tempRoot, "sync");
  sync.ensureSyncLayout(syncRoot);

  const server = createServer(db, {
    projectRoot: tempRoot,
    syncRoot,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/users/self/todo")) {
        return {
          ok: true,
          json: async () => [
            {
              assignment: {
                id: 77,
                name: "Problem set",
                due_at: "2026-08-11T23:59:00Z",
                html_url: "https://canvas.example/a/77"
              },
              context_code: "course_9"
            }
          ]
        };
      }
      if (href.includes("/users/self/upcoming_events")) {
        return { ok: true, json: async () => [] };
      }
      if (href.includes("/users/self/missing_submissions")) {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`Unexpected fetch ${href}`);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await canvas.disconnect();

    const status0 = await request(port, "GET", "/api/canvas/status");
    assert.equal(status0.body.connected, false);

    const saved = await request(port, "POST", "/api/canvas/client", {
      baseUrl: "https://canvas.example.edu",
      token: "canvas-token-test"
    });
    assert.equal(saved.status, 200);

    const pulled = await request(port, "POST", "/api/canvas/test", {});
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.mode, "live");
    assert.ok(pulled.body.emitted >= 1);

    const digest = await request(port, "GET", "/api/digest");
    assert.equal(digest.status, 200);
    assert.ok(
      digest.body.detail.today.some(
        (row) => row.kind === "task" && /Problem set/i.test(row.title)
      ),
      "Canvas assignment should appear in Digest today"
    );
  } finally {
    server.close();
    db.close();
    await restorePrior();
  }

  console.log("Canvas hub connect checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
