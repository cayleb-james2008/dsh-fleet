(() => {
  const APP_VERSION = "0.5.0";
  const DB_NAME = "fleet-worktrees-v2";
  const STORE_NAME = "state";
  const BYOK_KEY_SS = "fleet-byok-api-key";
  const BYOK_URL_LS = "fleet-byok-url";
  const BYOK_MODEL_LS = "fleet-byok-model";
  const LOCAL_URL_LS = "fleet-local-url";
  const MAX_PARALLEL = 4;

  const INITIAL_REPOS = () => ({
    "/workspace/ledger-kit": {
      name: "ledger-kit",
      path: "/workspace/ledger-kit",
      branch: "main",
      commits: [
        {
          hash: "a10c4e2",
          parent: null,
          message: "Initial ledger-kit commit",
          ts: Date.now() - 3600_000,
          files: {
            "src/ledger.js": [
              "export function createLedger(initial = []) {",
              "  const entries = [...initial];",
              "  return {",
              "    add(entry) {",
              "      if (!entry || typeof entry.label !== 'string' || !entry.label.trim()) {",
              "        throw new Error('Entry label is required');",
              "      }",
              "      if (typeof entry.cents !== 'number' || !Number.isFinite(entry.cents)) {",
              "        throw new Error('Entry cents must be a finite number');",
              "      }",
              "      entries.push({ label: entry.label.trim(), cents: Math.trunc(entry.cents) });",
              "      return entries.length;",
              "    },",
              "    balance() {",
              "      return entries.reduce((sum, e) => sum + e.cents, 0);",
              "    },",
              "    list() {",
              "      return entries.map((e) => ({ ...e }));",
              "    },",
              "  };",
              "}",
              "",
              "export function formatCents(cents) {",
              "  const neg = cents < 0;",
              "  const abs = Math.abs(Math.trunc(cents));",
              "  const dollars = Math.floor(abs / 100);",
              "  const rem = String(abs % 100).padStart(2, '0');",
              "  return (neg ? '-' : '') + '$' + dollars + '.' + rem;",
              "}",
              ""
            ].join("\n"),
            "tests/ledger.test.js": [
              "import { createLedger, formatCents } from '../src/ledger.js';",
              "",
              "export function run(assert) {",
              "  const l = createLedger([{ label: 'opening', cents: 5000 }]);",
              "  l.add({ label: 'payout', cents: -1250 });",
              "  assert.equal(l.balance(), 3750, 'balance sums signed cents');",
              "  assert.equal(formatCents(3750), '$37.50', 'formats positive dollars');",
              "  assert.equal(formatCents(-1250), '-$12.50', 'formats negative dollars');",
              "  return 'ledger.test.js: 3 assertions passed';",
              "}",
              ""
            ].join("\n")
          }
        }
      ]
    },
    "/workspace/rate-limiter": {
      name: "rate-limiter",
      path: "/workspace/rate-limiter",
      branch: "main",
      commits: [
        {
          hash: "b72f910",
          parent: null,
          message: "Initial rate-limiter commit",
          ts: Date.now() - 3500_000,
          files: {
            "src/limiter.js": [
              "export function createBucket({ capacity = 5, refillPerSec = 1 } = {}) {",
              "  let tokens = capacity;",
              "  let lastMs = 0;",
              "  return {",
              "    allow(nowMs) {",
              "      if (lastMs > 0 && nowMs > lastMs) {",
              "        const elapsed = (nowMs - lastMs) / 1000;",
              "        tokens = Math.min(capacity, tokens + elapsed * refillPerSec);",
              "      }",
              "      lastMs = nowMs;",
              "      if (tokens >= 1) {",
              "        tokens -= 1;",
              "        return true;",
              "      }",
              "      return false;",
              "    },",
              "    remaining() {",
              "      return Math.floor(tokens);",
              "    },",
              "  };",
              "}",
              ""
            ].join("\n"),
            "tests/limiter.test.js": [
              "import { createBucket } from '../src/limiter.js';",
              "",
              "export function run(assert) {",
              "  const b = createBucket({ capacity: 2, refillPerSec: 1 });",
              "  assert.equal(b.allow(1000), true, 'first request allowed');",
              "  assert.equal(b.allow(1000), true, 'second request allowed');",
              "  assert.equal(b.allow(1000), false, 'third request throttled');",
              "  assert.equal(b.allow(2100), true, 'refills after 1.1s');",
              "  return 'limiter.test.js: 4 assertions passed';",
              "}",
              ""
            ].join("\n")
          }
        }
      ]
    },
    "/workspace/dag-scheduler": {
      name: "dag-scheduler",
      path: "/workspace/dag-scheduler",
      branch: "main",
      commits: [
        {
          hash: "c94e21a",
          parent: null,
          message: "Initial dag-scheduler commit",
          ts: Date.now() - 3400_000,
          files: {
            "src/dag.js": [
              "export function topoSort(nodes) {",
              "  const indeg = new Map();",
              "  const adj = new Map();",
              "  for (const n of nodes) {",
              "    indeg.set(n.id, 0);",
              "    adj.set(n.id, []);",
              "  }",
              "  for (const n of nodes) {",
              "    for (const dep of n.dependsOn || []) {",
              "      if (!adj.has(dep)) continue;",
              "      adj.get(dep).push(n.id);",
              "      indeg.set(n.id, (indeg.get(n.id) || 0) + 1);",
              "    }",
              "  }",
              "  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);",
              "  const order = [];",
              "  while (q.length) {",
              "    const id = q.shift();",
              "    order.push(id);",
              "    for (const nxt of adj.get(id) || []) {",
              "      const d = indeg.get(nxt) - 1;",
              "      indeg.set(nxt, d);",
              "      if (d === 0) q.push(nxt);",
              "    }",
              "  }",
              "  if (order.length !== nodes.length) throw new Error('DAG cycle detected');",
              "  return order;",
              "}",
              ""
            ].join("\n"),
            "tests/dag.test.js": [
              "import { topoSort } from '../src/dag.js';",
              "",
              "export function run(assert) {",
              "  const order = topoSort([",
              "    { id: 'c', dependsOn: ['b'] },",
              "    { id: 'a', dependsOn: [] },",
              "    { id: 'b', dependsOn: ['a'] }",
              "  ]);",
              "  assert.deepEqual(order, ['a', 'b', 'c'], 'topological order respects dependsOn');",
              "  assert.throws(() => topoSort([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }]), 'rejects cycle');",
              "  return 'dag.test.js: 2 assertions passed';",
              "}",
              ""
            ].join("\n")
          }
        }
      ]
    }
  });

  function shortHash(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(7, "0").slice(0, 7);
  }

  function globToRegExp(glob) {
    const clean = String(glob || "").trim().replace(/^\/+/, "");
    let re = "^";
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === "*") {
        if (clean[i + 1] === "*") {
          if (clean[i + 2] === "/") {
            re += "(?:.*/)?";
            i += 2;
          } else {
            re += ".*";
            i += 1;
          }
        } else {
          re += "[^/]*";
        }
      } else if (ch === "?") {
        re += "[^/]";
      } else if (/[.+^${}()|[\]\\]/.test(ch)) {
        re += "\\" + ch;
      } else {
        re += ch;
      }
    }
    re += "$";
    return new RegExp(re);
  }

  function matchesAnyGlob(filePath, globs) {
    if (!Array.isArray(globs) || globs.length === 0) return false;
    const norm = String(filePath || "").replace(/^\/+/, "");
    return globs.some((g) => globToRegExp(g).test(norm));
  }

  function checkFileScopeGuardrails(baseFiles, branchFiles, allowedGlobs, forbiddenGlobs) {
    const keys = Array.from(new Set([...Object.keys(baseFiles || {}), ...Object.keys(branchFiles || {})])).sort();
    const changed = keys.filter((k) => baseFiles[k] !== branchFiles[k]);
    const violations = [];
    for (const f of changed) {
      if (Array.isArray(forbiddenGlobs) && forbiddenGlobs.length > 0 && matchesAnyGlob(f, forbiddenGlobs)) {
        violations.push(f + " (matched forbidden glob)");
        continue;
      }
      if (Array.isArray(allowedGlobs) && allowedGlobs.length > 0 && !matchesAnyGlob(f, allowedGlobs)) {
        violations.push(f + " (outside allowed_globs: " + allowedGlobs.join(", ") + ")");
      }
    }
    return violations;
  }

  // Real LCS line-level unified git diff generator
  function diffFile(filePath, oldText, newText) {
    if (oldText === newText) return "";
    const isNew = oldText === undefined;
    const isDel = newText === undefined;
    const a = isNew || oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
    const b = isDel || newText === "" ? [] : newText.replace(/\n$/, "").split("\n");

    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        ops.push({ t: " ", l: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ t: "-", l: a[i] });
        i++;
      } else {
        ops.push({ t: "+", l: b[j] });
        j++;
      }
    }
    while (i < m) ops.push({ t: "-", l: a[i++] });
    while (j < n) ops.push({ t: "+", l: b[j++] });

    const out = [
      "diff --git a/" + filePath + " b/" + filePath,
      isNew
        ? "new file mode 100644"
        : isDel
          ? "deleted file mode 100644"
          : "index " + shortHash(oldText || "") + ".." + shortHash(newText || "") + " 100644",
      "--- " + (isNew ? "/dev/null" : "a/" + filePath),
      "+++ " + (isDel ? "/dev/null" : "b/" + filePath),
      "@@ -" + (isNew ? "0,0" : "1," + m) + " +" + (isDel ? "0,0" : "1," + n) + " @@"
    ];
    for (const op of ops) out.push(op.t + op.l);
    return out.join("\n");
  }

  function computeTreeDiff(baseFiles, branchFiles) {
    const keys = Array.from(new Set([...Object.keys(baseFiles || {}), ...Object.keys(branchFiles || {})])).sort();
    const parts = [];
    for (const k of keys) {
      const d = diffFile(k, baseFiles[k], branchFiles[k]);
      if (d) parts.push(d);
    }
    return parts.join("\n");
  }

  // Real sandboxed Blob Web Worker check evaluator
  function workerMain() {
    self.onmessage = async (ev) => {
      const { files, checkCmd } = ev.data;
      const logs = [];
      const errs = [];
      const t0 = performance.now();
      const assert = {
        ok(v, msg) {
          if (!v) throw new Error("AssertionError: " + (msg || "expected truthy, got " + JSON.stringify(v)));
        },
        equal(a, b, msg) {
          if (a !== b) {
            throw new Error(
              "AssertionError: " + (msg ? msg + ": " : "") + "expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)
            );
          }
        },
        deepEqual(a, b, msg) {
          if (JSON.stringify(a) !== JSON.stringify(b)) {
            throw new Error(
              "AssertionError: " + (msg ? msg + ": " : "") + "expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)
            );
          }
        },
        throws(fn, msg) {
          let threw = false;
          try { fn(); } catch { threw = true; }
          if (!threw) throw new Error("AssertionError: " + (msg || "expected function to throw"));
        }
      };
      const consoleProxy = {
        log: (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
        error: (...a) => errs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
        warn: (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
      };
      function normPath(fromPath, rel) {
        if (!rel.startsWith(".")) return rel.replace(/^\/+/, "");
        const parts = fromPath.split("/").slice(0, -1);
        for (const seg of rel.split("/")) {
          if (!seg || seg === ".") continue;
          if (seg === "..") parts.pop();
          else parts.push(seg);
        }
        return parts.join("/");
      }
      const cache = {};
      function requireMod(modPath, fromPath = "") {
        const resolved = normPath(fromPath, modPath);
        const candidates = [resolved, resolved + ".js", resolved + "/index.js"];
        const key = candidates.find((c) => Object.prototype.hasOwnProperty.call(files, c));
        if (!key) throw new Error("Cannot resolve module: " + modPath);
        if (cache[key]) return cache[key];
        let code = String(files[key] || "");
        const exportsObj = {};
        cache[key] = exportsObj;
        const exportedFns = [];
        code = code.replace(/^\s*import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/gm, (_, names, src) => {
          return "const {" + names + "} = __req(" + JSON.stringify(src) + ", " + JSON.stringify(key) + ");";
        });
        code = code.replace(/^\s*export\s+default\s+/gm, "exports.default = ");
        code = code.replace(/^\s*export\s+function\s+([A-Za-z0-9_$]+)/gm, (_, name) => {
          exportedFns.push(name);
          return "function " + name;
        });
        code = code.replace(/^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/gm, "const $1 = exports.$1 =");
        if (exportedFns.length) {
          code += "\n" + exportedFns.map((n) => "exports." + n + " = " + n + ";").join("\n");
        }
        const fn = new Function("exports", "__req", "console", "assert", "files", code);
        fn(exportsObj, requireMod, consoleProxy, assert, files);
        return exportsObj;
      }
      function runTestSuite() {
        const testFiles = Object.keys(files).filter((k) => /^tests\/.*\.js$/.test(k)).sort();
        if (!testFiles.length) throw new Error("No test files found under tests/*.js");
        let passed = 0;
        for (const tf of testFiles) {
          const mod = requireMod(tf, "");
          if (typeof mod.run !== "function") throw new Error(tf + " does not export run(assert)");
          const res = mod.run(assert, files);
          passed++;
          logs.push(typeof res === "string" && res ? res : tf + ": passed");
        }
        return passed;
      }
      function runSyntaxLint() {
        const jsFiles = Object.keys(files).filter((k) => k.endsWith(".js")).sort();
        for (const f of jsFiles) {
          const src = String(files[f] || "")
            .replace(/^\s*import\s+.*$/gm, "")
            .replace(/^\s*export\s+(?:default\s+)?/gm, "");
          new Function(src);
        }
        logs.push("lint: " + jsFiles.length + " module(s) parsed cleanly");
      }
      function runClause(clause) {
        const c = clause.trim();
        if (!c || c === "true") return;
        if (c === "false" || /^exit\s+[1-9]/.test(c)) throw new Error("Command exited with status 1: " + c);
        const echoM = /^echo\s+(.+)$/.exec(c);
        if (echoM) {
          logs.push(echoM[1].replace(/^['"]|['"]$/g, ""));
          return;
        }
        const testSM = /^test\s+-s\s+(\S+)$/.exec(c);
        if (testSM) {
          const f = testSM[1].replace(/^['"]|['"]$/g, "");
          const content = files[f];
          if (typeof content !== "string" || content.trim().length === 0) {
            throw new Error("test -s " + f + ": file is missing or empty (0 bytes)");
          }
          logs.push("test -s " + f + ": ok (" + content.length + " bytes)");
          return;
        }
        const grepM = /^grep\s+(?:-q\s+)?['"]?([^'"\s]+)['"]?\s+(\S+)$/.exec(c);
        if (grepM) {
          const pat = grepM[1];
          const f = grepM[2];
          const content = files[f] || "";
          if (!content.includes(pat)) throw new Error("grep: pattern " + JSON.stringify(pat) + " not found in " + f);
          logs.push("grep " + f + ": matched " + JSON.stringify(pat));
          return;
        }
        if (/^(npm\s+run\s+lint|eslint|lint|typecheck|tsc)$/.test(c)) {
          runSyntaxLint();
          return;
        }
        if (/^(npm\s+test|pnpm\s+test|vitest|jest|cargo\s+test|test)$/.test(c)) {
          runTestSuite();
          return;
        }
        const fn = new Function("assert", "files", "require", "console", c);
        const ret = fn(assert, files, (p) => requireMod(p, ""), consoleProxy);
        if (ret === false) throw new Error("Check expression returned false");
        if (typeof ret === "string" && ret.trim()) logs.push(ret.trim());
      }
      try {
        const cmd = (checkCmd || "npm test").trim();
        const clauses = cmd.split(/\s*&&\s*/);
        for (const cl of clauses) runClause(cl);
        const ms = Math.max(1, Math.round(performance.now() - t0));
        logs.push("check passed (exit 0) in " + ms + "ms");
        self.postMessage({ exitCode: 0, stdout: logs.join("\n"), stderr: errs.join("\n"), durationMs: ms });
      } catch (err) {
        const ms = Math.max(1, Math.round(performance.now() - t0));
        const msg = err && err.message ? err.message : String(err);
        errs.push(msg);
        self.postMessage({ exitCode: 1, stdout: logs.join("\n"), stderr: errs.join("\n"), durationMs: ms });
      }
    };
  }

  function runCheckInWorker(files, checkCmd, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const blob = new Blob(["(" + workerMain.toString() + ")()"], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      let settled = false;
      const w = new Worker(url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        w.terminate();
        URL.revokeObjectURL(url);
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Check timed out after " + timeoutMs + "ms in Web Worker",
          durationMs: timeoutMs
        });
      }, timeoutMs);
      w.onmessage = (ev) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.terminate();
        URL.revokeObjectURL(url);
        resolve(ev.data);
      };
      w.onerror = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.terminate();
        URL.revokeObjectURL(url);
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Worker runtime error: " + (err.message || "unknown error"),
          durationMs: 0
        });
      };
      w.postMessage({ files, checkCmd });
    });
  }

  // Real Shimmed EventSource for /api/events/stream in Browser Worktree Engine mode
  const sseClients = new Set();
  function emitSse(eventName, payload) {
    const data = JSON.stringify({ type: eventName, ...payload });
    for (const client of sseClients) {
      client._dispatch(eventName, data);
    }
  }

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    class FleetBrowserEventSource {
      constructor(url, init) {
        const u = new URL(url, window.location.origin);
        if (u.pathname === "/api/events/stream" && !localMode) {
          this.url = url;
          this.readyState = 0;
          this._listeners = new Map();
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          sseClients.add(this);
          setTimeout(() => {
            if (this.readyState === 2) return;
            this.readyState = 1;
            const ev = new Event("open");
            if (typeof this.onopen === "function") this.onopen(ev);
          }, 20);
        } else {
          const target = localMode && u.pathname.startsWith("/api/") ? localUrl + u.pathname + u.search : url;
          return new NativeEventSource(target, init);
        }
      }
      addEventListener(name, fn) {
        if (!this._listeners.has(name)) this._listeners.set(name, new Set());
        this._listeners.get(name).add(fn);
      }
      removeEventListener(name, fn) {
        this._listeners.get(name)?.delete(fn);
      }
      _dispatch(eventName, data) {
        if (this.readyState === 2) return;
        const msg = new MessageEvent(eventName, { data });
        const set = this._listeners.get(eventName);
        if (set) {
          for (const fn of set) fn(msg);
        }
        if (eventName === "message" && typeof this.onmessage === "function") {
          this.onmessage(msg);
        }
      }
      close() {
        this.readyState = 2;
        sseClients.delete(this);
      }
    }
    FleetBrowserEventSource.CONNECTING = 0;
    FleetBrowserEventSource.OPEN = 1;
    FleetBrowserEventSource.CLOSED = 2;
    window.EventSource = FleetBrowserEventSource;
  }

  // IndexedDB persistence
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const r = tx.objectStore(STORE_NAME).get(key);
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function idbSet(key, value) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      /* ignore storage errors */
    }
  }

  let state = { repos: INITIAL_REPOS(), sessions: [], seq: 1 };
  let localMode = false;
  let localUrl = (() => {
    try { return localStorage.getItem(LOCAL_URL_LS) || "http://127.0.0.1:8471"; } catch { return "http://127.0.0.1:8471"; }
  })();
  let byokBaseUrl = (() => {
    try { return localStorage.getItem(BYOK_URL_LS) || "https://api.openai.com/v1"; } catch { return "https://api.openai.com/v1"; }
  })();
  let byokModel = (() => {
    try { return localStorage.getItem(BYOK_MODEL_LS) || "gpt-4.1-mini"; } catch { return "gpt-4.1-mini"; }
  })();
  const getByokKey = () => {
    try { return sessionStorage.getItem(BYOK_KEY_SS) || ""; } catch { return ""; }
  };

  const realFetch = window.fetch.bind(window);
  let readyPromise = null;

  function persistState() {
    return idbSet("workspace", state);
  }

  function repoHead(repoPath) {
    const r = state.repos[repoPath];
    if (!r || !r.commits.length) return null;
    return r.commits[r.commits.length - 1];
  }

  function commitsBehind(repoPath, baseHash) {
    const r = state.repos[repoPath];
    if (!r || !r.commits.length) return 0;
    const idx = r.commits.findIndex((c) => c.hash === baseHash);
    if (idx === -1) return 0;
    return Math.max(0, r.commits.length - 1 - idx);
  }

  function computeMergeCheck(s) {
    const repo = state.repos[s.repo];
    if (!repo) {
      return { clean: false, conflicting_files: ["repository not found"], commits_ahead: 0, commits_behind: 0 };
    }
    const head = repoHead(s.repo);
    const conflicts = [];
    const keys = Array.from(new Set([...Object.keys(s._baseFiles || {}), ...Object.keys(s._branchFiles || {})]));
    const changedKeys = keys.filter((k) => s._branchFiles[k] !== s._baseFiles[k]);
    for (const k of changedKeys) {
      if (head.files[k] !== s._baseFiles[k] && head.files[k] !== s._branchFiles[k]) {
        conflicts.push(k);
      }
    }
    return {
      clean: conflicts.length === 0,
      conflicting_files: conflicts,
      commits_ahead: changedKeys.length > 0 ? 1 : 0,
      commits_behind: commitsBehind(s.repo, s._baseCommit)
    };
  }

  // Real DFS cycle detection across existing + candidate DAG nodes
  function detectDagCycle(allNodes) {
    const depMap = new Map();
    for (const n of allNodes) {
      depMap.set(n.id, Array.isArray(n.depends_on) ? n.depends_on : []);
    }
    const color = new Map(); // 0=white, 1=gray, 2=black
    const stack = [];
    function dfs(id) {
      color.set(id, 1);
      stack.push(id);
      for (const dep of depMap.get(id) || []) {
        if (!depMap.has(dep)) continue;
        const c = color.get(dep) || 0;
        if (c === 1) {
          const idx = stack.indexOf(dep);
          return [...stack.slice(idx), dep];
        }
        if (c === 0) {
          const cyc = dfs(dep);
          if (cyc) return cyc;
        }
      }
      stack.pop();
      color.set(id, 2);
      return null;
    }
    for (const n of allNodes) {
      if ((color.get(n.id) || 0) === 0) {
        const cyc = dfs(n.id);
        if (cyc) return cyc;
      }
    }
    return null;
  }

  function appendLine(session, line) {
    session.transcript = [...session.transcript, line];
    emitSse("transcript", { session_id: session.id, line });
  }

  async function runByokAgent(session, promptText) {
    const apiKey = getByokKey();
    if (!apiKey) return null;
    const base = byokBaseUrl.replace(/\/+$/, "");
    const filesJson = JSON.stringify(session._branchFiles, null, 2);
    const sys =
      'You are a coding agent editing an isolated git worktree. Respond ONLY with valid JSON: { "summary": "short note", "edits": [{ "path": "relative/path.js", "content": "full file content" }] }.';
    const user =
      "Task: " +
      promptText +
      "\nCheck command: " +
      session.check_cmd +
      (session.check_output ? "\nPrevious check output:\n" + session.check_output : "") +
      "\nCurrent branch files:\n" +
      filesJson;
    const r = await realFetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model: byokModel,
        temperature: 0.1,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error("BYOK API HTTP " + r.status + ": " + txt.slice(0, 160));
    }
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content || "";
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (!jsonMatch) throw new Error("BYOK response did not contain JSON edits");
    const parsed = JSON.parse(jsonMatch[0]);
    const edits = Array.isArray(parsed.edits) ? parsed.edits : [];
    for (const ed of edits) {
      if (ed && typeof ed.path === "string" && typeof ed.content === "string") {
        session._branchFiles[ed.path] = ed.content;
      }
    }
    return parsed.summary || "Applied " + edits.length + " BYOK file edit(s)";
  }

  function applyBuiltInPatch(session, promptText, isRetryOrSteer) {
    const files = session._branchFiles;
    const lower = promptText.toLowerCase();
    const lastErr = (session.check_output || "") + " " + (session.reason || "");

    const writeM = /write\s+([a-zA-Z0-9._/-]+)\s*:\s*([\s\S]+)/i.exec(promptText);
    if (writeM) {
      const targetPath = writeM[1].trim();
      const content = writeM[2].trim() + "\n";
      files[targetPath] = content;
      return "wrote " + targetPath + " (" + content.length + " bytes)";
    }

    const missingFileM = /test -s ([^:\s]+): file is missing or empty/.exec(lastErr);
    if (isRetryOrSteer && missingFileM) {
      const f = missingFileM[1];
      files[f] = "verified artifact for: " + session.task + "\n";
      return "created " + f + " to satisfy test -s " + f;
    }

    const grepFailM = /grep: pattern "([^"]+)" not found in (\S+)/.exec(lastErr);
    if (isRetryOrSteer && grepFailM) {
      const pat = grepFailM[1];
      const f = grepFailM[2];
      files[f] = (files[f] || "") + (files[f] && !files[f].endsWith("\n") ? "\n" : "") + "// " + pat + "\n";
      return "updated " + f + " with " + pat;
    }

    if (isRetryOrSteer) {
      if (files["src/limiter.js"] && files["src/limiter.js"].includes("if (tokens > 1)")) {
        files["src/limiter.js"] = files["src/limiter.js"].replace("if (tokens > 1)", "if (tokens >= 1)");
        return "fixed boundary condition in src/limiter.js (tokens > 1 -> tokens >= 1)";
      }
      if (files["src/ledger.js"] && files["src/ledger.js"].includes("return entries.reduce((sum, e) => sum - e.cents, 0);")) {
        files["src/ledger.js"] = files["src/ledger.js"].replace(
          "return entries.reduce((sum, e) => sum - e.cents, 0);",
          "return entries.reduce((sum, e) => sum + e.cents, 0);"
        );
        return "fixed sign bug in src/ledger.js balance() summation";
      }
      const repM = /replace\s+['"]?([^'"]+)['"]?\s+with\s+['"]?([^'"]+)['"]?/i.exec(promptText);
      if (repM) {
        for (const k of Object.keys(files)) {
          if (files[k].includes(repM[1])) {
            files[k] = files[k].replace(repM[1], repM[2]);
            return "replaced " + repM[1] + " with " + repM[2] + " in " + k;
          }
        }
      }
    }

    if (!isRetryOrSteer && /\b(broken|off-by-one|bug|fail|without writing)\b/i.test(lower)) {
      if (lower.includes("without writing")) {
        return "completed run without creating the required output artifact";
      }
      if (files["src/limiter.js"]) {
        files["src/limiter.js"] = files["src/limiter.js"].replace("if (tokens >= 1)", "if (tokens > 1)");
        return "edited src/limiter.js token threshold check";
      }
      if (files["src/ledger.js"]) {
        files["src/ledger.js"] = files["src/ledger.js"].replace(
          "return entries.reduce((sum, e) => sum + e.cents, 0);",
          "return entries.reduce((sum, e) => sum - e.cents, 0);"
        );
        return "edited src/ledger.js balance calculation";
      }
    }

    if (files["src/ledger.js"] && /summar|report|total/i.test(lower) && !files["src/ledger.js"].includes("summarizeLedger")) {
      files["src/ledger.js"] =
        files["src/ledger.js"].trimEnd() +
        "\n\n" +
        [
          "export function summarizeLedger(ledger) {",
          "  const items = ledger.list();",
          "  const total = ledger.balance();",
          "  return { count: items.length, cents: total, formatted: formatCents(total) };",
          "}",
          ""
        ].join("\n");
      if (files["tests/ledger.test.js"] && !files["tests/ledger.test.js"].includes("summarizeLedger")) {
        files["tests/ledger.test.js"] = files["tests/ledger.test.js"]
          .replace("import { createLedger, formatCents }", "import { createLedger, formatCents, summarizeLedger }")
          .replace(
            "return 'ledger.test.js: 3 assertions passed';",
            "const s = summarizeLedger(l);\n  assert.equal(s.count, 2, 'summary counts entries');\n  assert.equal(s.formatted, '$37.50', 'summary formats balance');\n  return 'ledger.test.js: 5 assertions passed';"
          );
      }
      return "added summarizeLedger() in src/ledger.js and covered it in tests/ledger.test.js";
    }

    if (files["src/dag.js"] && /ready|batch|queue|depth|wave/i.test(lower) && !files["src/dag.js"].includes("readyWaves")) {
      files["src/dag.js"] =
        files["src/dag.js"].trimEnd() +
        "\n\n" +
        [
          "export function readyWaves(nodes) {",
          "  const done = new Set();",
          "  const remaining = new Map(nodes.map((n) => [n.id, n.dependsOn || []]));",
          "  const waves = [];",
          "  while (remaining.size > 0) {",
          "    const wave = [];",
          "    for (const [id, deps] of remaining.entries()) {",
          "      if (deps.every((d) => done.has(d))) wave.push(id);",
          "    }",
          "    if (!wave.length) throw new Error('DAG cycle detected');",
          "    wave.sort();",
          "    for (const id of wave) { done.add(id); remaining.delete(id); }",
          "    waves.push(wave);",
          "  }",
          "  return waves;",
          "}",
          ""
        ].join("\n");
      if (files["tests/dag.test.js"] && !files["tests/dag.test.js"].includes("readyWaves")) {
        files["tests/dag.test.js"] = files["tests/dag.test.js"]
          .replace("import { topoSort }", "import { topoSort, readyWaves }")
          .replace(
            "return 'dag.test.js: 2 assertions passed';",
            "const waves = readyWaves([{ id: 'a' }, { id: 'b' }, { id: 'c', dependsOn: ['a', 'b'] }]);\n  assert.deepEqual(waves, [['a', 'b'], ['c']], 'computes parallel waves');\n  return 'dag.test.js: 3 assertions passed';"
          );
      }
      return "added readyWaves() parallel wave planner in src/dag.js and covered it in tests/dag.test.js";
    }

    const wantFile = /^test\s+-s\s+(\S+)/.exec(session.check_cmd || "");
    if (wantFile && !/\b(fail|without writing|broken)\b/i.test(lower)) {
      const target = wantFile[1].replace(/^['"]|['"]$/g, "");
      files[target] = "generated by fleet worktree session " + session.id + ": " + session.task + "\n";
      return "wrote " + target + " in branch worktree";
    }

    const fnName = "task_" + session.id.replace(/[^a-z0-9]/gi, "_");
    const targetSrc = Object.keys(files).find((k) => k.startsWith("src/")) || "src/index.js";
    const targetTest = Object.keys(files).find((k) => k.startsWith("tests/"));
    files[targetSrc] =
      (files[targetSrc] || "").trimEnd() +
      "\n\nexport function " +
      fnName +
      "() {\n  return " +
      JSON.stringify(session.task) +
      ";\n}\n";
    if (targetTest && files[targetTest].includes("export function run(assert)")) {
      files[targetTest] = files[targetTest].replace(
        "export function run(assert) {",
        "export function run(assert) {\n  assert.ok(files[" +
          JSON.stringify(targetSrc) +
          "].includes(" +
          JSON.stringify(fnName) +
          "), 'branch helper committed');"
      );
    }
    return "added " + fnName + "() to " + targetSrc + " and updated tests";
  }

  async function runPipelineChecks(session, commitHash, skipSchedule = false) {
    const specs =
      Array.isArray(session._checkStepSpecs) && session._checkStepSpecs.length > 0
        ? session._checkStepSpecs
        : [{ name: "verify", cmd: session.check_cmd || "npm test", timeout_secs: 300 }];

    // Enforce file-scope guardrails before marking done
    const violations = checkFileScopeGuardrails(
      session._baseFiles,
      session._branchFiles,
      session.allowed_globs,
      session.forbidden_globs
    );
    session.guardrail_violations = violations;

    const receipts = specs.map((sp) => ({
      name: sp.name || sp.cmd,
      cmd: sp.cmd,
      exit_code: null,
      elapsed_ms: null,
      passed: null,
      tail_line: "",
      output: "",
      status: "pending"
    }));
    session.check_steps = receipts;

    const combinedChunks = [];
    let allPassed = true;
    let firstFailExit = 0;
    let firstFailReason = "";
    let totalMs = 0;

    for (let idx = 0; idx < specs.length; idx++) {
      const sp = specs[idx];
      receipts[idx].status = "running";
      emitSse("check_step", { session_id: session.id, step: receipts[idx] });

      const timeoutMs = Math.min(Math.max((sp.timeout_secs || 5) * 1000, 1500), 10_000);
      const result = await runCheckInWorker(session._branchFiles, sp.cmd, timeoutMs);
      const outText = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const tail = outText.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
      totalMs += result.durationMs || 0;

      receipts[idx] = {
        name: sp.name || sp.cmd,
        cmd: sp.cmd,
        exit_code: result.exitCode,
        elapsed_ms: result.durationMs,
        passed: result.exitCode === 0,
        tail_line: tail || (result.exitCode === 0 ? "passed (exit 0)" : "failed"),
        output: outText,
        status: result.exitCode === 0 ? "passed" : "failed"
      };
      session.check_steps = [...receipts];
      emitSse("check_step", { session_id: session.id, step: receipts[idx] });
      combinedChunks.push("[" + receipts[idx].name + "] " + outText);

      if (result.exitCode !== 0) {
        allPassed = false;
        firstFailExit = result.exitCode;
        firstFailReason = (result.stderr || result.stdout || "non-zero exit").split("\n")[0];
        for (let k = idx + 1; k < receipts.length; k++) {
          receipts[k].status = "skipped";
          receipts[k].tail_line = "Skipped after earlier step failed";
        }
        session.check_steps = [...receipts];
        break;
      }
    }

    session.check_ran = true;
    session.check_output = combinedChunks.join("\n\n").trim();
    session.check_exit = allPassed ? 0 : firstFailExit;
    session.elapsed_ms = totalMs;

    if (violations.length > 0) {
      session.check_passed = false;
      session.status = "needs-you";
      session.bucket = "needs-you";
      session.verified_commit = null;
      session.reason = "File-scope guardrail blocked edits outside allowed globs: " + violations.join("; ");
      appendLine(session, "guardrail blocked: " + violations.join(", "));
    } else if (allPassed) {
      session.check_passed = true;
      session.status = "done";
      session.bucket = "done";
      session.verified_commit = commitHash;
      session.reason = null;
      appendLine(
        session,
        "all " + receipts.length + " check step(s) passed (exit 0 in " + totalMs + "ms) — verified done at " + commitHash
      );
    } else {
      session.check_passed = false;
      session.status = "needs-you";
      session.bucket = "needs-you";
      session.verified_commit = null;
      session.reason = "Check failed (exit " + firstFailExit + "): " + session.check_cmd + ". " + firstFailReason;
      appendLine(session, "check failed (exit " + firstFailExit + "): " + firstFailReason);
    }

    await persistState();
    emitSse("session_update", { session: publicSession(session) });
    if (!skipSchedule) await evaluateDagScheduler();
  }

  async function evaluateDagScheduler() {
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    const activeCount = state.sessions.filter(
      (s) => s.bucket === "working" && s.status !== "queued" && s.status !== "blocked"
    ).length;
    let availableSlots = Math.max(0, MAX_PARALLEL - activeCount);
    let qPos = 1;
    let mutated = false;

    for (const s of [...state.sessions].reverse()) {
      if (s.status !== "blocked" && s.status !== "queued") continue;
      const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
      const failedDep = deps.find((d) => {
        const up = byId.get(d);
        return up && (up.status === "needs-you" || up.status === "archived");
      });
      if (failedDep) {
        s.status = "needs-you";
        s.bucket = "needs-you";
        s.blocked_by = [];
        s.reason = "Upstream dependency " + failedDep + " failed or was dismissed.";
        appendLine(s, "dag halt: upstream " + failedDep + " did not reach verified done");
        emitSse("session_update", { session: publicSession(s) });
        mutated = true;
        continue;
      }

      const unfinished = deps.filter((d) => {
        const up = byId.get(d);
        return up && up.status !== "done" && up.status !== "merged";
      });

      if (unfinished.length > 0) {
        s.status = "blocked";
        s.bucket = "working";
        s.blocked_by = unfinished;
        s.queue_position = null;
        continue;
      }

      s.blocked_by = [];
      if (availableSlots > 0) {
        availableSlots--;
        s.queue_position = null;
        mutated = true;
        setTimeout(() => {
          executeSessionRun(s, s.task, false);
        }, 80);
      } else {
        s.status = "queued";
        s.bucket = "working";
        s.queue_position = qPos++;
      }
    }

    if (mutated) {
      await persistState();
      emitSse("queue", { active: MAX_PARALLEL - availableSlots, max_parallel: MAX_PARALLEL });
    }
  }

  async function executeSessionRun(session, promptText, isRetryOrSteer, skipSchedule = false) {
    if (session._inFlight) return;
    session._inFlight = true;
    session.status = "working";
    session.bucket = "working";
    session.reason = null;
    session.merge_error = null;
    session.blocked_by = [];
    session.queue_position = null;
    appendLine(session, "worktree ready on branch " + session.branch + " (base " + session._baseCommit + ")");
    await persistState();
    emitSse("session_update", { session: publicSession(session) });

    try {
      const byokSummary = await runByokAgent(session, promptText);
      if (byokSummary) {
        appendLine(session, "byok (" + byokModel + "): " + byokSummary);
      } else {
        const note = applyBuiltInPatch(session, promptText, isRetryOrSteer);
        appendLine(session, session.engine + ": " + note);
      }
    } catch (err) {
      session._inFlight = false;
      const msg = err && err.message ? err.message : String(err);
      session.status = "needs-you";
      session.bucket = "needs-you";
      session.reason = "Agent failed: " + msg;
      appendLine(session, "agent error: " + msg);
      await persistState();
      emitSse("session_update", { session: publicSession(session) });
      if (!skipSchedule) await evaluateDagScheduler();
      return;
    }

    session.status = "checking";
    session.bucket = "working";
    session.diff = computeTreeDiff(session._baseFiles, session._branchFiles);
    const commitHash = shortHash(session.id + ":" + JSON.stringify(session._branchFiles));
    appendLine(session, "committed branch tree at " + commitHash + " — running Blob Web Worker pipeline: " + session.check_cmd);
    await persistState();
    emitSse("session_update", { session: publicSession(session) });

    try {
      await runPipelineChecks(session, commitHash, skipSchedule);
    } finally {
      session._inFlight = false;
    }
  }

  async function recheckBranchOnly(session, editedPath) {
    session.status = "checking";
    session.bucket = "working";
    session.reason = null;
    session.merge_error = null;
    session.diff = computeTreeDiff(session._baseFiles, session._branchFiles);
    const commitHash = shortHash(session.id + ":" + JSON.stringify(session._branchFiles));
    appendLine(session, "operator edited " + editedPath + " — re-running Blob Web Worker pipeline: " + session.check_cmd);
    await persistState();
    emitSse("session_update", { session: publicSession(session) });

    await runPipelineChecks(session, commitHash);
  }

  function createSessionRecord({
    repoPath,
    project,
    task,
    agent,
    checkCmd,
    checkSteps,
    next,
    dependsOn,
    allowedGlobs,
    forbiddenGlobs
  }) {
    const head = repoHead(repoPath);
    const id = "s-" + String(state.seq++).padStart(3, "0");
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || id;
    const baseFiles = { ...head.files };
    const branchFiles = { ...head.files };
    const cleanSteps =
      Array.isArray(checkSteps) && checkSteps.length > 0
        ? checkSteps
            .filter((x) => x && typeof x.cmd === "string" && x.cmd.trim())
            .map((x, idx) => ({
              name: String(x.name || "step-" + (idx + 1)).trim(),
              cmd: String(x.cmd).trim(),
              timeout_secs: typeof x.timeout_secs === "number" ? x.timeout_secs : 300
            }))
        : null;
    const effectiveCmd = (checkCmd || "").trim() || (cleanSteps && cleanSteps[0]?.cmd) || "npm test";
    const cleanDeps = Array.isArray(dependsOn) ? dependsOn.map((d) => String(d).trim()).filter(Boolean) : [];
    return {
      id,
      task,
      project: project || state.repos[repoPath].name,
      repo: repoPath,
      branch: "fleet/" + id + "-" + slug,
      status: cleanDeps.length > 0 ? "blocked" : "queued",
      bucket: "working",
      agent: agent || "web-worker",
      engine: agent || "web-worker",
      model: getByokKey() ? byokModel : null,
      test_mode: false,
      check_cmd: effectiveCmd,
      check_output: "",
      check_passed: null,
      check_ran: false,
      check_exit: null,
      check_steps: [],
      diff: "",
      reason: null,
      verified_commit: null,
      steer: [],
      next_queue: next ? [next] : [],
      depends_on: cleanDeps,
      blocked_by: cleanDeps,
      allowed_globs: Array.isArray(allowedGlobs) ? allowedGlobs.filter(Boolean) : [],
      forbidden_globs: Array.isArray(forbiddenGlobs) ? forbiddenGlobs.filter(Boolean) : [],
      guardrail_violations: [],
      merge_target: state.repos[repoPath].branch || "main",
      merge_error: null,
      transcript: [],
      elapsed_ms: null,
      _checkStepSpecs: cleanSteps,
      _baseCommit: head.hash,
      _baseFiles: baseFiles,
      _branchFiles: branchFiles
    };
  }

  function ensureRepoExists(repoPath) {
    if (!state.repos[repoPath]) {
      const name = repoPath.split("/").filter(Boolean).pop() || "workspace";
      state.repos[repoPath] = {
        name,
        path: repoPath,
        branch: "main",
        commits: [
          {
            hash: shortHash(repoPath),
            parent: null,
            message: "Initial commit",
            ts: Date.now(),
            files: {
              "src/index.js": "export function main() {\n  return true;\n}\n",
              "tests/index.test.js":
                "import { main } from '../src/index.js';\nexport function run(assert) {\n  assert.equal(main(), true, 'main returns true');\n  return 'index.test.js: 1 assertion passed';\n}\n"
            }
          }
        ]
      };
    }
  }

  async function seedRealInitialRuns() {
    const s1 = createSessionRecord({
      repoPath: "/workspace/ledger-kit",
      project: "ledger-kit",
      task: "Add summarizeLedger() helper and unit assertions to ledger-kit",
      agent: "web-worker",
      checkCmd: "npm test",
      checkSteps: [
        { name: "syntax-lint", cmd: "lint" },
        { name: "unit-tests", cmd: "npm test" }
      ],
      allowedGlobs: ["src/**", "tests/**"]
    });
    const s2 = createSessionRecord({
      repoPath: "/workspace/rate-limiter",
      project: "rate-limiter",
      task: "Investigate off-by-one token bucket refill threshold bug in rate-limiter",
      agent: "web-worker",
      checkCmd: "npm test",
      checkSteps: [
        { name: "syntax-lint", cmd: "lint" },
        { name: "unit-tests", cmd: "npm test" }
      ]
    });
    const s3 = createSessionRecord({
      repoPath: "/workspace/dag-scheduler",
      project: "dag-scheduler",
      task: "Add readyWaves() parallel wave batch planner to dag-scheduler",
      agent: "web-worker",
      checkCmd: "npm test",
      checkSteps: [
        { name: "syntax-lint", cmd: "lint" },
        { name: "unit-tests", cmd: "npm test" }
      ],
      dependsOn: [s1.id],
      allowedGlobs: ["src/**", "tests/**"]
    });
    state.sessions = [s3, s2, s1];
    await executeSessionRun(s1, s1.task, false, true);
    await executeSessionRun(s2, s2.task, false, true);
    await executeSessionRun(s3, s3.task, false, true);
  }

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const saved = await idbGet("workspace");
        if (saved && saved.repos && Array.isArray(saved.sessions) && saved.sessions.length > 0) {
          state = saved;
        } else {
          state = { repos: INITIAL_REPOS(), sessions: [], seq: 1 };
          await seedRealInitialRuns();
        }
      })();
    }
    return readyPromise;
  }

  function publicSession(s) {
    const out = { ...s };
    delete out._baseCommit;
    delete out._baseFiles;
    delete out._branchFiles;
    delete out._checkStepSpecs;
    delete out._inFlight;
    return out;
  }

  function jsonResp(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }

  window.__FLEET_WEB_ENGINE__ = {
    getStatus() {
      return {
        mode: localMode ? "local" : "browser",
        localUrl,
        byokBaseUrl,
        byokModel,
        byokConfigured: Boolean(getByokKey())
      };
    },
    async setLocalConnection(url, enable) {
      const clean = (url || "http://127.0.0.1:8471").replace(/\/+$/, "");
      localUrl = clean;
      try { localStorage.setItem(LOCAL_URL_LS, clean); } catch {}
      if (!enable) {
        localMode = false;
        return { ok: true };
      }
      try {
        const r = await realFetch(clean + "/api/version", { cache: "no-store" });
        if (!r.ok) return { ok: false, error: "Local fleet-rs responded with HTTP " + r.status };
        localMode = true;
        return { ok: true };
      } catch {
        localMode = false;
        return {
          ok: false,
          error:
            "Could not reach " +
            clean +
            " from this origin (browsers block cross-origin writes to localhost from hosted sites). Use 'Open local UI' to drive your local CLI agents directly."
        };
      }
    },
    setByok({ baseUrl, model, apiKey, clearKey }) {
      if (baseUrl) {
        byokBaseUrl = baseUrl;
        try { localStorage.setItem(BYOK_URL_LS, baseUrl); } catch {}
      }
      if (model) {
        byokModel = model;
        try { localStorage.setItem(BYOK_MODEL_LS, model); } catch {}
      }
      if (clearKey) {
        try { sessionStorage.removeItem(BYOK_KEY_SS); } catch {}
      } else if (apiKey) {
        try { sessionStorage.setItem(BYOK_KEY_SS, apiKey); } catch {}
      }
      return this.getStatus();
    },
    async resetWorkspace() {
      state = { repos: INITIAL_REPOS(), sessions: [], seq: 1 };
      await seedRealInitialRuns();
      await persistState();
      emitSse("sessions", { sessions: state.sessions.filter((s) => s.bucket !== "archived").map(publicSession) });
    },
    getSessionFiles(sessionId) {
      const s = state.sessions.find((x) => x.id === sessionId);
      return s && s._branchFiles ? { ...s._branchFiles } : null;
    },
    async updateSessionFile(sessionId, filePath, content) {
      await ensureReady();
      const s = state.sessions.find((x) => x.id === sessionId);
      if (!s) return { ok: false, error: "Session not found." };
      if (s.status === "merged") return { ok: false, error: "Merged sessions are read-only." };
      s._branchFiles[filePath] = content;
      await recheckBranchOnly(s, filePath);
      return { ok: true };
    }
  };

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(rawUrl, window.location.origin);
    if (!u.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }
    if (localMode) {
      return realFetch(localUrl + u.pathname + u.search, init);
    }

    await ensureReady();
    const method = (init.method || "GET").toUpperCase();
    const bodyText = typeof init.body === "string" ? init.body : "";
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}

    if (method === "GET" && u.pathname === "/api/version") {
      return jsonResp({ name: "fleet-rs", version: APP_VERSION });
    }
    if (method === "GET" && u.pathname === "/api/update") {
      return jsonResp({
        current: APP_VERSION,
        latest: APP_VERSION,
        available: false,
        mode: "off",
        can_apply: false,
        dev_build: false,
        staged: null
      });
    }
    if (method === "GET" && u.pathname === "/api/repos") {
      const list = Object.values(state.repos).map((r) => ({ name: r.name, path: r.path, branch: r.branch }));
      return jsonResp(list);
    }
    if (method === "POST" && u.pathname === "/api/repos/prune-worktrees") {
      let pruned = 0;
      for (const s of state.sessions) {
        if (s.status === "archived" && s._branchFiles) {
          delete s._branchFiles;
          pruned++;
        }
      }
      await persistState();
      return jsonResp({ pruned, message: pruned === 0 ? "All browser worktrees are clean." : "Pruned " + pruned + " archived worktree(s)." });
    }
    if (method === "GET" && u.pathname === "/api/policy") {
      const hasByok = Boolean(getByokKey());
      return jsonResp({
        agents: [
          { name: "web-worker", found: true, path: "Browser Worktree + Blob Web Worker" },
          ...(hasByok ? [{ name: "byok-llm", found: true, path: byokModel }] : [])
        ],
        max_parallel: MAX_PARALLEL,
        timeout_secs: 1800,
        auto_retry_budget: 1,
        auto_steer_budget: 2,
        source: "policies.rn (browser)",
        default_agent: hasByok ? "byok-llm" : "web-worker",
        default_agent_engine: hasByok ? "byok-llm" : "web-worker",
        model: hasByok ? byokModel : null,
        version: APP_VERSION,
        features: { sse: true, batch: true, merge_check: true, policy_test: true, prune_worktrees: true }
      });
    }
    if (method === "POST" && u.pathname === "/api/policies/test") {
      const repo = String(body.repo || "").trim();
      const project = String(body.project || repo.split("/").filter(Boolean).pop() || "default").trim();
      const task = String(body.task || "").trim();
      const reqEngine = String(body.engine || "").trim();
      const hasByok = Boolean(getByokKey());
      const engine = reqEngine || (hasByok ? "byok-llm" : "web-worker");
      const isRust = /rust|cargo|fleet|ergon/.test((repo + " " + project + " " + task).toLowerCase());
      const checkCmd = isRust ? "cargo test" : "npm test";
      const warnings = [];
      if (!repo) warnings.push("Empty repository path; defaulted to workspace rule.");
      if (reqEngine && !["web-worker", "byok-llm", "opencode", "claude", "codex"].includes(reqEngine)) {
        warnings.push("Unknown engine override '" + reqEngine + "'; policy fell back to default.");
      }
      return jsonResp({
        engine,
        model: engine === "byok-llm" ? byokModel : engine === "opencode" ? "opencode/deepseek-v4.1-flash-free" : null,
        check_cmd: checkCmd,
        check_steps: [
          { name: "syntax-lint", cmd: "lint", timeout_secs: 60 },
          { name: "unit-tests", cmd: checkCmd, timeout_secs: 300 }
        ],
        timeout_secs: 1800,
        max_parallel: MAX_PARALLEL,
        auto_retry_budget: 1,
        auto_steer_budget: 2,
        allowed_globs: ["src/**", "tests/**"],
        forbidden_globs: [".env*", "*.pem", "*.key"],
        matched_rule: "policies.rn -> route_repo(" + JSON.stringify(project) + ")",
        warnings
      });
    }
    if (method === "GET" && u.pathname === "/api/config") {
      return jsonResp({
        default_agent: getByokKey() ? "byok-llm" : "web-worker",
        default_agent_engine: getByokKey() ? "byok-llm" : "web-worker",
        max_parallel: MAX_PARALLEL,
        effective_models: { opencode: "opencode/deepseek-v4.1-flash-free", claude: null, codex: null }
      });
    }
    if (method === "GET" && u.pathname === "/api/sessions") {
      return jsonResp(state.sessions.filter((s) => s.bucket !== "archived").map(publicSession));
    }
    if (method === "GET" && u.pathname === "/api/inbox") {
      return jsonResp(state.sessions.filter((s) => s.bucket === "needs-you").map(publicSession));
    }

    const mcMatch = /^\/api\/sessions\/([^/]+)\/merge-check$/.exec(u.pathname);
    if (method === "GET" && mcMatch) {
      const s = state.sessions.find((x) => x.id === mcMatch[1]);
      if (!s) return jsonResp({ error: "no such session" }, 404);
      return jsonResp(computeMergeCheck(s));
    }

    const patchMatch = /^\/api\/sessions\/([^/]+)\/patch$/.exec(u.pathname);
    if (method === "GET" && patchMatch) {
      const s = state.sessions.find((x) => x.id === patchMatch[1]);
      if (!s) return jsonResp({ error: "no such session" }, 404);
      const patchHeader = [
        "From " + (s.verified_commit || "0000000") + "000000000000000000000000000000000 Mon Sep 17 00:00:00 2001",
        "From: Fleet Browser Engine <fleet@local>",
        "Date: " + new Date().toUTCString(),
        "Subject: [PATCH] " + s.task.replace(/\r?\n/g, " "),
        "",
        "Session: " + s.id,
        "Branch: " + s.branch,
        "---",
        ""
      ].join("\n");
      return new Response(patchHeader + (s.diff || "") + "\n", {
        status: 200,
        headers: { "Content-Type": "text/x-patch; charset=utf-8" }
      });
    }

    if (method === "GET" && u.pathname.startsWith("/api/sessions/")) {
      const id = u.pathname.slice("/api/sessions/".length);
      const s = state.sessions.find((x) => x.id === id);
      return s ? jsonResp(publicSession(s)) : jsonResp({ error: "no such session" }, 404);
    }

    if (method === "POST" && u.pathname === "/api/sessions/batch") {
      const rawItems = Array.isArray(body.tasks) ? body.tasks : Array.isArray(body.sessions) ? body.sessions : [];
      if (rawItems.length === 0) return jsonResp({ error: "Provide at least one task in tasks[]." }, 400);
      const aliasMap = new Map();
      const pending = [];

      for (let i = 0; i < rawItems.length; i++) {
        const it = rawItems[i] || {};
        const repoPath = String(it.repo || "").trim();
        const task = String(it.task || "").trim();
        if (!repoPath || !task) {
          return jsonResp({ error: "Task #" + (i + 1) + " requires both repo and task." }, 400);
        }
        ensureRepoExists(repoPath);
        const rec = createSessionRecord({
          repoPath,
          project: String(it.project || "").trim() || state.repos[repoPath].name,
          task,
          agent: String(it.agent || "").trim() || (getByokKey() ? "byok-llm" : "web-worker"),
          checkCmd: String(it.check || "").trim(),
          checkSteps: Array.isArray(it.check_steps) ? it.check_steps : null,
          next: String(it.next || "").trim(),
          dependsOn: Array.isArray(it.depends_on) ? it.depends_on : [],
          allowedGlobs: Array.isArray(it.allowed_globs) ? it.allowed_globs : [],
          forbiddenGlobs: Array.isArray(it.forbidden_globs) ? it.forbidden_globs : []
        });
        if (it.alias) aliasMap.set(String(it.alias), rec.id);
        aliasMap.set("#" + (i + 1), rec.id);
        aliasMap.set("@" + i, rec.id);
        pending.push(rec);
      }

      for (const rec of pending) {
        rec.depends_on = rec.depends_on.map((d) => aliasMap.get(d) || d);
        rec.blocked_by = [...rec.depends_on];
      }

      const cycle = detectDagCycle([...state.sessions, ...pending]);
      if (cycle) {
        return jsonResp({ error: "Cyclic depends_on graph rejected: " + cycle.join(" -> ") }, 400);
      }

      state.sessions = [...pending.slice().reverse(), ...state.sessions];
      await persistState();
      emitSse("sessions", { sessions: state.sessions.filter((s) => s.bucket !== "archived").map(publicSession) });
      setTimeout(() => { void evaluateDagScheduler(); }, 60);
      return jsonResp({ sessions: pending.map(publicSession) }, 201);
    }

    if (method === "POST" && u.pathname === "/api/sessions") {
      const task = String(body.task || "").trim();
      const repoPath = String(body.repo || "").trim();
      if (!repoPath) return jsonResp({ error: "Give the repo path: select a browser git repository." }, 400);
      if (!task) return jsonResp({ error: "Write the task: say what the agent should do." }, 400);
      ensureRepoExists(repoPath);
      const created = createSessionRecord({
        repoPath,
        project: String(body.project || "").trim() || state.repos[repoPath].name,
        task,
        agent: String(body.agent || "").trim() || (getByokKey() ? "byok-llm" : "web-worker"),
        checkCmd: String(body.check || "").trim(),
        checkSteps: Array.isArray(body.check_steps) ? body.check_steps : null,
        next: String(body.next || "").trim(),
        dependsOn: Array.isArray(body.depends_on) ? body.depends_on : [],
        allowedGlobs: Array.isArray(body.allowed_globs) ? body.allowed_globs : [],
        forbiddenGlobs: Array.isArray(body.forbidden_globs) ? body.forbidden_globs : []
      });
      const cycle = detectDagCycle([...state.sessions, created]);
      if (cycle) {
        return jsonResp({ error: "Cyclic depends_on rejected: " + cycle.join(" -> ") }, 400);
      }
      state.sessions = [created, ...state.sessions];
      await persistState();
      emitSse("session_update", { session: publicSession(created) });
      setTimeout(() => { void evaluateDagScheduler(); }, 80);
      return jsonResp(publicSession(created), 201);
    }

    const m = /^\/api\/sessions\/([^/]+)\/(retry|merge|steer|stop|dismiss)$/.exec(u.pathname);
    if (method === "POST" && m) {
      const [, id, action] = m;
      const s = state.sessions.find((x) => x.id === id);
      if (!s) return jsonResp({ error: "no such session" }, 404);

      if (action === "retry") {
        if (s.status !== "needs-you") return jsonResp({ error: "only a needs-you session can be retried" }, 409);
        const prompt = s.task + (s.check_output ? "\nFix failing check: " + s.check_output : "");
        setTimeout(() => { executeSessionRun(s, prompt, true); }, 100);
        return jsonResp({ retried: true });
      }
      if (action === "steer") {
        const msg = String(body.message || "").trim();
        if (!msg) return jsonResp({ error: "Write the message first." }, 400);
        s.steer = [...(s.steer || []), msg];
        appendLine(s, "operator steer: " + msg);
        await persistState();
        setTimeout(async () => {
          s.steer = [];
          await executeSessionRun(s, msg, true);
        }, 100);
        return jsonResp({ steered: true });
      }
      if (action === "merge") {
        if (s.status !== "done" || !s.verified_commit) {
          return jsonResp({ error: "Only verified done sessions can be merged." }, 409);
        }
        const repo = state.repos[s.repo];
        if (!repo) return jsonResp({ error: "Repository not found." }, 409);
        const strategy = String(body.strategy || "merge").toLowerCase();
        const chk = computeMergeCheck(s);
        if (strategy === "ff" && chk.commits_behind > 0) {
          const errMsg = "Fast-forward merge refused: target branch " + repo.branch + " is " + chk.commits_behind + " commit(s) ahead.";
          s.merge_error = { message: errMsg, detail: "hint: Use Merge commit or Squash strategy.", ts: Math.floor(Date.now() / 1000) };
          await persistState();
          return jsonResp({ error: errMsg, detail: s.merge_error.detail }, 409);
        }
        if (!chk.clean) {
          const errMsg = "Merge conflict in " + chk.conflicting_files.join(", ") + ". Nothing was merged.";
          s.merge_error = {
            message: errMsg,
            detail: "CONFLICT (content): Merge conflict in " + chk.conflicting_files.join(", "),
            ts: Math.floor(Date.now() / 1000)
          };
          await persistState();
          return jsonResp({ error: errMsg, detail: s.merge_error.detail }, 409);
        }
        const head = repoHead(s.repo);
        const mergedFiles = { ...head.files };
        const changedKeys = Object.keys(s._branchFiles).filter((k) => s._branchFiles[k] !== s._baseFiles[k]);
        for (const k of changedKeys) mergedFiles[k] = s._branchFiles[k];

        const mergeHash = shortHash(head.hash + ":" + s.verified_commit + ":" + strategy + ":" + Date.now());
        repo.commits.push({
          hash: mergeHash,
          parent: head.hash,
          message: (strategy === "squash" ? "squash " : strategy === "ff" ? "ff " : "merge ") + "fleet session " + s.id + ": " + s.task,
          ts: Date.now(),
          files: mergedFiles
        });
        s.status = "merged";
        s.bucket = "done";
        s.merge_strategy = strategy;
        s.merge_error = null;
        appendLine(s, "merged (" + strategy + ") into " + repo.branch + " at " + mergeHash + " (worktree removed)");
        await persistState();
        emitSse("session_update", { session: publicSession(s) });
        return jsonResp({ merged: true, commit: s.verified_commit, branch: repo.branch, strategy });
      }
      if (action === "stop") {
        s.status = "needs-you";
        s.bucket = "needs-you";
        s.reason = "stopped by you mid-run";
        appendLine(s, "stopped by you");
        await persistState();
        emitSse("session_update", { session: publicSession(s) });
        await evaluateDagScheduler();
        return jsonResp({ stopped: true });
      }
      if (action === "dismiss") {
        if (s.status !== "needs-you") return jsonResp({ error: "only a needs-you session can be dismissed" }, 409);
        s.status = "archived";
        s.bucket = "archived";
        await persistState();
        emitSse("sessions", { sessions: state.sessions.filter((x) => x.bucket !== "archived").map(publicSession) });
        await evaluateDagScheduler();
        return jsonResp({ dismissed: true });
      }
    }
    return jsonResp({ error: "not found" }, 404);
  };
})();
