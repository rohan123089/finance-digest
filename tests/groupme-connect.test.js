"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const dbApi = require("../hub/db.js");
const { createServer } = require("../hub/server.js");
const groupme = require("../hub/connectors/groupme.js");
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
  const prior = {
    token: await secretStore.getConnectorSecret("groupme.token"),
    groupId: await secretStore.getConnectorSecret("groupme.groupId"),
    groupIds: await secretStore.getConnectorSecret("groupme.groupIds"),
    groupMeta: await secretStore.getConnectorSecret("groupme.groupMeta")
  };

  async function restorePrior() {
    await groupme.disconnect();
    if (prior.token) await secretStore.setConnectorSecret("groupme.token", prior.token);
    if (prior.groupId) {
      await secretStore.setConnectorSecret("groupme.groupId", prior.groupId);
    }
    if (prior.groupIds) {
      await secretStore.setConnectorSecret("groupme.groupIds", prior.groupIds);
    }
    if (prior.groupMeta) {
      await secretStore.setConnectorSecret("groupme.groupMeta", prior.groupMeta);
    }
  }

  const mapped = groupme.messagesToSignals(
    [
      {
        id: "1001",
        text: "Dinner Friday 7pm at Luigi's",
        created_at: 1700000000,
        name: "Sam"
      },
      {
        id: "1002",
        text: "Jayati Agrawal has joined the group",
        created_at: 1700000001,
        name: "GroupMe",
        system: true
      },
      {
        id: "1003",
        text: "This message was deleted",
        created_at: 1700000002,
        name: "GroupMe",
        system: true
      },
      {
        id: "1004",
        text: "Random chatter with no plan",
        created_at: 1700000003,
        name: "Sam"
      }
    ],
    "0"
  );
  assert.ok(mapped.emitted.length >= 1);
  assert.equal(mapped.lastId, "1004");
  assert.ok(
    mapped.emitted.every((row) => !/joined the group|was deleted/i.test(row.data?.title || "")),
    "system join/delete chatter must not become Digest signals"
  );
  assert.ok(
    !mapped.emitted.some((row) => /Random chatter/i.test(row.data?.title || "")),
    "plain chat without event/task language must not become a fallback event"
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-groupme-"));
  const dbPath = path.join(tempRoot, "finance.db");
  const key = Buffer.alloc(32, 5);
  const db = dbApi.openDatabase({ dbPath, encryptionKey: key });
  const syncRoot = path.join(tempRoot, "sync");
  sync.ensureSyncLayout(syncRoot);

  const server = createServer(db, {
    projectRoot: tempRoot,
    syncRoot,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/v3/groups/") && href.includes("/messages")) {
        const match = href.match(/\/groups\/([^/?]+)\//);
        const groupId = match ? decodeURIComponent(match[1]) : "unknown";
        return {
          ok: true,
          json: async () => ({
            response: {
              messages: [
                {
                  id: `55${groupId}`,
                  text:
                    groupId === "55"
                      ? "Office hours Monday 3pm"
                      : "Study group Saturday 2pm in the library",
                  created_at: Math.floor(Date.now() / 1000),
                  name: "Alex"
                }
              ]
            }
          })
        };
      }
      if (/\/v3\/groups(\?|$)/.test(href) || href.endsWith("/v3/groups")) {
        return {
          ok: true,
          json: async () => ({
            response: [
              { id: "44", name: "Roommates", members: [{}, {}] },
              { id: "55", name: "CS 240", members: [{}] }
            ]
          })
        };
      }
      throw new Error(`Unexpected fetch ${href}`);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await groupme.disconnect();

    const status0 = await request(port, "GET", "/api/groupme/status");
    assert.equal(status0.body.connected, false);

    const savedToken = await request(port, "POST", "/api/groupme/client", {
      token: "gm-token-test"
    });
    assert.equal(savedToken.status, 200);

    const groups = await request(port, "GET", "/api/groupme/groups");
    assert.equal(groups.status, 200);
    assert.equal(groups.body.groups.length, 2);
    assert.equal(groups.body.groups[0].id, "44");

    const savedGroup = await request(port, "POST", "/api/groupme/client", {
      groupIds: ["44", "55"],
      groups: [
        { id: "44", name: "Roommates" },
        { id: "55", name: "CS 240" }
      ]
    });
    assert.equal(savedGroup.status, 200);
    assert.deepEqual(savedGroup.body.groupIds, ["44", "55"]);

    const status1 = await request(port, "GET", "/api/groupme/status");
    assert.equal(status1.body.connected, true);
    assert.deepEqual(status1.body.groupIds, ["44", "55"]);
    assert.equal(status1.body.groups[0].name, "Roommates");
    assert.equal(status1.body.groups[1].name, "CS 240");

    // Round-trip: reopen status still has both groups after a second read.
    const statusAgain = await request(port, "GET", "/api/groupme/status");
    assert.deepEqual(statusAgain.body.groupIds, ["44", "55"]);
    assert.equal(statusAgain.body.token, true);

    const pulled = await request(port, "POST", "/api/groupme/test", {});
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.mode, "live");
    assert.ok(pulled.body.emitted >= 2);
    assert.equal(pulled.body.byGroup["44"], 1);
    assert.equal(pulled.body.byGroup["55"], 1);

    const digest = await request(port, "GET", "/api/digest");
    assert.equal(digest.status, 200);
    const titles = [
      ...(digest.body.detail.today || []),
      ...(digest.body.detail.watching || [])
    ].map((row) => row.title || "");
    assert.ok(
      titles.some((title) => /Study group|library/i.test(title)),
      "GroupMe chat should appear in Digest"
    );
    assert.ok(
      titles.some((title) => /Office hours/i.test(title)),
      "Second group chat should appear in Digest"
    );

    const page = await request(port, "GET", "/apps/hub/groupme.html");
    assert.equal(page.status, 200);
    assert.match(page.text, /GroupMe/);
  } finally {
    server.close();
    db.close();
    await restorePrior();
  }

  console.log("GroupMe hub connect checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
