"use strict";

/**
 * Hub-side Net.call — credentials stay in the OS keychain and are never returned
 * to callers or the browser.
 */

const secretStore = require("./secret-store.js");
const syllabus = require("../engine/syllabus.js");

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

function decodeGmailBodyData(data) {
  if (!data) return "";
  try {
    const normalized = String(data).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch (_error) {
    return "";
  }
}

function collectGmailTextParts(payload, out = { body: "", attachments: [] }) {
  if (!payload) return out;
  const mime = String(payload.mimeType || "").toLowerCase();
  const filename = payload.filename || "";
  if (payload.body?.data) {
    const text = decodeGmailBodyData(payload.body.data);
    if (mime === "text/plain" || mime === "text/html") {
      out.body += (out.body ? "\n" : "") + text.replace(/<[^>]+>/g, " ");
    } else if (filename && /\.(txt|md|csv)$/i.test(filename)) {
      out.attachments.push(text);
    }
  }
  (payload.parts || []).forEach((part) => collectGmailTextParts(part, out));
  return out;
}

async function call(service, request = {}) {
  if (service === "groupme") {
    const groupme = require("./connectors/groupme.js");
    const limit = Number(request.limit) || 20;
    return groupme.fetchMessages({
      limit,
      groupId: request.groupId,
      fetchImpl: request.fetchImpl
    });
  }

  if (service === "email") {
    const gmail = require("./connectors/gmail.js");
    const clientId = await secretStore.getConnectorSecret("email.clientId");
    const clientSecret = await secretStore.getConnectorSecret("email.clientSecret");
    const accounts = await gmail.getConnectedRefreshAccounts();
    if (!clientId || !clientSecret || !accounts.length) {
      throw new Error(
        "Email OAuth requires email.clientId, email.clientSecret, and at least one inbox refresh token (email.1–3.refreshToken)"
      );
    }

    const maxResults = Number(request.maxResults) || 25;
    // Broad inbox pull — life.extractFromMessage decides what becomes Digest work.
    // Old query required keyword hits and silently dropped most actionable mail.
    const query =
      request.query ||
      "newer_than:21d in:inbox -category:promotions -category:social -category:forums";
    const slotFilter = request.slot != null ? Number(request.slot) : null;
    const selected =
      slotFilter != null ? accounts.filter((a) => a.slot === slotFilter) : accounts;
    if (!selected.length) {
      throw new Error(`No Gmail refresh token for slot ${slotFilter}`);
    }

    const messages = [];
    const links = [];
    const pulled = [];

    for (const account of selected) {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: account.refreshToken,
          grant_type: "refresh_token"
        })
      });
      if (!tokenRes.ok) {
        throw new Error(
          `Email OAuth token HTTP ${tokenRes.status} (inbox ${account.address || `slot ${account.slot}`})`
        );
      }
      const tokenJson = await tokenRes.json();
      const accessToken = tokenJson.access_token;
      if (!accessToken) {
        throw new Error(
          `Email OAuth did not return an access token (inbox ${account.address || `slot ${account.slot}`})`
        );
      }

      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      listUrl.searchParams.set("maxResults", String(maxResults));
      listUrl.searchParams.set("q", query);

      const listRes = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
      });
      if (!listRes.ok) {
        throw new Error(
          `Gmail list HTTP ${listRes.status} (inbox ${account.address || `slot ${account.slot}`})`
        );
      }
      const listJson = await listRes.json();
      const messageRefs = Array.isArray(listJson.messages) ? listJson.messages : [];
      let count = 0;

      for (const message of messageRefs.slice(0, maxResults)) {
        const detailRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json"
            }
          }
        );
        if (!detailRes.ok) continue;
        const detail = await detailRes.json();
        const headers = Array.isArray(detail.payload?.headers) ? detail.payload.headers : [];
        const subject =
          headers.find((h) => String(h.name).toLowerCase() === "subject")?.value || "";
        const from =
          headers.find((h) => String(h.name).toLowerCase() === "from")?.value || "";
        const snippet = String(detail.snippet || "");
        const receivedAt = detail.internalDate
          ? new Date(Number(detail.internalDate)).toISOString()
          : new Date().toISOString();
        const stableId = `${account.slot}:${message.id}`;

        let body = "";
        let attachmentTexts = [];
        if (syllabus.looksLikeSyllabusEmail(subject, snippet)) {
          try {
            const fullRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json"
                }
              }
            );
            if (fullRes.ok) {
              const full = await fullRes.json();
              const parts = collectGmailTextParts(full.payload);
              body = parts.body || "";
              attachmentTexts = parts.attachments || [];
            }
          } catch (_error) {
            // Fall back to snippet-only.
          }
        }

        messages.push({
          id: stableId,
          gmailId: message.id,
          accountSlot: account.slot,
          mailbox: account.address || null,
          subject,
          snippet,
          body: body || undefined,
          attachmentTexts: attachmentTexts.length ? attachmentTexts : undefined,
          from,
          sharedBy: account.address || "email",
          receivedAt,
          source: "email"
        });
        count += 1;
        const found = `${subject}\n${snippet}\n${body}`.match(URL_RE) || [];
        found.forEach((rawUrl, index) => {
          const cleaned = rawUrl.replace(/[.,;:]+$/, "");
          links.push({
            id: `${stableId}:${index}`,
            url: cleaned,
            title: subject,
            sharedBy: account.address || "email",
            receivedAt,
            accountSlot: account.slot,
            mailbox: account.address || null
          });
        });
      }

      pulled.push({
        slot: account.slot,
        email: account.address,
        messageCount: count
      });
    }

    return { messages, links, accounts: pulled };
  }

  if (service === "bank") {
    const token = await secretStore.getConnectorSecret("bank.token");
    const endpoint =
      request.endpoint || (await secretStore.getConnectorSecret("bank.endpoint"));
    if (!token) throw new Error("Bank token is not configured in the OS keychain");
    if (!endpoint) {
      throw new Error("Bank endpoint is not configured (bank.endpoint in the OS keychain)");
    }

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) throw new Error(`Bank HTTP ${response.status}`);
    const json = await response.json();
    const rows = Array.isArray(json)
      ? json
      : Array.isArray(json.transactions)
        ? json.transactions
        : Array.isArray(json.rows)
          ? json.rows
          : [];
    return { transactions: rows };
  }

  if (service === "ai") {
    const apiKey = await secretStore.getConnectorSecret("ai.cloudKey");
    if (!apiKey) throw new Error("AI cloud key is not configured in the OS keychain");
    const baseUrl = (
      (await secretStore.getConnectorSecret("ai.cloudBaseUrl")) ||
      "https://api.openai.com/v1"
    ).replace(/\/$/, "");
    const model =
      (await secretStore.getConnectorSecret("ai.cloudModel")) || "gpt-4o-mini";
    const redacted = request.redacted;
    if (!redacted || typeof redacted !== "object") {
      throw new Error("AI Net.call requires a redacted snapshot object");
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a personal finance nudge assistant. You receive ONLY a redacted aggregate snapshot. Reply with JSON: {summary:string, flags:[{id,trigger,why,action,value,deadline,confidence}], mutations:[]}. mutations MUST be []. Never invent account numbers or raw transactions."
          },
          {
            role: "user",
            content: JSON.stringify(redacted)
          }
        ]
      })
    });
    if (!response.ok) throw new Error(`AI cloud HTTP ${response.status}`);
    return response.json();
  }

  throw new Error(`Unknown Net.call service: ${service}`);
}

module.exports = { call };
