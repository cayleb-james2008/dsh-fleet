/**
 * Workspace git worktree & status prober for Fleet sidecar.
 * Validates workspace roots strictly (no shell, no traversal, canonical dir checks)
 * and debounces git commands with a short TTL cache so rapid UI polling stays fast.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_ROOTS = 16;
const MAX_WORKTREES_PER_ROOT = 24;
const MAX_CHANGED_FILES = 24;
const MAX_BRANCH_FILES = 200;
const MAX_RECENT_COMMITS = 5;
const GIT_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 3000;
const PROBE_CACHE_CAP = 32;
const VALID_ACTIONS = new Set(['dry_run_merge', 'ff_merge', 'rebase', 'remove_worktree']);
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,128}$/;

function stripTrailingSlashes(p) {
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

function isSymlinkPath(p) {
  try {
    return lstatSync(stripTrailingSlashes(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

function execGit(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return resolve({
            ok: false,
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: stdout || '',
            stderr: stderr || '',
            error: err.message,
          });
        }
        resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

function execGitBounded(cwd, args, maxBytes = 24 * 1024, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    let stderr = '';
    const finish = (ok, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks, Math.min(total, maxBytes)).toString('utf8');
      resolve({ ok, code, stdout, stderr, truncated });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(false, 1);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const remaining = maxBytes - total;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish(false, 1));
    child.on('close', (code) => {
      finish(code === 0 || truncated, typeof code === 'number' ? code : 1);
    });
  });
}

/** Validate and canonicalize a `file://` URI or absolute path into `{ uri, path }`. */
export function normalizeWorkspaceRoot(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096 || /[\0\\]/.test(trimmed)) return null;

  let fsPath = trimmed;
  if (trimmed.startsWith('file://')) {
    if (/%2e/i.test(trimmed)) return null;
    try {
      fsPath = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  } else if (trimmed.includes('%')) {
    return null;
  }

  if (!isAbsolute(fsPath)) return null;
  if (fsPath.split('/').some((seg) => seg === '.' || seg === '..')) return null;

  try {
    const noTrail = stripTrailingSlashes(fsPath);
    if (lstatSync(noTrail).isSymbolicLink()) return null;
    const real = realpathSync(noTrail);
    if (!statSync(real).isDirectory()) return null;
    return { path: real, uri: pathToFileURL(real).href };
  } catch {
    return null;
  }
}

/** Parse query `?roots=` (comma-separated or JSON array) into deduplicated valid roots. */
export function parseRootsInput(raw) {
  if (!raw) return { roots: [], rejected: [] };
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [s];
      }
    } else {
      items = s.split(',').map((x) => x.trim()).filter(Boolean);
    }
  }

  const seen = new Set();
  const roots = [];
  const rejected = [];
  for (const item of items.slice(0, MAX_ROOTS)) {
    const norm = normalizeWorkspaceRoot(item);
    if (!norm) {
      rejected.push(String(item).slice(0, 120));
      continue;
    }
    if (seen.has(norm.path)) continue;
    seen.add(norm.path);
    roots.push(norm);
  }
  return { roots, rejected };
}

/** Parse `git worktree list --porcelain` stdout into structured records. */
export function parsePorcelainWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = {
        path: line.slice('worktree '.length).trim(),
        head: '',
        branch: '',
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function safeWorktreeFileUri(wtReal, relPath) {
  if (!relPath || relPath.includes('\0') || isAbsolute(relPath)) return '';
  if (relPath.split('/').some((seg) => seg === '..' || seg === '.')) return '';
  const abs = resolve(wtReal, relPath);
  const prefix = wtReal.endsWith(sep) ? wtReal : `${wtReal}${sep}`;
  if (!abs.startsWith(prefix)) return '';
  try {
    const real = realpathSync(abs);
    if (!real.startsWith(prefix)) return '';
    return statSync(real).isFile() ? pathToFileURL(real).href : '';
  } catch {
    return '';
  }
}

async function detectBaseBranch(rootPath) {
  for (const name of ['main', 'master']) {
    const res = await execGit(rootPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (res.ok && res.stdout.trim()) return name;
  }
  const headRef = await execGit(rootPath, ['symbolic-ref', '--short', 'HEAD']);
  const candidate = headRef.ok ? headRef.stdout.trim() : '';
  if (candidate && isSafeBranchName(candidate)) {
    const verify = await execGit(rootPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (verify.ok && verify.stdout.trim()) return candidate;
  }
  return '';
}

function parseMergeTreeOutput(res) {
  const parts = String(res.stdout || '').split('\0').filter(Boolean);
  const treeSha = parts[0] || '';
  if (res.ok && /^[0-9a-f]{40,64}$/i.test(treeSha)) {
    return { ok: true, clean: true, treeSha, conflictFiles: [] };
  }
  if (res.code === 1 && /^[0-9a-f]{40,64}$/i.test(treeSha)) {
    return { ok: true, clean: false, treeSha, conflictFiles: [...new Set(parts.slice(1))] };
  }
  return {
    ok: false,
    clean: false,
    treeSha: '',
    conflictFiles: [],
    error: (res.stderr || res.error || 'merge-tree failed').trim(),
  };
}

async function inspectWorktree(rootPath, wt, index, baseBranch = '') {
  let wtReal = wt.path;
  let exists = true;
  let totalBranchFiles = 0;
  try {
    if (isSymlinkPath(wt.path) || isSymlinkPath(join(wt.path, '.git'))) {
      exists = false;
    } else {
      wtReal = realpathSync(wt.path);
      exists = statSync(wtReal).isDirectory();
    }
  } catch {
    exists = false;
  }

  let dirtyFiles = 0;
  let untrackedFiles = 0;
  let stagedFiles = 0;
  const files = [];
  const workingPathSet = new Set();
  const branchFiles = [];
  const commits = [];
  let totalChanged = 0;
  let lastCommitSha = wt.head ? wt.head.slice(0, 8) : '';
  let lastCommitSubject = '';
  let lastCommitAt = 0;
  let ahead = 0;
  let behind = 0;
  const branch = wt.branch || (wt.detached ? 'detached' : 'unknown');
  const isMain = index === 0 || wtReal === rootPath;
  const checkBranchRel = Boolean(exists && !wt.bare && !isMain && baseBranch && (wt.detached || branch !== baseBranch));

  if (exists && !wt.bare) {
    const [statusRes, logRes, divRes, branchFilesRes, commitsRes] = await Promise.all([
      execGit(wtReal, ['status', '--porcelain=v1', '-z']),
      execGit(wtReal, ['log', '-n', '1', '--format=%h%x09%s%x09%ct']),
      checkBranchRel ? execGit(wtReal, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`]) : Promise.resolve({ ok: false, stdout: '' }),
      checkBranchRel ? execGit(wtReal, ['diff', '--name-only', '-z', `${baseBranch}...HEAD`]) : Promise.resolve({ ok: false, stdout: '' }),
      checkBranchRel ? execGit(wtReal, ['log', '-n', String(MAX_RECENT_COMMITS), '--format=%h%x09%s%x09%aI', `${baseBranch}..HEAD`]) : Promise.resolve({ ok: false, stdout: '' }),
    ]);
    if (statusRes.ok && statusRes.stdout) {
      const tokens = statusRes.stdout.split('\0');
      for (let i = 0; i < tokens.length; ) {
        const rec = tokens[i++];
        if (!rec || rec.length < 4) continue;
        const x = rec[0];
        const y = rec[1];
        const relPath = rec.slice(3);
        if (x === 'R' || x === 'C') i++;
        if (x === '?' && y === '?') untrackedFiles++;
        else {
          if (x !== ' ') stagedFiles++;
          if (y !== ' ') dirtyFiles++;
        }
        totalChanged++;
        workingPathSet.add(relPath);
        if (files.length < MAX_CHANGED_FILES) {
          const state = x === '?' && y === '?' ? '??' : x !== ' ' ? x : y;
          const uri = state === 'D' ? '' : safeWorktreeFileUri(wtReal, relPath);
          files.push({ path: relPath, state, uri });
        }
      }
    }
    if (logRes.ok && logRes.stdout.trim()) {
      const [sha = '', subject = '', ts = '0'] = logRes.stdout.trim().split('\t');
      lastCommitSha = sha || lastCommitSha;
      lastCommitSubject = subject.slice(0, 120);
      lastCommitAt = Number(ts) ? Number(ts) * 1000 : 0;
    }
    if (divRes.ok && divRes.stdout.trim()) {
      const parts = divRes.stdout.trim().split(/\s+/);
      behind = Number(parts[0]) || 0;
      ahead = Number(parts[1]) || 0;
    }
    if (branchFilesRes.ok && branchFilesRes.stdout) {
      for (const p of branchFilesRes.stdout.split('\0')) {
        if (!p) continue;
        totalBranchFiles++;
        if (branchFiles.length < MAX_BRANCH_FILES) branchFiles.push(p);
      }
    }
    if (commitsRes.ok && commitsRes.stdout.trim()) {
      for (const line of commitsRes.stdout.trim().split('\n')) {
        if (!line) continue;
        const [sha = '', subject = '', authorTime = ''] = line.split('\t');
        if (sha) {
          commits.push({
            sha: sha.trim(),
            subject: subject.slice(0, 120),
            authorTime: authorTime.trim(),
          });
        }
      }
    }
  }

  const clean = dirtyFiles === 0 && untrackedFiles === 0 && stagedFiles === 0;
  let mergeability = 'clean';
  let conflictFiles = [];

  if (isMain || (baseBranch && branch === baseBranch)) {
    mergeability = 'main';
  } else if (wt.detached) {
    mergeability = 'detached';
  } else if (!clean) {
    mergeability = 'dirty';
  } else if (!baseBranch) {
    mergeability = 'unknown';
  } else if (exists && !wt.bare && baseBranch && ahead > 0) {
    const mtRaw = await execGit(wtReal, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseBranch, 'HEAD']);
    const mt = parseMergeTreeOutput(mtRaw);
    if (mt.ok && !mt.clean) {
      mergeability = 'conflict';
      conflictFiles = mt.conflictFiles;
    }
  }

  const landStatus = isMain || (baseBranch && branch === baseBranch)
    ? 'main'
    : !clean
      ? 'dirty'
      : behind > 0
        ? 'rebase'
        : ahead > 0
          ? 'ready'
          : 'merged';

  return {
    record: {
      id: `${rootPath}::${wtReal}`,
      root: rootPath,
      name: basename(wtReal) || wtReal,
      path: wtReal,
      uri: exists ? pathToFileURL(wtReal).href : '',
      isMain,
      exists,
      bare: wt.bare,
      detached: wt.detached,
      locked: wt.locked,
      prunable: wt.prunable,
      branch,
      head: wt.head.slice(0, 8),
      clean,
      baseBranch: baseBranch || '',
      ahead,
      behind,
      landStatus,
      mergeability,
      conflictFiles,
      dirtyFiles,
      untrackedFiles,
      stagedFiles,
      files,
      filesTruncated: totalChanged > MAX_CHANGED_FILES,
      branchFiles,
      branchFilesTruncated: totalBranchFiles > MAX_BRANCH_FILES,
      commits,
      lastCommitSha,
      lastCommitSubject,
      lastCommitAt,
    },
    workingPathSet,
  };
}

function buildRootCollisions(worktrees, workingPathsByWt) {
  const byFile = new Map();
  for (const wt of worktrees) {
    if (wt.isMain || (wt.baseBranch && wt.branch === wt.baseBranch)) continue;
    const workingSet = workingPathsByWt.get(wt.path) || new Set();
    const branchSet = new Set(wt.branchFiles || []);
    const touched = new Set([...workingSet, ...branchSet]);
    for (const file of touched) {
      let entries = byFile.get(file);
      if (!entries) {
        entries = [];
        byFile.set(file, entries);
      }
      entries.push({
        path: wt.path,
        branch: wt.branch,
        hasWorking: workingSet.has(file),
        hasBranch: branchSet.has(file),
      });
    }
  }
  const collisions = [];
  for (const [file, entries] of byFile.entries()) {
    if (entries.length < 2) continue;
    let anyWorking = false;
    let anyBranch = false;
    for (const e of entries) {
      if (e.hasWorking) anyWorking = true;
      if (e.hasBranch) anyBranch = true;
    }
    const kind = anyWorking && anyBranch ? 'mixed' : anyBranch ? 'branch' : 'working';
    collisions.push({
      file,
      worktrees: entries.map((e) => e.path),
      branches: entries.map((e) => e.branch),
      kind,
    });
  }
  collisions.sort((a, b) => a.file.localeCompare(b.file));
  return collisions;
}

const probeCache = new Map(); // rootPath -> { at, promise }

/** Invalidate cached worktree probe results for a repo root (or all roots when omitted). */
export function invalidateWorktreeCache(rootPath = '') {
  if (!rootPath) {
    probeCache.clear();
    return;
  }
  probeCache.delete(rootPath);
}

async function probeSingleRoot(root, ttlMs) {
  const now = Date.now();
  const cached = probeCache.get(root.path);
  if (cached && now - cached.at < ttlMs) return cached.promise;

  const promise = (async () => {
    const res = await execGit(root.path, ['worktree', 'list', '--porcelain']);
    if (!res.ok) {
      return {
        root: root.path,
        uri: root.uri,
        isGit: false,
        worktrees: [],
        collisions: [],
        error: 'not a git repository',
      };
    }
    const baseBranch = await detectBaseBranch(root.path);
    const parsed = parsePorcelainWorktrees(res.stdout).slice(0, MAX_WORKTREES_PER_ROOT);
    const inspected = await Promise.all(parsed.map((wt, idx) => inspectWorktree(root.path, wt, idx, baseBranch)));
    const worktrees = [];
    const workingPathsByWt = new Map();
    for (const item of inspected) {
      worktrees.push(item.record);
      workingPathsByWt.set(item.record.path, item.workingPathSet);
    }
    const collisions = buildRootCollisions(worktrees, workingPathsByWt);
    return {
      root: root.path,
      uri: root.uri,
      isGit: true,
      worktrees,
      collisions,
      error: '',
    };
  })();

  if (probeCache.has(root.path)) probeCache.delete(root.path);
  else if (probeCache.size >= PROBE_CACHE_CAP) probeCache.delete(probeCache.keys().next().value);
  const tracked = promise.catch((err) => {
    const cur = probeCache.get(root.path);
    if (cur && cur.promise === tracked) probeCache.delete(root.path);
    throw err;
  });
  probeCache.set(root.path, { at: now, promise: tracked });
  return tracked;
}

/** Probe worktrees across validated workspace roots using a debounced TTL cache. */
export async function probeWorktrees(rawRoots, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const { roots, rejected } = parseRootsInput(rawRoots);
  const results = await Promise.all(roots.map((r) => probeSingleRoot(r, ttlMs)));
  const worktrees = [];
  const collisions = [];
  for (const r of results) {
    worktrees.push(...r.worktrees);
    collisions.push(...r.collisions);
  }
  return {
    roots: results.map((r) => ({
      path: r.path,
      uri: r.uri,
      isGit: r.isGit,
      count: r.worktrees.length,
      error: r.error,
    })),
    worktrees,
    collisions,
    rejected,
    cachedTtlMs: ttlMs,
  };
}

async function resolveConfinedWorktree({ root = '', worktree = '', path = '' } = {}) {
  const wtStr = typeof worktree === 'string' ? worktree.trim() : '';
  const pathStr = typeof path === 'string' ? path.trim() : '';
  if (wtStr && pathStr && wtStr !== pathStr) {
    return { ok: false, status: 400, error: 'conflicting worktree and path parameters' };
  }
  const rawWt = wtStr || pathStr;
  const normWt = normalizeWorkspaceRoot(rawWt);
  const hasRoot = typeof root === 'string' && root.trim().length > 0;
  const normRoot = hasRoot ? normalizeWorkspaceRoot(root) : null;
  if ((hasRoot && !normRoot) || !normWt) {
    return { ok: false, status: 400, error: 'invalid workspace root or worktree' };
  }

  const probeDir = normRoot ? normRoot.path : normWt.path;
  const wtList = await execGit(probeDir, ['worktree', 'list', '--porcelain']);
  if (!wtList.ok) {
    return { ok: false, status: 404, error: 'not a git repository' };
  }
  const allowedWts = parsePorcelainWorktrees(wtList.stdout);
  if (allowedWts.length === 0) {
    return { ok: false, status: 404, error: 'not a git repository' };
  }

  let matchedWt = null;
  let matchedIdx = -1;
  for (let i = 0; i < allowedWts.length; i++) {
    try {
      if (isSymlinkPath(allowedWts[i].path)) continue;
      if (realpathSync(allowedWts[i].path) === normWt.path) {
        matchedWt = allowedWts[i];
        matchedIdx = i;
        break;
      }
    } catch {}
  }
  if (!matchedWt) {
    return { ok: false, status: 404, error: 'worktree not in repository' };
  }
  if (isSymlinkPath(join(normWt.path, '.git'))) {
    return { ok: false, status: 404, error: 'symlinked git metadata rejected' };
  }

  let rootPath = normRoot ? normRoot.path : '';
  if (!rootPath) {
    if (isSymlinkPath(allowedWts[0].path)) {
      return { ok: false, status: 404, error: 'symlinked primary repository rejected' };
    }
    try {
      rootPath = realpathSync(allowedWts[0].path);
    } catch {
      rootPath = allowedWts[0].path;
    }
  }
  const isMain = matchedIdx === 0 || normWt.path === rootPath;
  return { ok: true, rootPath, wtPath: normWt.path, wtEntry: matchedWt, isMain };
}

function checkAncestorInWorktree(wtReal, wtPrefix, abs) {
  let cur = dirname(abs);
  while (cur && cur.length >= wtReal.length) {
    try {
      const lst = lstatSync(cur);
      if (lst.isSymbolicLink() && cur !== wtReal) {
        const realLink = realpathSync(cur);
        if (realLink !== wtReal && !realLink.startsWith(wtPrefix)) {
          return { ok: false, error: 'parent symlink escapes worktree root' };
        }
      }
      const realCur = realpathSync(cur);
      if (realCur !== wtReal && !realCur.startsWith(wtPrefix)) {
        return { ok: false, error: 'parent escapes worktree root' };
      }
      return { ok: true };
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return { ok: false, error: 'path escapes worktree root' };
      }
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          return { ok: false, error: 'dangling parent symlink escapes worktree root' };
        }
      } catch {}
      if (cur === wtReal) break;
      const next = dirname(cur);
      if (next === cur) break;
      cur = next;
    }
  }
  return { ok: false, error: 'file parent missing' };
}

/** Validate worktree/file path confinement and return bounded (<=16 KB) git diff text. */
export async function probeWorktreeDiff({
  root = '',
  worktree = '',
  path = '',
  file = '',
  mode = 'working',
  maxBytes = 8192,
} = {}) {
  const diffMode = mode === undefined || mode === '' ? 'working' : mode;
  if (diffMode !== 'working' && diffMode !== 'branch') {
    return { ok: false, status: 400, error: 'invalid diff mode' };
  }

  const relPath = typeof file === 'string' ? file.trim() : '';
  if (!relPath || relPath.length > 1024 || /[\0\r\n\\%]|^-/.test(relPath) || isAbsolute(relPath)) {
    return { ok: false, status: 400, error: 'invalid file path' };
  }
  if (relPath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return { ok: false, status: 400, error: 'invalid path segment' };
  }

  const confined = await resolveConfinedWorktree({ root, worktree, path });
  if (!confined.ok) {
    return { ok: false, status: confined.status, error: confined.error };
  }

  const wtReal = confined.wtPath;
  const wtPrefix = wtReal.endsWith(sep) ? wtReal : `${wtReal}${sep}`;
  const abs = resolve(wtReal, relPath);
  if (!abs.startsWith(wtPrefix)) {
    return { ok: false, status: 404, error: 'path escapes worktree root' };
  }

  let realTarget = '';
  let existsOnDisk = false;
  try {
    const lst = lstatSync(abs);
    existsOnDisk = true;
    try {
      realTarget = realpathSync(abs);
    } catch {
      if (lst.isSymbolicLink()) {
        return { ok: false, status: 404, error: 'symlink escapes worktree root' };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    if (!realTarget.startsWith(wtPrefix)) {
      return { ok: false, status: 404, error: 'symlink escapes worktree root' };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const anc = checkAncestorInWorktree(wtReal, wtPrefix, abs);
      if (!anc.ok) {
        return { ok: false, status: 404, error: anc.error };
      }
    } else {
      return { ok: false, status: 404, error: 'path escapes worktree root' };
    }
  }

  const cap = Math.min(16384, Math.max(512, Number(maxBytes) || 8192));
  const streamCap = cap + 4096;
  let text = '';
  let untracked = false;
  let streamTruncated = false;

  if (diffMode === 'branch') {
    const baseBranch = await detectBaseBranch(confined.rootPath);
    if (!baseBranch) {
      return { ok: false, status: 400, error: 'base branch not found' };
    }
    const mbRes = await execGit(wtReal, ['merge-base', baseBranch, 'HEAD']);
    if (mbRes.ok && mbRes.stdout.trim()) {
      const mergeBase = mbRes.stdout.trim();
      const branchDiff = await execGitBounded(wtReal, ['diff', '--no-ext-diff', `${mergeBase}..HEAD`, '--', relPath], streamCap);
      text = branchDiff.ok ? branchDiff.stdout : '';
      streamTruncated = Boolean(branchDiff.truncated);
    }
  } else {
    const diffRes = await execGitBounded(wtReal, ['diff', 'HEAD', '--no-ext-diff', '--', relPath], streamCap);
    text = diffRes.ok ? diffRes.stdout : '';
    streamTruncated = Boolean(diffRes.truncated);
    if (!text) {
      const cachedRes = await execGitBounded(wtReal, ['diff', '--cached', '--no-ext-diff', '--', relPath], streamCap);
      const workRes = await execGitBounded(wtReal, ['diff', '--no-ext-diff', '--', relPath], streamCap);
      text = [cachedRes.ok ? cachedRes.stdout : '', workRes.ok ? workRes.stdout : ''].filter(Boolean).join('\n');
      streamTruncated = Boolean(cachedRes.truncated || workRes.truncated);
    }

    if (!text && existsOnDisk && realTarget) {
      const stRes = await execGit(wtReal, ['status', '--porcelain=v1', '-z', '--', relPath]);
      if (stRes.ok && stRes.stdout.startsWith('?? ')) {
        untracked = true;
        try {
          const st = statSync(realTarget);
          if (st.isFile()) {
            const fd = openSync(realTarget, 'r');
            let slice = Buffer.alloc(0);
            try {
              const buf = Buffer.allocUnsafe(Math.min(cap, st.size));
              const n = readSync(fd, buf, 0, buf.length, 0);
              slice = buf.subarray(0, n);
            } finally {
              closeSync(fd);
            }
            if (slice.includes(0)) {
              text = `+++ ${relPath}\n[binary untracked file omitted]`;
            } else {
              const rawText = slice.toString('utf8');
              const bodyLines = rawText.split('\n').map((l) => `+${l}`).join('\n');
              text = `+++ ${relPath} (untracked)\n${bodyLines}${st.size > cap ? '\n... (truncated)' : ''}`;
              if (st.size > cap) streamTruncated = true;
            }
          }
        } catch {}
      }
    }
  }

  text = text.replace(/\/home\/[^/\s]+\//g, '~/');
  let truncated = streamTruncated;
  if (Buffer.byteLength(text, 'utf8') > cap) {
    let clipped = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8').replace(/\uFFFD+$/, '');
    const nl = clipped.lastIndexOf('\n');
    if (nl > cap * 0.5) clipped = clipped.slice(0, nl);
    text = clipped;
    truncated = true;
  }

  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }

  return {
    ok: true,
    status: 200,
    worktree: wtReal,
    file: relPath,
    mode: diffMode,
    diff: text,
    truncated,
    untracked,
    added,
    removed,
  };
}

function isSafeBranchName(name) {
  if (typeof name !== 'string') return false;
  const s = name.trim();
  if (!s || !BRANCH_NAME_RE.test(s)) return false;
  if (s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.') || s.endsWith('.lock')) return false;
  if (s.includes('..') || s.includes('//') || s.includes('@{')) return false;
  return true;
}

async function isWorktreeClean(wtPath) {
  const res = await execGit(wtPath, ['status', '--porcelain=v1', '-z']);
  return res.ok && res.stdout.length === 0;
}

async function hasInProgressGitOp(wtPath) {
  for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD']) {
    const res = await execGit(wtPath, ['rev-parse', '--git-path', marker]);
    if (res.ok && res.stdout.trim()) {
      const p = isAbsolute(res.stdout.trim()) ? res.stdout.trim() : resolve(wtPath, res.stdout.trim());
      if (existsSync(p)) return marker;
    }
  }
  return '';
}

function hasValidHeadSha(wtEntry) {
  const h = typeof wtEntry?.head === 'string' ? wtEntry.head.trim() : '';
  return /^[0-9a-f]{7,64}$/i.test(h) && !/^0+$/.test(h);
}

/** Execute a confined, shell-free git worktree action (`dry_run_merge`, `ff_merge`, `rebase`, `remove_worktree`). */
export async function executeWorktreeAction({
  action = '',
  root = '',
  path = '',
  worktree = '',
  targetBranch = '',
  deleteBranch = false,
} = {}) {
  if (!VALID_ACTIONS.has(action)) {
    return {
      ok: false,
      httpStatus: 400,
      payload: { ok: false, action: String(action || ''), status: 'invalid', message: 'Unsupported worktree action' },
    };
  }

  const confined = await resolveConfinedWorktree({ root, worktree, path });
  if (!confined.ok) {
    return {
      ok: false,
      httpStatus: confined.status,
      payload: { ok: false, action, status: 'invalid', message: confined.error },
    };
  }

  const { rootPath, wtPath, wtEntry, isMain } = confined;
  const wtBranch = wtEntry.branch || '';

  let target = '';
  if (typeof targetBranch === 'string' && targetBranch.trim()) {
    const candidate = targetBranch.trim();
    if (!isSafeBranchName(candidate)) {
      return {
        ok: false,
        httpStatus: 400,
        payload: { ok: false, action, status: 'invalid', message: 'Invalid targetBranch name' },
      };
    }
    const refCheck = await execGit(rootPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (!refCheck.ok || !refCheck.stdout.trim()) {
      return {
        ok: false,
        httpStatus: 404,
        payload: { ok: false, action, status: 'not_found', message: `Target branch '${candidate}' not found` },
      };
    }
    target = candidate;
  } else {
    target = await detectBaseBranch(rootPath);
    if (!target) {
      return {
        ok: false,
        httpStatus: 400,
        payload: { ok: false, action, status: 'no_base', message: 'Base branch (main/master) not found' },
      };
    }
  }

  const fail = (httpStatus, status, message, extra = {}) => ({
    ok: false,
    httpStatus,
    payload: { ok: false, action, status, message, ...extra },
  });

  if (action === 'dry_run_merge') {
    if (isMain || wtBranch === target) {
      return fail(400, 'invalid', `Cannot dry-run merge ${target} into itself`);
    }
    if (!hasValidHeadSha(wtEntry)) {
      return fail(400, 'invalid', 'Worktree has no HEAD commit');
    }
    const wtRef = wtBranch || wtEntry.head;
    const mtRaw = await execGit(rootPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', target, wtRef]);
    const mt = parseMergeTreeOutput(mtRaw);
    if (!mt.ok) {
      return fail(409, 'error', mt.error);
    }
    const status = mt.clean ? 'clean' : 'conflict';
    const message = mt.clean
      ? `Clean merge into ${target}`
      : `${mt.conflictFiles.length} conflict(s) merging into ${target}`;
    return {
      ok: true,
      httpStatus: 200,
      payload: {
        ok: true,
        action,
        status,
        clean: mt.clean,
        conflicts: mt.conflictFiles,
        conflictFiles: mt.conflictFiles,
        treeSha: mt.treeSha,
        result: { clean: mt.clean, treeSha: mt.treeSha, conflicts: mt.conflictFiles },
        message,
      },
    };
  }

  if (action === 'ff_merge') {
    if (isMain || wtBranch === target) {
      return fail(400, 'invalid', `Cannot fast-forward merge ${target} into itself`);
    }
    if (wtEntry.detached || !wtBranch) {
      return fail(400, 'detached', 'Cannot fast-forward merge a detached worktree');
    }
    if ((await hasInProgressGitOp(wtPath)) || (await hasInProgressGitOp(rootPath))) {
      return fail(409, 'in_progress', 'Repository or worktree has an in-progress rebase or merge');
    }
    if (!(await isWorktreeClean(wtPath))) {
      return fail(409, 'dirty', 'Worktree has uncommitted changes');
    }
    if (!(await isWorktreeClean(rootPath))) {
      return fail(409, 'dirty', 'Primary repository has uncommitted changes');
    }
    const rootBranchRes = await execGit(rootPath, ['symbolic-ref', '--short', 'HEAD']);
    const rootBranch = rootBranchRes.ok ? rootBranchRes.stdout.trim() : '';
    if (rootBranch !== target) {
      return fail(409, 'wrong_branch', `Primary repository is on '${rootBranch || 'detached'}', expected '${target}'`);
    }
    const mergeRes = await execGit(rootPath, ['merge', '--ff-only', wtBranch], 10000);
    if (!mergeRes.ok) {
      return fail(409, 'not_ff', (mergeRes.stderr || mergeRes.error || 'Branch cannot be fast-forward merged; rebase required').trim());
    }
    invalidateWorktreeCache(rootPath);
    return {
      ok: true,
      httpStatus: 200,
      payload: {
        ok: true,
        action,
        status: 'merged',
        result: { branch: wtBranch, target, stdout: mergeRes.stdout.trim() },
        message: `Fast-forwarded ${target} to ${wtBranch}`,
      },
    };
  }

  if (action === 'rebase') {
    if (isMain || wtBranch === target) {
      return fail(400, 'invalid', `Cannot rebase ${target} worktree onto itself`);
    }
    if (wtEntry.detached || !wtBranch) {
      return fail(400, 'detached', 'Cannot rebase a detached worktree');
    }
    if (await hasInProgressGitOp(wtPath)) {
      return fail(409, 'in_progress', 'Worktree already has an in-progress rebase or merge');
    }
    if (!(await isWorktreeClean(wtPath))) {
      return fail(409, 'dirty', 'Worktree has uncommitted changes; commit or stash before rebasing');
    }
    const rebaseRes = await execGit(wtPath, ['rebase', target], 10000);
    if (rebaseRes.ok) {
      invalidateWorktreeCache(rootPath);
      return {
        ok: true,
        httpStatus: 200,
        payload: {
          ok: true,
          action,
          status: 'rebased',
          result: { branch: wtBranch, target, stdout: rebaseRes.stdout.trim() },
          message: `Rebased ${wtBranch} onto ${target}`,
        },
      };
    }
    const conflictRes = await execGit(wtPath, ['diff', '--name-only', '--diff-filter=U', '-z']);
    const conflicts = conflictRes.ok && conflictRes.stdout
      ? [...new Set(conflictRes.stdout.split('\0').filter(Boolean))]
      : [];
    await execGit(wtPath, ['rebase', '--abort'], 5000);
    invalidateWorktreeCache(rootPath);
    const message = conflicts.length
      ? `Rebase aborted due to conflicts in ${conflicts.join(', ')}`
      : (rebaseRes.stderr || rebaseRes.error || 'Rebase failed and was aborted').trim();
    return fail(409, 'conflict', message, {
      aborted: true,
      conflicts,
      conflictFiles: conflicts,
      result: { aborted: true, conflicts },
    });
  }

  // remove_worktree
  const detectedBase = await detectBaseBranch(rootPath);
  if (isMain || wtBranch === target || (detectedBase && wtBranch === detectedBase)) {
    return fail(400, 'invalid', 'Cannot remove primary or base-branch worktree');
  }
  if (wtEntry.locked) {
    return fail(409, 'locked', 'Worktree is locked');
  }
  if (!(await isWorktreeClean(wtPath))) {
    return fail(409, 'dirty', 'Worktree has uncommitted changes');
  }
  const mergedCheck = await execGit(wtPath, ['merge-base', '--is-ancestor', 'HEAD', target]);
  if (!mergedCheck.ok) {
    return fail(409, 'unmerged', `Worktree has unmerged commits not in ${target}`);
  }
  const rmRes = await execGit(rootPath, ['worktree', 'remove', wtPath], 10000);
  if (!rmRes.ok) {
    return fail(409, 'error', (rmRes.stderr || rmRes.error || 'Failed to remove worktree').trim());
  }
  let branchDeleted = false;
  if (deleteBranch === true && wtBranch) {
    const brRes = await execGit(rootPath, ['branch', '-d', wtBranch]);
    branchDeleted = brRes.ok;
  }
  invalidateWorktreeCache(rootPath);
  return {
    ok: true,
    httpStatus: 200,
    payload: {
      ok: true,
      action,
      status: 'removed',
      result: { path: wtPath, branch: wtBranch, branchDeleted },
      message: `Removed clean merged worktree ${basename(wtPath)}`,
    },
  };
}

/** Inspect a member's workspace path (uncached) for dirty files and unmerged commits ahead of base branch. */
export async function probeMemberWorktree(workspacePath) {
  const confined = await resolveConfinedWorktree({ worktree: workspacePath });
  if (!confined.ok) {
    return { ok: false, error: confined.error };
  }
  const { rootPath, wtPath, wtEntry, isMain } = confined;
  const branch = wtEntry.branch || (wtEntry.detached ? 'detached' : '');
  const baseBranch = await detectBaseBranch(rootPath);
  const checkAhead = Boolean(baseBranch && (!isMain || wtEntry.detached || (branch && branch !== baseBranch)));

  const [statusRes, divRes] = await Promise.all([
    execGit(wtPath, ['status', '--porcelain=v1', '-z']),
    checkAhead ? execGit(wtPath, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`]) : Promise.resolve({ ok: false, stdout: '' }),
  ]);

  let dirtyFiles = 0;
  if (statusRes.ok && statusRes.stdout) {
    const tokens = statusRes.stdout.split('\0');
    for (let i = 0; i < tokens.length; ) {
      const rec = tokens[i++];
      if (!rec || rec.length < 4) continue;
      const x = rec[0];
      if (x === 'R' || x === 'C') i++;
      dirtyFiles++;
    }
  }

  let ahead = 0;
  if (divRes.ok && divRes.stdout.trim()) {
    const parts = divRes.stdout.trim().split(/\s+/);
    ahead = Number(parts[1]) || 0;
  }

  return {
    ok: true,
    rootPath,
    path: wtPath,
    branch,
    baseBranch: baseBranch || '',
    isMain,
    dirtyFiles,
    ahead,
  };
}

async function inspectCheckpointWorktree(rootPath, wt, index) {
  let wtReal = wt.path;
  try {
    if (isSymlinkPath(wt.path) || isSymlinkPath(join(wt.path, '.git'))) return null;
    wtReal = realpathSync(wt.path);
    if (!statSync(wtReal).isDirectory()) return null;
  } catch {
    return null;
  }

  let head = typeof wt.head === 'string' ? wt.head.trim() : '';
  if (!head && !wt.bare) {
    const headRes = await execGit(wtReal, ['rev-parse', 'HEAD']);
    if (headRes.ok) head = headRes.stdout.trim();
  }
  const clean = wt.bare ? true : await isWorktreeClean(wtReal);
  const branch = wt.branch || (wt.detached ? 'detached' : 'unknown');
  const isMain = index === 0 || wtReal === rootPath;

  return {
    root: rootPath,
    path: wtReal,
    name: basename(wtReal) || wtReal,
    branch,
    head,
    shortHead: head.slice(0, 8),
    clean,
    isMain,
    detached: Boolean(wt.detached),
  };
}

/** Probe worktree HEAD SHAs and clean flags across workspace roots and member paths for checkpoints. */
export async function probeCheckpointWorktrees(rawRoots = [], extraWorktreePaths = []) {
  const { roots, rejected } = parseRootsInput(rawRoots);
  const byPath = new Map();

  for (const r of roots) {
    const res = await execGit(r.path, ['worktree', 'list', '--porcelain']);
    if (!res.ok) continue;
    const parsed = parsePorcelainWorktrees(res.stdout).slice(0, MAX_WORKTREES_PER_ROOT);
    const entries = await Promise.all(parsed.map((wt, idx) => inspectCheckpointWorktree(r.path, wt, idx)));
    for (const item of entries) {
      if (item && !byPath.has(item.path)) byPath.set(item.path, item);
    }
  }

  if (Array.isArray(extraWorktreePaths)) {
    const seenExtra = new Set();
    for (const rawPath of extraWorktreePaths.slice(0, MAX_ROOTS)) {
      if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
      const confined = await resolveConfinedWorktree({ worktree: rawPath });
      if (!confined.ok || byPath.has(confined.wtPath) || seenExtra.has(confined.wtPath)) continue;
      seenExtra.add(confined.wtPath);
      const item = await inspectCheckpointWorktree(confined.rootPath, confined.wtEntry, confined.isMain ? 0 : 1);
      if (item && !byPath.has(item.path)) byPath.set(item.path, item);
    }
  }

  return {
    worktrees: [...byPath.values()],
    rejected,
  };
}
