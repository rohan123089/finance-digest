"use strict";

/**
 * Phone doorway helpers: LAN URLs + QR so Shelf opens the hub app (thin WebView).
 */

const os = require("node:os");
const QRCode = require("qrcode");
const cryptoUtil = require("./crypto.js");

function listLanIPv4() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const entries of Object.values(nets || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const family = entry.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (entry.address) out.push(entry.address);
    }
  }
  return [...new Set(out)];
}

function isLanBound(host) {
  const h = String(host || "127.0.0.1").trim().toLowerCase();
  return h === "0.0.0.0" || h === "::" || h === "[::]";
}

async function buildPhoneDoorway(projectRoot, options = {}) {
  const host = options.host || process.env.HUB_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.HUB_PORT || 8787);
  const appPath = options.appPath || "/apps/app.html";
  const lanBound = isLanBound(host);
  const lanIps = listLanIPv4();
  const urls = lanBound
    ? lanIps.map((ip) => `http://${ip}:${port}${appPath}`)
    : [];
  // Prefer a private RFC1918 address when several NICs exist.
  const preferredUrl =
    urls.find((u) => /\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(u)) ||
    urls[0] ||
    null;

  let svg = null;
  if (preferredUrl) {
    svg = await QRCode.toString(preferredUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280
    });
  }

  return {
    host,
    port,
    lanBound,
    appPath,
    lanIps,
    urls,
    preferredUrl,
    localUrl: `http://127.0.0.1:${port}${appPath}`,
    svg,
    fingerprint: cryptoUtil.keyFingerprint(projectRoot),
    hint: lanBound
      ? preferredUrl
        ? "Open the URL (or scan the QR) in Shelf on the same Wi‑Fi."
        : "Hub is LAN-bound but no IPv4 address was found."
      : "Restart the hub with HUB_HOST=0.0.0.0 so your phone can reach it on Wi‑Fi."
  };
}

module.exports = {
  listLanIPv4,
  isLanBound,
  buildPhoneDoorway
};
