"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

let sodiumReady = null;
let sodium = null;

async function getSodium() {
  if (!sodiumReady) {
    sodiumReady = (async () => {
      const wrappers = require("libsodium-wrappers");
      await wrappers.ready;
      sodium = wrappers;
      return sodium;
    })();
  }
  return sodiumReady;
}

function keyPath(root) {
  return path.join(root, "data", "sync.key");
}

function loadOrCreateKey(root) {
  const file = keyPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  return key;
}

async function encryptJson(root, payload) {
  const s = await getSodium();
  const key = loadOrCreateKey(root);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const message = Buffer.from(JSON.stringify(payload), "utf8");
  const cipher = s.crypto_secretbox_easy(message, nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]);
}

async function decryptJson(root, bytes) {
  const s = await getSodium();
  const key = loadOrCreateKey(root);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const nonce = buf.subarray(0, s.crypto_secretbox_NONCEBYTES);
  const cipher = buf.subarray(s.crypto_secretbox_NONCEBYTES);
  const plain = s.crypto_secretbox_open_easy(cipher, nonce, key);
  if (!plain) throw new Error("Failed to decrypt envelope (bad key or corrupt file)");
  return JSON.parse(Buffer.from(plain).toString("utf8"));
}

function keyFingerprint(root) {
  const key = loadOrCreateKey(root);
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

module.exports = {
  getSodium,
  loadOrCreateKey,
  encryptJson,
  decryptJson,
  keyFingerprint,
  keyPath
};
