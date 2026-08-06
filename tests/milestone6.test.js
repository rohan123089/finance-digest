"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dbApi = require("../hub/db.js");
const ai = require("../hub/ai.js");

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fd-m6-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const samplePath = path.join(__dirname, "../sample-data/transactions.json");
  const db = dbApi.openDatabase({ seedSample: true, dbPath,
    passphrase: "ai-test",
    samplePath
  });

  assert.equal(ai.getAiMode(db), "OFF");
  const off = await ai.propose(db);
  assert.equal(off.mode, "OFF");
  assert.equal(off.proposal, null);

  ai.setAiMode(db, "LOCAL");
  const local = await ai.propose(db);
  assert.equal(local.mode, "LOCAL");
  assert.equal(local.mutatesRecords, false);
  assert.ok(local.input);
  assert.equal("transactions" in local.input, false);
  assert.ok(Array.isArray(local.proposal.flags));
  assert.equal(local.proposal.mutations.length, 0);

  const proposals = dbApi.listAiProposals(db);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].accepted, false);

  ai.setAiMode(db, "CLOUD");
  const cloud = await ai.propose(db);
  assert.equal(cloud.mode, "CLOUD");
  assert.equal(cloud.mutatesRecords, false);

  db.close();
  console.log("Milestone 6 gated AI checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
