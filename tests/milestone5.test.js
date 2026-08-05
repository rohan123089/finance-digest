"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const digestHtml = fs.readFileSync(
  path.join(__dirname, "../apps/digest/digest.html"),
  "utf8"
);

assert.match(digestHtml, /Daily Digest/);
assert.match(digestHtml, /id="today"/);
assert.match(digestHtml, /id="reading"/);
assert.match(digestHtml, /id="junk"/);
assert.match(digestHtml, /\/api\/digest/);
assert.match(digestHtml, /\/api\/connectors\/run/);
assert.doesNotMatch(digestHtml, /cdn\./i);

console.log("Milestone 5 digest app checks passed.");
