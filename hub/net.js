"use strict";

/**
 * Hub-side Net.call — credentials stay in the OS keychain and are never returned
 * to callers or the browser.
 */

const secretStore = require("./secret-store.js");

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

async function call(service, request = {}) {
  if (service === "groupme") {
    const token = await secretStore.getConnectorSecret("groupme.token");
    const groupId =
      request.groupId || (await secretStore.getConnectorSecret("groupme.groupId"));
    if (!token) throw new Error("GroupMe token is not configured in the OS keychain");
    if (!groupId) throw new Error("GroupMe group id is not configured in the OS keychain");

    const limit = Number(request.limit) || 20;
    const url = new URL(
      `https://api.groupme.com/v3/groups/${encodeURIComponent(groupId)}/messages`
    );
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("token", token);

    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`GroupMe HTTP ${response.status}`);
    return response.json();
  }

  if (service === "email") {
    const clientId = await secretStore.getConnectorSecret("email.clientId");
    const clientSecret = await secretStore.getConnectorSecret("email.clientSecret");
    const refreshToken = await secretStore.getConnectorSecret("email.refreshToken");
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Email OAuth requires email.clientId, email.clientSecret, and email.refreshToken in the OS keychain"
      );
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!tokenRes.ok) throw new Error(`Email OAuth token HTTP ${tokenRes.status}`);
    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) throw new Error("Email OAuth did not return an access token");

    const maxResults = Number(request.maxResults) || 15;
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(maxResults));
    // Prefer actionable mail; still catches newsletters with links.
    listUrl.searchParams.set(
      "q",
      request.query ||
        "newer_than:21d (statement OR e-statement OR due OR deadline OR assignment OR meeting OR reminder OR \"action required\" OR rsvp OR has:link)"
    );

    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
    });
    if (!listRes.ok) throw new Error(`Gmail list HTTP ${listRes.status}`);
    const listJson = await listRes.json();
    const messageRefs = Array.isArray(listJson.messages) ? listJson.messages : [];

    const messages = [];
    const links = [];
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
      messages.push({
        id: message.id,
        subject,
        snippet,
        from,
        sharedBy: "email",
        receivedAt,
        source: "email"
      });
      const found = `${subject}\n${snippet}`.match(URL_RE) || [];
      found.forEach((rawUrl, index) => {
        const cleaned = rawUrl.replace(/[.,;:]+$/, "");
        links.push({
          id: `${message.id}:${index}`,
          url: cleaned,
          title: subject,
          sharedBy: "email",
          receivedAt
        });
      });
    }
    return { messages, links };
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
