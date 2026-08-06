"use strict";

/**
 * Out-of-band sync key exchange: hub shows a QR the phone scans.
 * Pairing payload includes the libsodium secretbox key (localhost UI only).
 */

const QRCode = require("qrcode");
const cryptoUtil = require("./crypto.js");

async function buildPairing(projectRoot, options = {}) {
  const key = cryptoUtil.loadOrCreateKey(projectRoot);
  const fingerprint = cryptoUtil.keyFingerprint(projectRoot);
  const payload = {
    v: 1,
    type: "shelf-sync-key",
    key: key.toString("base64"),
    fingerprint,
    hub: options.hubUrl || `http://127.0.0.1:${process.env.HUB_PORT || 8787}`,
    generatedAt: new Date().toISOString()
  };
  const text = JSON.stringify(payload);
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 280
  });
  return {
    fingerprint,
    hub: payload.hub,
    generatedAt: payload.generatedAt,
    // svg for the pairing page; payloadText is what the phone decodes from the QR
    svg,
    payloadText: text
  };
}

module.exports = { buildPairing };
