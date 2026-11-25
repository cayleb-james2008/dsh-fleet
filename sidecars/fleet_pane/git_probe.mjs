/**
 * Workspace git worktree & status prober for Fleet sidecar.
 * Validates workspace roots strictly (no shell, no traversal, canonical dir checks)
 * and debounces git commands with a short TTL cache so rapid UI polling stays fast.
 */
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_ROOTS = 16;
const MAX_WORKTREES_PER_ROOT = 24;
const GIT_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 3000;

function execGit(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, stdout: '', error: err.message });
        resolve({ ok: true, stdout: stdout || '' });
      },
    );
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
    const real = realpathSync(fsPath);
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

async function inspectWorktree(rootPath, wt, index) {
  let wtReal = wt.path;
  let exists = true;
  try {
    wtReal = realpathSync(wt.path);
    exists = statSync(wtReal).isDirectory();
  } catch {
    exists = false;
  }

  let dirtyFiles = 0;
  let untrackedFiles = 0;
  let stagedFiles = 0;
  let lastCommitSha = wt.head ? wt.head.slice(0, 8) : '';
  let lastCommitSubject = '';
  let lastCommitAt = 0;

  if (exists && !wt.bare) {
    const [statusRes, logRes] = await Promise.all([
      execGit(wtReal, ['status', '--porcelain']),
      execGit(wtReal, ['log', '-n', '1', '--format=%h%x09%s%x09%ct']),
    ]);
    if (statusRes.ok && statusRes.stdout) {
      for (const l of statusRes.stdout.split('\n')) {
        if (!l) continue;
        if (l.startsWith('??')) untrackedFiles++;
        else {
          if (l[0] && l[0] !== ' ') stagedFiles++;
          if (l[1] && l[1] !== ' ') dirtyFiles++;
        }
      }
    }
    if (logRes.ok && logRes.stdout.trim()) {
      const [sha = '', subject = '', ts = '0'] = logRes.stdout.trim().split('\t');
      lastCommitSha = sha || lastCommitSha;
      lastCommitSubject = subject.slice(0, 120);
      lastCommitAt = Number(ts) ? Number(ts) * 1000 : 0;
    }
  }

  return {
    id: `${rootPath}::${wtReal}`,
    root: rootPath,
    name: basename(wtReal) || wtReal,
    path: wtReal,
    uri: exists ? pathToFileURL(wtReal).href : '',
    isMain: index === 0 || wtReal === rootPath,
    exists,
    bare: wt.bare,
    detached: wt.detached,
    locked: wt.locked,
    prunable: wt.prunable,
    branch: wt.branch || (wt.detached ? 'detached' : 'unknown'),
    head: wt.head.slice(0, 8),
    clean: dirtyFiles === 0 && untrackedFiles === 0 && stagedFiles === 0,
    dirtyFiles,
    untrackedFiles,
    stagedFiles,
    lastCommitSha,
    lastCommitSubject,
    lastCommitAt,
  };
}

const probeCache = new Map(); // rootPath -> { at, promise }

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
        error: 'not a git repository',
      };
    }
    const parsed = parsePorcelainWorktrees(res.stdout).slice(0, MAX_WORKTREES_PER_ROOT);
    const worktrees = await Promise.all(parsed.map((wt, idx) => inspectWorktree(root.path, wt, idx)));
    return {
      root: root.path,
      uri: root.uri,
      isGit: true,
      worktrees,
      error: '',
    };
  })();

  if (probeCache.size > 64) probeCache.clear();
  probeCache.set(root.path, { at: now, promise });
  return promise;
}

/** Probe worktrees across validated workspace roots using a debounced TTL cache. */
export async function probeWorktrees(rawRoots, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const { roots, rejected } = parseRootsInput(rawRoots);
  const results = await Promise.all(roots.map((r) => probeSingleRoot(r, ttlMs)));
  const worktrees = [];
  for (const r of results) {
    worktrees.push(...r.worktrees);
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
    rejected,
    cachedTtlMs: ttlMs,
  };
}
