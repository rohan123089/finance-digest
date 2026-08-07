"use strict";

const assert = require("node:assert/strict");
const phoneDoorway = require("../hub/phone-doorway.js");

async function main() {
  assert.equal(phoneDoorway.isLanBound("0.0.0.0"), true);
  assert.equal(phoneDoorway.isLanBound("127.0.0.1"), false);

  const loopback = await phoneDoorway.buildPhoneDoorway(__dirname + "/..", {
    host: "127.0.0.1",
    port: 8787
  });
  assert.equal(loopback.lanBound, false);
  assert.equal(loopback.preferredUrl, null);
  assert.match(loopback.hint, /HUB_HOST/);

  const lan = await phoneDoorway.buildPhoneDoorway(__dirname + "/..", {
    host: "0.0.0.0",
    port: 8787
  });
  assert.equal(lan.lanBound, true);
  assert.ok(Array.isArray(lan.urls));
  if (lan.preferredUrl) {
    assert.match(lan.preferredUrl, /^http:\/\/.+:8787\/apps\/app\.html$/);
    assert.ok(lan.svg && lan.svg.includes("<svg"));
  }

  console.log("Phone doorway helpers passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
