"use strict";

/**
 * Store connector secrets in the OS keychain.
 * Usage: node hub/connectors/set-secret.js <name> [value]
 * If value is omitted, reads one line from stdin.
 * Never prints the secret back.
 */

const secretStore = require("../secret-store.js");

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error(
      `Usage: node hub/connectors/set-secret.js <name> [value]\nNames: ${Object.keys(secretStore.CONNECTOR_ACCOUNTS).join(", ")}`
    );
    process.exit(1);
  }

  let value = process.argv[3];
  if (value == null) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    value = Buffer.concat(chunks).toString("utf8").trim();
  }

  await secretStore.setConnectorSecret(name, value);
  console.log(JSON.stringify({ ok: true, stored: name, service: secretStore.SERVICE }));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
