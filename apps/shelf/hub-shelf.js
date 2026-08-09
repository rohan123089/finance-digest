/**
 * Browser-to-hub Shelf adapter.
 *
 * HTML apps call only window.Shelf. When the page is served by the laptop hub
 * over http(s), this adapter owns Money/Digest data via same-origin /api/*.
 * Native Android Shelf is only the WebView doorway — hub relay wins for data.
 * file:// stays on the offline mock (no hub).
 */
(function (root) {
  "use strict";

  if (root.location?.protocol === "file:") return;
  if (!/^https?:$/.test(root.location?.protocol || "")) return;

  function shelfError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.shelf = true;
    return error;
  }

  async function request(path, options = {}) {
    let response;
    const ctrl =
      !options.signal && typeof AbortController !== "undefined"
        ? new AbortController()
        : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    try {
      response = await fetch(path, ctrl ? { ...options, signal: ctrl.signal } : options);
    } catch (_error) {
      throw shelfError("HUB_UNAVAILABLE", "The laptop hub is unavailable or too slow");
    } finally {
      if (timer) clearTimeout(timer);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      throw shelfError(
        "HUB_ERROR",
        response.ok
          ? "The laptop hub returned a non-JSON response"
          : `The laptop hub rejected the request (HTTP ${response.status})`
      );
    }
    if (!response.ok) {
      throw shelfError("HUB_ERROR", payload.error || "The laptop hub rejected the request");
    }
    return payload;
  }

  function installHubRelay() {
    const prior = root.Shelf;
    const keepNative =
      prior && prior.__real && !prior.__mock && !prior.__hub ? prior : null;

    root.Shelf = {
      __real: true,
      __hub: true,
      __doorway: Boolean(keepNative),
      __version: 1,
      data: {
        async get(kind, opts = {}) {
          if (!["transactions", "snapshot", "digest", "accounts", "bills", "rewards"].includes(kind)) {
            throw shelfError("UNKNOWN_KIND", `Unknown data kind: ${kind}`);
          }
          const qs = new URLSearchParams();
          if (opts.since) qs.set("since", opts.since);
          if (opts.txCursor) qs.set("txCursor", opts.txCursor);
          if (opts.settingsStamp) qs.set("settingsStamp", opts.settingsStamp);
          if (opts.engineVersion) qs.set("engineVersion", opts.engineVersion);
          if (opts.asOfDate) qs.set("asOfDate", opts.asOfDate);
          if (opts.syncCursor) qs.set("syncCursor", opts.syncCursor);
          if (opts.billsCursor) qs.set("billsCursor", opts.billsCursor);
          const base =
            kind === "accounts"
              ? "/api/accounts"
              : kind === "bills"
                ? "/api/bills"
                : kind === "rewards"
                  ? "/api/rewards"
                  : `/api/${encodeURIComponent(kind)}`;
          const path = qs.toString() ? `${base}?${qs}` : base;
          const payload = await request(path);
          if (kind === "transactions" && payload && payload.rows && !payload.transactions) {
            payload.transactions = payload.rows;
          }
          return payload;
        }
      },
      accounts: {
        list() {
          return request("/api/accounts").then((payload) => payload.accounts || []);
        },
        create(account) {
          return request("/api/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(account)
          });
        },
        update(id, patch) {
          return request(`/api/accounts/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch)
          });
        }
      },
      bills: {
        list() {
          return request("/api/bills");
        },
        create(bill) {
          return request("/api/bills", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bill)
          });
        },
        update(id, patch) {
          return request(`/api/bills/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch)
          });
        },
        remove(id) {
          return request(`/api/bills/${encodeURIComponent(id)}`, {
            method: "DELETE"
          });
        },
        fromSuggestion(suggestion) {
          return request("/api/bills/from-suggestion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(suggestion)
          });
        }
      },
      learned: {
        list(scope) {
          const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
          return request(`/api/learned${qs}`);
        },
        upsert(rule) {
          return request("/api/learned", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rule)
          });
        },
        deactivate(id) {
          return request(`/api/learned/${encodeURIComponent(id)}`, {
            method: "DELETE"
          });
        }
      },
      import: {
        text(payload) {
          return request("/api/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        },
        list() {
          return request("/api/imports");
        },
        undo(id) {
          return request(`/api/imports/${encodeURIComponent(id)}`, {
            method: "DELETE"
          });
        }
      },
      rewards: {
        get() {
          return request("/api/rewards");
        },
        optimize() {
          return request("/api/rewards/optimize");
        },
        refresh(forceMock) {
          return request("/api/rewards/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ forceMock: Boolean(forceMock) })
          });
        },
        saveOffer(offer) {
          return request("/api/rewards/offers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(offer)
          });
        },
        saveRule(rule) {
          return request("/api/rewards/rules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rule)
          });
        }
      },
      money: {
        recategorize(force) {
          return request("/api/transactions/recategorize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: Boolean(force) })
          });
        }
      },
      secure: {
        get() {
          return Promise.reject(
            shelfError("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call")
          );
        },
        set() {
          return Promise.reject(
            shelfError("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call")
          );
        },
        delete() {
          return Promise.reject(
            shelfError("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call")
          );
        }
      },
      Net: {
        call() {
          return Promise.reject(
            shelfError("NET_NATIVE_ONLY", "Net.call is not available in the hub HTML relay")
          );
        }
      },
      ai: {
        mode() {
          return request("/api/ai/mode");
        },
        setMode(mode) {
          return request("/api/ai/mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode })
          });
        },
        propose() {
          return request("/api/ai/propose", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
        },
        proposals() {
          return request("/api/ai/proposals");
        }
      },
      outbox: {
        push(items) {
          const list = Array.isArray(items) ? items : [items];
          return request("/api/outbox", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: list })
          });
        }
      }
    };

    if (keepNative) {
      for (const key of [
        "contacts",
        "sms",
        "camera",
        "ocr",
        "fs",
        "notify",
        "onShare",
        "onAppUrl"
      ]) {
        if (keepNative[key] != null) root.Shelf[key] = keepNative[key];
      }
    }

    try {
      root.dispatchEvent(new Event("shelf-hub-ready"));
    } catch (_error) {
      // ignore
    }
  }

  // Prefer hub immediately on http(s). If a mock already claimed Shelf, probe
  // health then upgrade. Native __real no longer blocks hub data relay.
  if (root.Shelf?.__mock || root.Shelf?.__standalone) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 1200) : null;
    fetch("/api/health", ctrl ? { signal: ctrl.signal } : undefined)
      .then((response) => {
        if (timer) clearTimeout(timer);
        if (response.ok) installHubRelay();
      })
      .catch(() => {
        if (timer) clearTimeout(timer);
        // Stay offline — no hub required.
      });
    return;
  }

  installHubRelay();
})(typeof globalThis !== "undefined" ? globalThis : this);
