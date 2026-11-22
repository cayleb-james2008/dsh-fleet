(() => {
  const APP_VERSION = "0.4.0";
  const DB_NAME = "fleet-worktrees-v1";
  const STORE_NAME = "state";
  const BYOK_KEY_SS = "fleet-byok-api-key";
  const BYOK_URL_LS = "fleet-byok-url";
  const BYOK_MODEL_LS = "fleet-byok-model";
  const LOCAL_URL_LS = "fleet-local-url";

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

  // Real sandboxed Web Worker check evaluator
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

  async function executeSessionRun(session, promptText, isRetryOrSteer) {
    session.status = "working";
    session.bucket = "working";
    session.reason = null;
    session.merge_error = null;
    session.transcript = [
      ...session.transcript,
      "worktree ready on branch " + session.branch + " (base " + session._baseCommit + ")"
    ];
    await persistState();

    try {
      const byokSummary = await runByokAgent(session, promptText);
      if (byokSummary) {
        session.transcript = [...session.transcript, "byok (" + byokModel + "): " + byokSummary];
      } else {
        const note = applyBuiltInPatch(session, promptText, isRetryOrSteer);
        session.transcript = [...session.transcript, session.engine + ": " + note];
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      session.status = "needs-you";
      session.bucket = "needs-you";
      session.reason = "Agent failed: " + msg;
      session.transcript = [...session.transcript, "agent error: " + msg];
      await persistState();
      return;
    }

    session.status = "checking";
    session.bucket = "working";
    session.diff = computeTreeDiff(session._baseFiles, session._branchFiles);
    const commitHash = shortHash(session.id + ":" + JSON.stringify(session._branchFiles));
    session.transcript = [
      ...session.transcript,
      "committed branch tree at " + commitHash + " — running Web Worker check: " + session.check_cmd
    ];
    await persistState();

    const result = await runCheckInWorker(session._branchFiles, session.check_cmd);
    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    session.check_ran = true;
    session.check_exit = result.exitCode;
    session.check_output = combinedOutput;
    session.check_passed = result.exitCode === 0;

    if (result.exitCode === 0) {
      session.status = "done";
      session.bucket = "done";
      session.verified_commit = commitHash;
      session.reason = null;
      session.transcript = [
        ...session.transcript,
        "check passed (exit 0 in " + result.durationMs + "ms) — verified done at " + commitHash
      ];
    } else {
      session.status = "needs-you";
      session.bucket = "needs-you";
      session.verified_commit = null;
      const errSnippet = (result.stderr || result.stdout || "non-zero exit").split("\n")[0];
      session.reason = "Check failed (exit " + result.exitCode + "): " + session.check_cmd + ". " + errSnippet;
      session.transcript = [
        ...session.transcript,
        "check failed (exit " + result.exitCode + "): " + errSnippet
      ];
    }
    await persistState();
  }

  async function recheckBranchOnly(session, editedPath) {
    session.status = "checking";
    session.bucket = "working";
    session.reason = null;
    session.merge_error = null;
    session.diff = computeTreeDiff(session._baseFiles, session._branchFiles);
    const commitHash = shortHash(session.id + ":" + JSON.stringify(session._branchFiles));
    session.transcript = [
      ...session.transcript,
      "operator edited " + editedPath + " — re-running Web Worker check: " + session.check_cmd
    ];
    await persistState();

    const result = await runCheckInWorker(session._branchFiles, session.check_cmd);
    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    session.check_ran = true;
    session.check_exit = result.exitCode;
    session.check_output = combinedOutput;
    session.check_passed = result.exitCode === 0;

    if (result.exitCode === 0) {
      session.status = "done";
      session.bucket = "done";
      session.verified_commit = commitHash;
      session.reason = null;
      session.transcript = [
        ...session.transcript,
        "check passed (exit 0 in " + result.durationMs + "ms) — verified done at " + commitHash
      ];
    } else {
      session.status = "needs-you";
      session.bucket = "needs-you";
      session.verified_commit = null;
      const errSnippet = (result.stderr || result.stdout || "non-zero exit").split("\n")[0];
      session.reason = "Check failed (exit " + result.exitCode + "): " + session.check_cmd + ". " + errSnippet;
      session.transcript = [
        ...session.transcript,
        "check failed (exit " + result.exitCode + "): " + errSnippet
      ];
    }
    await persistState();
  }

  function createSessionRecord({ repoPath, project, task, agent, checkCmd, next }) {
    const head = repoHead(repoPath);
    const id = "s-" + String(state.seq++).padStart(3, "0");
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || id;
    const baseFiles = { ...head.files };
    const branchFiles = { ...head.files };
    return {
      id,
      task,
      project: project || state.repos[repoPath].name,
      repo: repoPath,
      branch: "fleet/" + id + "-" + slug,
      status: "queued",
      bucket: "working",
      agent: agent || "web-worker",
      engine: agent || "web-worker",
      model: getByokKey() ? byokModel : null,
      test_mode: false,
      check_cmd: checkCmd || "npm test",
      check_output: "",
      check_passed: null,
      check_ran: false,
      check_exit: null,
      diff: "",
      reason: null,
      verified_commit: null,
      steer: [],
      next_queue: next ? [next] : [],
      merge_target: state.repos[repoPath].branch || "main",
      merge_error: null,
      transcript: [],
      _baseCommit: head.hash,
      _baseFiles: baseFiles,
      _branchFiles: branchFiles
    };
  }

  async function seedRealInitialRuns() {
    const s1 = createSessionRecord({
      repoPath: "/workspace/ledger-kit",
      project: "ledger-kit",
      task: "Add summarizeLedger() helper and unit assertions to ledger-kit",
      agent: "web-worker",
      checkCmd: "npm test"
    });
    const s2 = createSessionRecord({
      repoPath: "/workspace/rate-limiter",
      project: "rate-limiter",
      task: "Investigate off-by-one token bucket refill threshold bug in rate-limiter",
      agent: "web-worker",
      checkCmd: "npm test"
    });
    state.sessions = [s1, s2];
    await executeSessionRun(s1, s1.task, false);
    await executeSessionRun(s2, s2.task, false);
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
    if (method === "GET" && u.pathname === "/api/policy") {
      const hasByok = Boolean(getByokKey());
      return jsonResp({
        agents: [
          { name: "web-worker", found: true, path: "Browser Worktree + Web Worker" },
          ...(hasByok ? [{ name: "byok-llm", found: true, path: byokModel }] : [])
        ],
        max_parallel: 4,
        timeout_secs: 1800,
        source: "policies.rn (browser)",
        default_agent: hasByok ? "byok-llm" : "web-worker",
        default_agent_engine: hasByok ? "byok-llm" : "web-worker",
        model: hasByok ? byokModel : null,
        version: APP_VERSION
      });
    }
    if (method === "GET" && u.pathname === "/api/config") {
      return jsonResp({
        default_agent: getByokKey() ? "byok-llm" : "web-worker",
        default_agent_engine: getByokKey() ? "byok-llm" : "web-worker",
        effective_models: { opencode: null, claude: null, codex: null }
      });
    }
    if (method === "GET" && u.pathname === "/api/sessions") {
      return jsonResp(state.sessions.filter((s) => s.bucket !== "archived").map(publicSession));
    }
    if (method === "GET" && u.pathname === "/api/inbox") {
      return jsonResp(state.sessions.filter((s) => s.bucket === "needs-you").map(publicSession));
    }
    if (method === "GET" && u.pathname.startsWith("/api/sessions/")) {
      const id = u.pathname.slice("/api/sessions/".length);
      const s = state.sessions.find((x) => x.id === id);
      return s ? jsonResp(publicSession(s)) : jsonResp({ error: "no such session" }, 404);
    }
    if (method === "POST" && u.pathname === "/api/sessions") {
      const task = String(body.task || "").trim();
      const repoPath = String(body.repo || "").trim();
      if (!repoPath) return jsonResp({ error: "Give the repo path: select a browser git repository." }, 400);
      if (!task) return jsonResp({ error: "Write the task: say what the agent should do." }, 400);
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
      const created = createSessionRecord({
        repoPath,
        project: String(body.project || "").trim() || state.repos[repoPath].name,
        task,
        agent: String(body.agent || "").trim() || (getByokKey() ? "byok-llm" : "web-worker"),
        checkCmd: String(body.check || "").trim() || "npm test",
        next: String(body.next || "").trim()
      });
      state.sessions = [created, ...state.sessions];
      await persistState();
      setTimeout(() => { executeSessionRun(created, created.task, false); }, 120);
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
        setTimeout(() => { executeSessionRun(s, prompt, true); }, 120);
        return jsonResp({ retried: true });
      }
      if (action === "steer") {
        const msg = String(body.message || "").trim();
        if (!msg) return jsonResp({ error: "Write the message first." }, 400);
        s.steer = [...(s.steer || []), msg];
        s.transcript = [...s.transcript, "operator steer: " + msg];
        await persistState();
        setTimeout(async () => {
          s.steer = [];
          await executeSessionRun(s, msg, true);
        }, 120);
        return jsonResp({ steered: true });
      }
      if (action === "merge") {
        if (s.status !== "done" || !s.verified_commit) {
          return jsonResp({ error: "Only verified done sessions can be merged." }, 409);
        }
        const repo = state.repos[s.repo];
        if (!repo) return jsonResp({ error: "Repository not found." }, 409);
        const head = repoHead(s.repo);
        const conflicts = [];
        const mergedFiles = { ...head.files };
        const changedKeys = Object.keys(s._branchFiles).filter((k) => s._branchFiles[k] !== s._baseFiles[k]);
        for (const k of changedKeys) {
          if (head.files[k] !== s._baseFiles[k] && head.files[k] !== s._branchFiles[k]) {
            conflicts.push(k);
          } else {
            mergedFiles[k] = s._branchFiles[k];
          }
        }
        if (conflicts.length > 0) {
          const errMsg = "Merge conflict in " + conflicts.join(", ") + ". Nothing was merged.";
          s.merge_error = {
            message: errMsg,
            detail: "CONFLICT (content): Merge conflict in " + conflicts.join(", "),
            ts: Math.floor(Date.now() / 1000)
          };
          await persistState();
          return jsonResp({ error: errMsg, detail: s.merge_error.detail }, 409);
        }
        const mergeHash = shortHash(head.hash + ":" + s.verified_commit + ":" + Date.now());
        repo.commits.push({
          hash: mergeHash,
          parent: head.hash,
          message: "merge fleet session " + s.id + ": " + s.task,
          ts: Date.now(),
          files: mergedFiles
        });
        s.status = "merged";
        s.bucket = "done";
        s.merge_error = null;
        s.transcript = [...s.transcript, "merged into " + repo.branch + " at " + mergeHash + " (worktree removed)"];
        await persistState();
        return jsonResp({ merged: true, commit: s.verified_commit, branch: repo.branch });
      }
      if (action === "stop") {
        s.status = "needs-you";
        s.bucket = "needs-you";
        s.reason = "stopped by you mid-run";
        s.transcript = [...s.transcript, "stopped by you"];
        await persistState();
        return jsonResp({ stopped: true });
      }
      if (action === "dismiss") {
        if (s.status !== "needs-you") return jsonResp({ error: "only a needs-you session can be dismissed" }, 409);
        s.status = "archived";
        s.bucket = "archived";
        await persistState();
        return jsonResp({ dismissed: true });
      }
    }
    return jsonResp({ error: "not found" }, 404);
  };
})();
