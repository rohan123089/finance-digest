"use strict";

/**
 * Google Calendar → Digest (read-only).
 * Reuses Gmail OAuth client + refresh tokens; needs calendar.readonly on the grant.
 */

const secretStore = require("../secret-store.js");
const dbApi = require("../db.js");
const life = require("../../engine/life.js");
const gmail = require("./gmail.js");
const scheduleMap = require("../../engine/schedule-map.js");

/** Pull far enough for exam lead windows (exams use leadDays up to 14+). */
const FORWARD_DAYS = 60;

async function getAccessToken(account, options = {}) {
  const clientId = await secretStore.getConnectorSecret("email.clientId");
  const clientSecret = await secretStore.getConnectorSecret("email.clientSecret");
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth client is not configured");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
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
    const text = await tokenRes.text().catch(() => "");
    throw new Error(
      `GCal OAuth token HTTP ${tokenRes.status}${text ? `: ${text.slice(0, 160)}` : ""}`
    );
  }
  const json = await tokenRes.json();
  if (!json.access_token) {
    throw new Error("GCal OAuth did not return an access token");
  }
  return json.access_token;
}

async function calendarFetch(path, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(
    path.startsWith("http") ? path : `https://www.googleapis.com/calendar/v3${path}`
  );
  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      if (value != null) url.searchParams.set(key, String(value));
    });
  }
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const err = new Error(
      `Google Calendar HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`
    );
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function eventStartIso(event) {
  const start = event?.start || {};
  if (start.dateTime) return new Date(start.dateTime).toISOString();
  if (start.date) return `${start.date}T12:00:00.000Z`;
  return null;
}

function eventToSignal(event, meta) {
  const start = eventStartIso(event);
  if (!start) return null;
  const title = String(event.summary || "Calendar event").slice(0, 160);
  const calendarId = meta.calendarId || "primary";
  const id = `gcal:${calendarId}:${event.id}`;
  const from = event.organizer?.email || event.creator?.email || meta.mailbox || "gcal";
  const domain = life.inferDomain(`${title}\n${event.description || ""}`, from);
  const chatMsg = {
    id: `${calendarId}:${event.id}`,
    from,
    groupId: undefined,
    calendarId,
    sourceRef: `gcal:${calendarId}/${event.id}`,
    url: event.htmlLink || null
  };
  const learnedHints = meta.db
    ? dbApi.resolveDigestLearned(meta.db, {
        ...chatMsg,
        data: { calendarId, from }
      })
    : { mute: false, junkReading: false, ruleIds: [] };
  // Protected tier: never drop calendar events for learned mute/drop.
  // Mutes apply to reading/social only (enforced in digest assembly).
  void learnedHints;

  return {
    id,
    type: "signal.event",
    source: "gcal",
    at: start,
    data: {
      title,
      start,
      domain: learnedHints.domain || domain,
      sourceRef: chatMsg.sourceRef,
      dismissible: true,
      calendarId,
      from,
      mailbox: meta.mailbox || null,
      htmlLink: event.htmlLink || null,
      location: event.location || null
    }
  };
}

async function getStatus() {
  const gmailStatus = await gmail.getStatus();
  return {
    connected: gmailStatus.connected,
    accounts: gmailStatus.accounts,
    scope: gmail.CALENDAR_SCOPE,
    note: "Uses the same Google OAuth as Gmail. Re-connect once if Calendar was not in the grant."
  };
}

async function syncToDb(db, options = {}) {
  const forceMock = options.forceMock === true;
  const collectedAt = new Date().toISOString();
  const emitted = [];
  const byAccount = {};

  if (forceMock) {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 2);
    start.setUTCHours(15, 0, 0, 0);
    const signal = eventToSignal(
      {
        id: "mock-evt-1",
        summary: "Office hours — Anatomy lab",
        start: { dateTime: start.toISOString() },
        organizer: { email: "prof@state.edu" },
        htmlLink: "https://calendar.google.com/mock"
      },
      { calendarId: "primary", mailbox: "you@example.com", db }
    );
    if (signal) {
      const row = { ...signal, collectedAt };
      dbApi.upsertSyncItem(db, row);
      scheduleMap.seedFromGcalEvent(dbApi, db, row);
      emitted.push(row);
    }
    byAccount.mock = emitted.length;
    return { source: "gcal", mode: "mock", emitted, byAccount };
  }

  const accounts = await gmail.getConnectedRefreshAccounts();
  if (!accounts.length) {
    throw new Error(
      "Google Calendar needs a connected Gmail OAuth inbox (Setup → Gmail → Connect)"
    );
  }

  const timeMin = new Date().toISOString();
  const timeMax = new Date(
    Date.now() + FORWARD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  for (const account of accounts) {
    let accessToken;
    try {
      accessToken = await getAccessToken(account, options);
    } catch (error) {
      byAccount[account.slot] = { error: error.message, emitted: 0 };
      continue;
    }

    let eventsPayload;
    try {
      eventsPayload = await calendarFetch("/calendars/primary/events", {
        accessToken,
        fetchImpl: options.fetchImpl,
        query: {
          timeMin,
          timeMax,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "50"
        }
      });
    } catch (error) {
      const needsScope =
        error.status === 403 ||
        /insufficient|accessNotConfigured|PERMISSION|scope/i.test(
          error.message || ""
        );
      byAccount[account.slot] = {
        error: needsScope
          ? "Calendar scope missing — reconnect Gmail OAuth to grant calendar.readonly"
          : error.message,
        emitted: 0,
        needsReconnect: needsScope
      };
      continue;
    }

    const events = Array.isArray(eventsPayload.items) ? eventsPayload.items : [];
    let count = 0;
    events.forEach((event) => {
      if (!event || event.status === "cancelled") return;
      const signal = eventToSignal(event, {
        calendarId: "primary",
        mailbox: account.address,
        db
      });
      if (!signal) return;
      const row = { ...signal, collectedAt };
      dbApi.upsertSyncItem(db, row);
      scheduleMap.seedFromGcalEvent(dbApi, db, row);
      emitted.push(row);
      count += 1;
    });
    byAccount[account.slot] = { emitted: count, email: account.address };
    dbApi.setConnectorWatermark(
      db,
      `gcal:${account.slot}`,
      new Date().toISOString()
    );
  }

  return { source: "gcal", mode: "live", emitted, byAccount };
}

module.exports = {
  FORWARD_DAYS,
  getStatus,
  getAccessToken,
  eventToSignal,
  eventStartIso,
  syncToDb
};
