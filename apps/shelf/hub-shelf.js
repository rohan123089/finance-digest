/**
 * Browser-to-hub Shelf adapter.
 *
 * HTML apps call only window.Shelf. This adapter owns the same-origin HTTP
 * relay when an app is served by the laptop hub. It does nothing for file://
 * pages or when the native Android bridge is already present.
 */
(function (root) {
  "use strict";

  if (root.Shelf?.__real || root.location?.protocol === "file:") return;
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
    const payload = await response.json();
    if (!response.ok) {
      throw shelfError("HUB_ERROR", payload.error || "The laptop hub rejected the request");
    }
    return payload;
  }

  root.Shelf = {
    __real: true,
    __hub: true,
    __version: 1,
    data: {
      async get(kind) {
        if (!["transactions", "snapshot", "digest", "accounts"].includes(kind)) {
          throw shelfError("UNKNOWN_KIND", `Unknown data kind: ${kind}`);
        }
        const path =
          kind === "accounts" ? "/api/accounts" : `/api/${encodeURIComponent(kind)}`;
        const payload = await request(path);
        // The hub is the source of truth and may return raw rows. Expose them
        // under the device-contract `transactions` field for a single app path.
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
    import: {
      text(payload) {
        return request("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      }
    },
    // secure.* rejects on purpose, matching the device: tokens live in Connect
    // and are used via Net.call, never handed back to the WebView.
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
    // Browser HTML must not drive connectors. Phone Connect + Net.call stays native.
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
})(typeof globalThis !== "undefined" ? globalThis : this);
