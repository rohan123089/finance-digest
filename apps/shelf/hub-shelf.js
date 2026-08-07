/**
 * Browser-to-hub Shelf adapter.
 *
 * HTML apps call only window.Shelf. This adapter owns the same-origin HTTP
 * relay when an app is served by the laptop hub. It does nothing for file://
 * pages or when the native Android bridge is already present.
 */
(function (root) {
  "use strict";

  // Native Android Shelf wins. file:// stays on offline mock.
  if (root.Shelf?.__real && !root.Shelf?.__mock) return;
  if (root.location?.protocol === "file:") return;
  if (!/^https?:$/.test(root.location?.protocol || "")) return;

  function shelfError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.shelf = true;
    return error;
  }

  async function request(path, options) {
    let response;
    try {
      response = await fetch(path, options);
    } catch (_error) {
      throw shelfError("HUB_UNAVAILABLE", "The laptop hub is unavailable");
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
    root.Shelf = {
    __real: true,
    __hub: true,
    __version: 1,
    data: {
      async get(kind) {
        if (!["transactions", "snapshot", "digest", "accounts", "bills", "rewards"].includes(kind)) {
          throw shelfError("UNKNOWN_KIND", `Unknown data kind: ${kind}`);
        }
        const path =
          kind === "accounts"
            ? "/api/accounts"
            : kind === "bills"
              ? "/api/bills"
              : kind === "rewards"
                ? "/api/rewards"
                : `/api/${encodeURIComponent(kind)}`;
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
    secure: {
      get() {
        return Promise.reject(shelfError("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call"));
      },
      set() {
        return Promise.reject(shelfError("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call"));
      },
      delete() {
        return Promise.reject(shelfError("SECURE_DISABLED", "Shelf.secure is disabled; configure tokens in Connect and use Net.call"));
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
    try {
      root.dispatchEvent(new Event("shelf-hub-ready"));
    } catch (_error) {
      // ignore
    }
  }

  // Prefer hub immediately on http(s). Only fall back to waiting when a mock
  // already claimed Shelf (legacy load order / file preview upgrades).
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
