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
const MAX_DIFF_BYTES = 32768;
const MAX_DIFF_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_COMMIT_MSG_LEN = 4096;
const GIT_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 3000;
const PROBE_CACHE_CAP = 32;
const VALID_ACTIONS = new Set([
  'dry_run_merge',
  'ff_merge',
  'squash_merge',
  'merge_commit',
  'rebase',
  'remove_worktree',
]);
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const COMMIT_MSG_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

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

function execGitDiffSlice(cwd, args, startOffset = 0, cap = 8192, timeoutMs = GIT_TIMEOUT_MS) {
  const winStart = Math.max(0, startOffset);
  const winEnd = winStart + cap + 16;
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let collected = 0;
    let totalBytes = 0;
    let streamTruncated = false;
    let settled = false;
    let stderr = '';
    const finish = (ok, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const windowBuf = chunks.length ? Buffer.concat(chunks, collected) : Buffer.alloc(0);
      resolve({ ok, code, windowBuf, windowStart: winStart, totalBytes, streamTruncated, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(false, 1);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      if (streamTruncated) return;
      const chunkStart = totalBytes;
      let chunkEnd = chunkStart + chunk.length;
      if (chunkEnd > MAX_DIFF_STREAM_BYTES) {
        const keep = MAX_DIFF_STREAM_BYTES - chunkStart;
        if (keep > 0) {
          const clipped = chunk.subarray(0, keep);
          totalBytes = MAX_DIFF_STREAM_BYTES;
          chunkEnd = MAX_DIFF_STREAM_BYTES;
          const ovStart = Math.max(chunkStart, winStart);
          const ovEnd = Math.min(chunkEnd, winEnd);
          if (ovEnd > ovStart) {
            const part = clipped.subarray(ovStart - chunkStart, ovEnd - chunkStart);
            chunks.push(part);
            collected += part.length;
          }
        }
        streamTruncated = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        return;
      }
      totalBytes = chunkEnd;
      const ovStart = Math.max(chunkStart, winStart);
      const ovEnd = Math.min(chunkEnd, winEnd);
      if (ovEnd > ovStart) {
        const part = chunk.subarray(ovStart - chunkStart, ovEnd - chunkStart);
        chunks.push(part);
        collected += part.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish(false, 1));
    child.on('close', (code) => {
      finish(code === 0 || streamTruncated, typeof code === 'number' ? code : 1);
    });
  });
}

function sliceDiffWindow(windowBuf, windowStart, cap, totalBytes, streamTruncated = false) {
  if (windowStart >= totalBytes || windowBuf.length === 0) {
    return {
      diff: '',
      nextOffset: null,
      hasMore: false,
      totalBytes,
      truncated: Boolean(streamTruncated),
    };
  }

  let startRel = 0;
  if (windowStart > 0) {
    while (startRel < windowBuf.length && startRel < 3 && (windowBuf[startRel] & 0xc0) === 0x80) {
      startRel++;
    }
  }
  const actualStart = windowStart + startRel;
  if (actualStart >= totalBytes || startRel >= windowBuf.length) {
    return {
      diff: '',
      nextOffset: null,
      hasMore: false,
      totalBytes,
      truncated: Boolean(streamTruncated),
    };
  }

  const maxEndRel = Math.min(windowBuf.length, startRel + cap);
  let endRel = maxEndRel;
  const absEnd = windowStart + endRel;
  if (absEnd < totalBytes && endRel > startRel) {
    let p = endRel - 1;
    while (p >= startRel && (windowBuf[p] & 0xc0) === 0x80) p--;
    if (p >= startRel) {
      const lead = windowBuf[p];
      const seqLen = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
      if (p + seqLen > endRel) endRel = p;
    }
  }
  if (windowStart + endRel < totalBytes && endRel > startRel) {
    const nlPos = windowBuf.subarray(startRel, endRel).lastIndexOf(0x0a);
    if (nlPos > Math.floor((endRel - startRel) * 0.5)) {
      endRel = startRel + nlPos + 1;
    }
  }
  if (endRel <= startRel) endRel = maxEndRel;

  const actualEnd = Math.min(totalBytes, windowStart + endRel);
  const text = windowBuf.subarray(startRel, endRel).toString('utf8').replace(/\/home\/[^/\s]+\//g, '~/');
  const hasMore = actualEnd < totalBytes || Boolean(streamTruncated);
  return {
    diff: text,
    nextOffset: actualEnd < totalBytes ? actualEnd : null,
    hasMore,
    totalBytes,
    truncated: hasMore,
  };
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
      : ahead === 0
        ? 'merged'
        : behind > 0
          ? 'rebase'
          : 'ready';

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

/**
 * Resolve a raw workspace path to its canonical git primary root (`--git-common-dir`)
 * and worktree root (`--show-toplevel`) under strict CWE-59 symlink/root confinement.
 */
export async function resolveGitRepoRoot(rawPath) {
  const norm = normalizeWorkspaceRoot(rawPath);
  if (!norm) return { ok: false, path: '', rootPath: '', worktreePath: '' };
  if (isSymlinkPath(join(norm.path, '.git'))) {
    return { ok: false, path: norm.path, rootPath: '', worktreePath: '' };
  }
  const rev = await execGit(norm.path, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (!rev.ok || !rev.stdout.trim()) {
    return { ok: false, path: norm.path, rootPath: '', worktreePath: '' };
  }
  const lines = rev.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const rawTop = lines[0] || '';
  const rawCommon = lines[1] || '';
  if (!rawTop || !rawCommon) {
    return { ok: false, path: norm.path, rootPath: '', worktreePath: '' };
  }
  const normTop = normalizeWorkspaceRoot(rawTop);
  if (!normTop || isSymlinkPath(join(normTop.path, '.git'))) {
    return { ok: false, path: norm.path, rootPath: '', worktreePath: '' };
  }

  const absCommon = stripTrailingSlashes(isAbsolute(rawCommon) ? rawCommon : resolve(norm.path, rawCommon));
  if (isSymlinkPath(absCommon)) {
    return { ok: false, path: norm.path, rootPath: '', worktreePath: '' };
  }
  const commonCandidate = basename(absCommon) === '.git' ? dirname(absCommon) : absCommon;
  const normRoot = normalizeWorkspaceRoot(commonCandidate);
  if (!normRoot || isSymlinkPath(join(normRoot.path, '.git'))) {
    return { ok: false, path: norm.path, rootPath: '', worktreePath: '' };
  }
  return {
    ok: true,
    path: norm.path,
    rootPath: normRoot.path,
    rootUri: normRoot.uri,
    worktreePath: normTop.path,
  };
}

function ownerPriority(entry) {
  const killed = entry.killed ? 1 : 0;
  const inherit = entry.workspaceMode === 'inherit' || !entry.workspaceMode ? 1 : 0;
  const coord = entry.role === 'coordinator' || entry.member === 'coordinator' ? 1 : 0;
  const working = entry.status === 'working' ? 0 : entry.status === 'waiting' ? 1 : 2;
  return killed * 100 + inherit * 20 + coord * 10 + working;
}

/** Probe worktrees across validated workspace roots and optional swarm context using a debounced TTL cache. */
export async function probeWorktrees(rawRoots, { ttlMs = DEFAULT_TTL_MS, swarmContext = null } = {}) {
  const { roots, rejected } = parseRootsInput(rawRoots);
  const seenRoots = new Set(roots.map((r) => r.path));
  const ownerCandidates = new Map(); // worktreePath -> best entry

  if (swarmContext && typeof swarmContext === 'object') {
    const memberEntries = Array.isArray(swarmContext.workspaces) ? swarmContext.workspaces : [];
    const resolvedMembers = await Promise.all(
      memberEntries.slice(0, MAX_ROOTS * 2).map(async (m) => {
        if (!m || typeof m.path !== 'string' || !m.path.trim()) return null;
        const resolved = await resolveGitRepoRoot(m.path);
        return resolved.ok ? { meta: m, resolved } : null;
      }),
    );

    for (const item of resolvedMembers) {
      if (!item) continue;
      const { meta, resolved } = item;
      if (!meta.killed && roots.length < MAX_ROOTS && !seenRoots.has(resolved.rootPath)) {
        seenRoots.add(resolved.rootPath);
        roots.push({ path: resolved.rootPath, uri: resolved.rootUri });
      }
      const candidate = {
        member: String(meta.member || ''),
        status: String(meta.status || 'unknown'),
        workspaceMode: String(meta.workspaceMode || 'inherit'),
        killed: Boolean(meta.killed),
        role: String(meta.role || ''),
      };
      const prev = ownerCandidates.get(resolved.worktreePath);
      if (!prev || ownerPriority(candidate) < ownerPriority(prev)) {
        ownerCandidates.set(resolved.worktreePath, candidate);
      }
    }

    if (typeof swarmContext.repo === 'string' && swarmContext.repo.trim() && roots.length < MAX_ROOTS) {
      const resolvedRepo = await resolveGitRepoRoot(swarmContext.repo);
      if (resolvedRepo.ok && !seenRoots.has(resolvedRepo.rootPath)) {
        seenRoots.add(resolvedRepo.rootPath);
        roots.push({ path: resolvedRepo.rootPath, uri: resolvedRepo.rootUri });
      }
    }
  }

  const results = await Promise.all(roots.map((r) => probeSingleRoot(r, ttlMs)));
  const worktrees = [];
  const collisions = [];
  for (const r of results) {
    for (const wt of r.worktrees) {
      const owner = ownerCandidates.get(wt.path);
      worktrees.push(
        owner
          ? {
              ...wt,
              swarmOwner: {
                member: owner.member,
                status: owner.status,
                workspaceMode: owner.workspaceMode,
              },
            }
          : wt,
      );
    }
    collisions.push(...r.collisions);
  }
  return {
    roots: results.map((r) => ({
      path: r.root,
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

async function resolveTargetBranch(rootPath, targetBranch) {
  if (typeof targetBranch === 'string' && targetBranch.trim()) {
    const candidate = targetBranch.trim();
    if (!isSafeBranchName(candidate)) {
      return { ok: false, status: 400, code: 'invalid', error: 'Invalid targetBranch name' };
    }
    const refCheck = await execGit(rootPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (!refCheck.ok || !refCheck.stdout.trim()) {
      return { ok: false, status: 404, code: 'not_found', error: `Target branch '${candidate}' not found` };
    }
    return { ok: true, target: candidate };
  }
  const base = await detectBaseBranch(rootPath);
  if (!base) {
    return { ok: false, status: 400, code: 'no_base', error: 'Base branch (main/master) not found' };
  }
  return { ok: true, target: base };
}

/** Validate worktree/file path confinement and return paginated (<=32 KiB) git diff text. */
export async function probeWorktreeDiff({
  root = '',
  worktree = '',
  path = '',
  file = '',
  mode = 'working',
  targetBranch = '',
  offset = 0,
  maxBytes = 8192,
} = {}) {
  const diffMode = mode === undefined || mode === '' ? 'working' : mode;
  if (diffMode !== 'working' && diffMode !== 'branch' && diffMode !== 'conflict') {
    return { ok: false, status: 400, error: 'invalid diff mode' };
  }

  let startOffset = 0;
  if (offset !== undefined && offset !== null && offset !== '') {
    if (typeof offset === 'boolean' || !/^\d+$/.test(String(offset).trim())) {
      return { ok: false, status: 400, error: 'invalid offset' };
    }
    startOffset = Number(String(offset).trim());
    if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
      return { ok: false, status: 400, error: 'invalid offset' };
    }
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

  const rawMax = Number(maxBytes);
  const cap = Math.min(MAX_DIFF_BYTES, Math.max(512, Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 8192));
  let resolvedTarget = '';
  let untracked = false;
  let page = { diff: '', nextOffset: null, hasMore: false, totalBytes: 0, truncated: false };

  if (diffMode === 'branch' || diffMode === 'conflict' || (typeof targetBranch === 'string' && targetBranch.trim())) {
    const targetRes = await resolveTargetBranch(confined.rootPath, targetBranch);
    if (!targetRes.ok) {
      return { ok: false, status: targetRes.status, error: targetRes.error };
    }
    resolvedTarget = targetRes.target;
  }

  if (diffMode === 'conflict') {
    if (confined.isMain || confined.wtEntry.branch === resolvedTarget) {
      return { ok: false, status: 400, error: `Cannot inspect merge conflict of ${resolvedTarget} against itself` };
    }
    if (!hasValidHeadSha(confined.wtEntry)) {
      return { ok: false, status: 400, error: 'Worktree has no HEAD commit' };
    }
    const wtRef = confined.wtEntry.branch || confined.wtEntry.head;
    const mtRaw = await execGit(confined.rootPath, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      resolvedTarget,
      wtRef,
    ]);
    const mt = parseMergeTreeOutput(mtRaw);
    if (!mt.ok) {
      return { ok: false, status: 409, error: mt.error };
    }
    if (!mt.clean && mt.conflictFiles.includes(relPath)) {
      const conflictSlice = await execGitDiffSlice(
        confined.rootPath,
        ['diff', '--no-ext-diff', resolvedTarget, mt.treeSha, '--', relPath],
        startOffset,
        cap,
      );
      if (conflictSlice.ok && conflictSlice.totalBytes > 0) {
        page = sliceDiffWindow(
          conflictSlice.windowBuf,
          conflictSlice.windowStart,
          cap,
          conflictSlice.totalBytes,
          conflictSlice.streamTruncated,
        );
      } else {
        // Modify/delete or rename conflict where tree kept target version: diff target vs wtRef with conflict header
        const rawFallback = await execGit(confined.rootPath, ['diff', '--no-ext-diff', resolvedTarget, wtRef, '--', relPath]);
        const note = `CONFLICT (${relPath}): conflicts between ${resolvedTarget} and ${wtRef}\n`;
        const fullBuf = Buffer.from(note + (rawFallback.ok ? rawFallback.stdout : ''), 'utf8');
        const sliceBuf = fullBuf.subarray(startOffset, startOffset + cap + 16);
        page = sliceDiffWindow(sliceBuf, startOffset, cap, fullBuf.length, false);
      }
    }
  } else if (diffMode === 'branch') {
    const mbRes = await execGit(wtReal, ['merge-base', resolvedTarget, 'HEAD']);
    if (mbRes.ok && mbRes.stdout.trim()) {
      const mergeBase = mbRes.stdout.trim();
      const branchSlice = await execGitDiffSlice(
        wtReal,
        ['diff', '--no-ext-diff', `${mergeBase}..HEAD`, '--', relPath],
        startOffset,
        cap,
      );
      if (branchSlice.ok && branchSlice.totalBytes > 0) {
        page = sliceDiffWindow(
          branchSlice.windowBuf,
          branchSlice.windowStart,
          cap,
          branchSlice.totalBytes,
          branchSlice.streamTruncated,
        );
      }
    }
  } else {
    const headSlice = await execGitDiffSlice(wtReal, ['diff', 'HEAD', '--no-ext-diff', '--', relPath], startOffset, cap);
    if (headSlice.ok && headSlice.totalBytes > 0) {
      page = sliceDiffWindow(
        headSlice.windowBuf,
        headSlice.windowStart,
        cap,
        headSlice.totalBytes,
        headSlice.streamTruncated,
      );
    } else {
      const [cachedRes, workRes] = await Promise.all([
        execGitDiffSlice(wtReal, ['diff', '--cached', '--no-ext-diff', '--', relPath], 0, MAX_DIFF_BYTES),
        execGitDiffSlice(wtReal, ['diff', '--no-ext-diff', '--', relPath], 0, MAX_DIFF_BYTES),
      ]);
      const combined = [
        cachedRes.ok ? cachedRes.windowBuf.toString('utf8') : '',
        workRes.ok ? workRes.windowBuf.toString('utf8') : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (combined) {
        const fullBuf = Buffer.from(combined, 'utf8');
        const sliceBuf = fullBuf.subarray(startOffset, startOffset + cap + 16);
        page = sliceDiffWindow(
          sliceBuf,
          startOffset,
          cap,
          fullBuf.length,
          Boolean(cachedRes.streamTruncated || workRes.streamTruncated),
        );
      }
    }

    if (page.totalBytes === 0 && existsOnDisk && realTarget) {
      const stRes = await execGit(wtReal, ['status', '--porcelain=v1', '-z', '--', relPath]);
      if (stRes.ok && stRes.stdout.startsWith('?? ')) {
        untracked = true;
        try {
          const st = statSync(realTarget);
          if (st.isFile()) {
            const readCap = Math.min(2 * 1024 * 1024, st.size);
            const fd = openSync(realTarget, 'r');
            let rawBuf = Buffer.alloc(0);
            try {
              const buf = Buffer.allocUnsafe(readCap);
              const n = readSync(fd, buf, 0, buf.length, 0);
              rawBuf = buf.subarray(0, n);
            } finally {
              closeSync(fd);
            }
            if (rawBuf.subarray(0, Math.min(8192, rawBuf.length)).includes(0)) {
              const binBuf = Buffer.from(`+++ ${relPath}\n[binary untracked file omitted]`, 'utf8');
              page = sliceDiffWindow(binBuf.subarray(startOffset, startOffset + cap + 16), startOffset, cap, binBuf.length, false);
            } else {
              const rawText = rawBuf.toString('utf8');
              const bodyLines = rawText.split('\n').map((l) => `+${l}`).join('\n');
              const formatted = `+++ ${relPath} (untracked)\n${bodyLines}${st.size > readCap ? '\n... (truncated)' : ''}`;
              const fullBuf = Buffer.from(formatted, 'utf8');
              page = sliceDiffWindow(
                fullBuf.subarray(startOffset, startOffset + cap + 16),
                startOffset,
                cap,
                fullBuf.length,
                st.size > readCap,
              );
            }
          }
        } catch {}
      }
    }
  }

  let added = 0;
  let removed = 0;
  for (const line of page.diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }

  return {
    ok: true,
    status: 200,
    worktree: wtReal,
    file: relPath,
    mode: diffMode,
    ...(resolvedTarget ? { targetBranch: resolvedTarget } : {}),
    diff: page.diff,
    offset: startOffset,
    nextOffset: page.nextOffset,
    hasMore: page.hasMore,
    totalBytes: page.totalBytes,
    truncated: page.truncated,
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

async function checkMergePreconditions({ isMain, wtBranch, target, wtEntry, wtPath, rootPath, fail, verb }) {
  if (isMain || wtBranch === target) {
    return fail(400, 'invalid', `Cannot ${verb} ${target} into itself`);
  }
  if (wtEntry.detached || !wtBranch) {
    return fail(400, 'detached', `Cannot ${verb} a detached worktree`);
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
  return null;
}

async function readUnmergedConflicts(cwd) {
  const conflictRes = await execGit(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return conflictRes.ok && conflictRes.stdout
    ? [...new Set(conflictRes.stdout.split('\0').filter(Boolean))]
    : [];
}

async function abortAndFailConflict({ cwd, rootPath, abortCmd, extraReset = false, opRes, label, fail }) {
  const conflicts = await readUnmergedConflicts(cwd);
  await execGit(cwd, abortCmd, 5000);
  if (extraReset && !(await isWorktreeClean(cwd))) {
    await execGit(cwd, ['reset', '--merge'], 5000);
  }
  invalidateWorktreeCache(rootPath);
  const message = conflicts.length
    ? `${label} aborted due to conflicts in ${conflicts.join(', ')}`
    : (opRes.stderr || opRes.error || `${label} failed and was aborted`).trim();
  return fail(409, 'conflict', message, {
    aborted: true,
    conflicts,
    conflictFiles: conflicts,
    result: { aborted: true, conflicts },
  });
}

function sanitizeCommitMessage(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'commitMessage must be a string' };
  const normalized = raw.replace(/\r\n?/g, '\n');
  if (COMMIT_MSG_CTRL_RE.test(normalized)) {
    return { ok: false, error: 'commitMessage contains invalid control characters' };
  }
  const trimmed = normalized.trim();
  if (trimmed.length > MAX_COMMIT_MSG_LEN) {
    return { ok: false, error: `commitMessage exceeds ${MAX_COMMIT_MSG_LEN} characters` };
  }
  return { ok: true, value: trimmed };
}

/** Execute a confined, shell-free git worktree action (`dry_run_merge`, `ff_merge`, `squash_merge`, `merge_commit`, `rebase`, `remove_worktree`). */
export async function executeWorktreeAction({
  action = '',
  root = '',
  path = '',
  worktree = '',
  targetBranch = '',
  deleteBranch = false,
  confirm = undefined,
  commitMessage = '',
} = {}) {
  if (!VALID_ACTIONS.has(action)) {
    return {
      ok: false,
      httpStatus: 400,
      payload: { ok: false, action: String(action || ''), status: 'invalid', message: 'Unsupported worktree action' },
    };
  }

  if ((action === 'squash_merge' || action === 'merge_commit') && confirm !== true) {
    return {
      ok: false,
      httpStatus: 400,
      payload: {
        ok: false,
        action,
        status: 'confirmation_required',
        message: 'Confirmation required (confirm: true)',
        error: 'Confirmation required',
      },
    };
  }

  const msgCheck = sanitizeCommitMessage(commitMessage);
  if (!msgCheck.ok) {
    return {
      ok: false,
      httpStatus: 400,
      payload: { ok: false, action, status: 'invalid', message: msgCheck.error, error: msgCheck.error },
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

  const targetRes = await resolveTargetBranch(rootPath, targetBranch);
  if (!targetRes.ok) {
    return {
      ok: false,
      httpStatus: targetRes.status,
      payload: { ok: false, action, status: targetRes.code || 'invalid', message: targetRes.error },
    };
  }
  const target = targetRes.target;

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
    const blocked = await checkMergePreconditions({
      isMain,
      wtBranch,
      target,
      wtEntry,
      wtPath,
      rootPath,
      fail,
      verb: 'fast-forward merge',
    });
    if (blocked) return blocked;

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

  if (action === 'squash_merge' || action === 'merge_commit') {
    const verb = action === 'squash_merge' ? 'squash merge' : 'merge';
    const blocked = await checkMergePreconditions({
      isMain,
      wtBranch,
      target,
      wtEntry,
      wtPath,
      rootPath,
      fail,
      verb,
    });
    if (blocked) return blocked;

    const alreadyMerged = await execGit(rootPath, ['merge-base', '--is-ancestor', wtBranch, target]);
    if (alreadyMerged.ok) {
      return fail(409, 'already_merged', `Branch '${wtBranch}' has no unmerged commits ahead of '${target}'`);
    }

    const defaultMsg =
      action === 'squash_merge'
        ? `Squash merge ${wtBranch} into ${target}`
        : `Merge branch '${wtBranch}' into ${target}`;
    const finalMsg = msgCheck.value || defaultMsg;

    if (action === 'merge_commit') {
      const mergeRes = await execGit(rootPath, ['merge', '--no-ff', '-m', finalMsg, wtBranch], 10000);
      if (mergeRes.ok) {
        const shaRes = await execGit(rootPath, ['rev-parse', '--short', 'HEAD']);
        invalidateWorktreeCache(rootPath);
        return {
          ok: true,
          httpStatus: 200,
          payload: {
            ok: true,
            action,
            status: 'merged',
            result: { branch: wtBranch, target, sha: shaRes.stdout.trim(), stdout: mergeRes.stdout.trim() },
            message: `Merged ${wtBranch} into ${target}`,
          },
        };
      }
      return abortAndFailConflict({
        cwd: rootPath,
        rootPath,
        abortCmd: ['merge', '--abort'],
        extraReset: true,
        opRes: mergeRes,
        label: 'Merge',
        fail,
      });
    }

    // squash_merge
    const squashRes = await execGit(rootPath, ['merge', '--squash', wtBranch], 10000);
    if (!squashRes.ok) {
      return abortAndFailConflict({
        cwd: rootPath,
        rootPath,
        abortCmd: ['reset', '--merge'],
        opRes: squashRes,
        label: 'Squash merge',
        fail,
      });
    }

    const stagedCheck = await execGit(rootPath, ['diff', '--cached', '--quiet']);
    if (stagedCheck.ok) {
      await execGit(rootPath, ['reset', '--merge'], 5000);
      invalidateWorktreeCache(rootPath);
      return fail(409, 'nothing_to_commit', `Squash merge of '${wtBranch}' produced no net changes against '${target}'`);
    }

    const commitRes = await execGit(rootPath, ['commit', '-m', finalMsg], 10000);
    if (!commitRes.ok) {
      await execGit(rootPath, ['reset', '--merge'], 5000);
      invalidateWorktreeCache(rootPath);
      return fail(409, 'error', (commitRes.stderr || commitRes.error || 'Squash commit failed and was rolled back').trim());
    }
    const shaRes = await execGit(rootPath, ['rev-parse', '--short', 'HEAD']);
    invalidateWorktreeCache(rootPath);
    return {
      ok: true,
      httpStatus: 200,
      payload: {
        ok: true,
        action,
        status: 'merged',
        result: { branch: wtBranch, target, sha: shaRes.stdout.trim(), stdout: commitRes.stdout.trim() },
        message: `Squash-merged ${wtBranch} into ${target}`,
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
    return abortAndFailConflict({
      cwd: wtPath,
      rootPath,
      abortCmd: ['rebase', '--abort'],
      opRes: rebaseRes,
      label: 'Rebase',
      fail,
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
