// MAIN-world script. Runs in the page's JS context, overrides
// console + fetch + XHR + error handlers and ships events out via
// postMessage. The ISOLATED-world bridge.js picks them up and
// forwards to the service worker.
//
// No `chrome.debugger` → no yellow CDP banner.

(() => {
  const FLAG = "__ISTORIA_BROWSER_LOGS_INJECTED__";
  if (window[FLAG]) return;
  window[FLAG] = true;

  function srcBase() {
    return `chrome:${location.host || location.hostname || "tab"}`;
  }
  const srcConsole = () => srcBase();
  const srcNet = () => `${srcBase()}:net`;

  function post(source, event) {
    try {
      window.postMessage({ __istoria: true, source, event }, location.origin);
    } catch {}
  }

  function stringify(v) {
    if (v == null) return String(v);
    const t = typeof v;
    if (t === "string") return v;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "function") return `[Function ${v.name || "anonymous"}]`;
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
    try {
      return JSON.stringify(v);
    } catch {
      try {
        return String(v);
      } catch {
        return "[unserializable]";
      }
    }
  }

  const consoleMethods = ["log", "info", "warn", "error", "debug"];
  for (const m of consoleMethods) {
    const orig = console[m]?.bind(console);
    if (!orig) continue;
    console[m] = function (...args) {
      try {
        post(srcConsole(), {
          ts: Date.now(),
          level: m === "warn" ? "warn" : m === "error" ? "error" : m === "debug" ? "debug" : "info",
          text: args.map(stringify).join(" "),
        });
      } catch {}
      return orig.apply(console, args);
    };
  }

  window.addEventListener("error", (e) => {
    post(srcConsole(), {
      ts: Date.now(),
      level: "error",
      text: e.error?.stack || e.message || "Uncaught error",
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    post(srcConsole(), {
      ts: Date.now(),
      level: "error",
      text: `Unhandled promise rejection: ${stringify(e.reason)}`,
    });
  });

  const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");

  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      const method = (init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
      post(srcNet(), {
        ts: Date.now(),
        level: "info",
        text: `→ ${method} ${truncate(url, 200)}`,
      });
      return origFetch(input, init).then(
        (res) => {
          const lvl = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
          post(srcNet(), {
            ts: Date.now(),
            level: lvl,
            text: `← ${res.status} ${res.statusText || ""} ${truncate(url, 180)}`.trim(),
          });
          return res;
        },
        (err) => {
          post(srcNet(), {
            ts: Date.now(),
            level: "error",
            text: `× ${truncate(url, 180)} ${err?.message || err}`,
          });
          throw err;
        },
      );
    };
  }

  const XHR = window.XMLHttpRequest?.prototype;
  if (XHR) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) {
      this.__istoria_meta = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return origOpen.apply(this, arguments);
    };
    XHR.send = function () {
      const meta = this.__istoria_meta || { method: "GET", url: "" };
      post(srcNet(), {
        ts: Date.now(),
        level: "info",
        text: `→ ${meta.method} ${truncate(meta.url, 200)}`,
      });
      this.addEventListener("loadend", () => {
        if (this.readyState !== 4) return;
        const status = this.status || 0;
        const lvl = status >= 500 ? "error" : status >= 400 ? "warn" : status === 0 ? "error" : "info";
        const text = status === 0
          ? `× ${truncate(meta.url, 180)}`
          : `← ${status} ${this.statusText || ""} ${truncate(meta.url, 180)}`.trim();
        post(srcNet(), { ts: Date.now(), level: lvl, text });
      });
      return origSend.apply(this, arguments);
    };
  }
})();
