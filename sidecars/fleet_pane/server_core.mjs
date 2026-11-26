/**
 * Fleet Antigravity Sidecar + Standalone HTTP Backend.
 *
 * Dual runtime:
 * 1. Inside Antigravity (`ANTIGRAVITY_SIDECAR_WEB_PORT` set & not `FLEET_STANDALONE=1`):
 *    registers routes on `SidecarApp` from `sidecar_sdk`.
 * 2. Standalone loopback mode (CLI flags `--port <n>`, `--app-data-dir <dir>`,
 *    `PORT`, or `FLEET_STANDALONE=1`): serves pre-compressed gzip + ETag/304 UI,
 *    pre-serialized/pre-gzipped cached JSON snapshots, security headers,
 *    Host loopback-403 check, prompt 413 payload enforcement, and `/preload.js`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '1';
}

let zlibMod = null;
let zlibPromise = null;
const ensureZlib = () => (zlibMod ? Promise.resolve(zlibMod) : (zlibPromise ||= import('node:zlib').then((m) => (zlibMod = m))));

let gitProbeMod = null;
const getGitProbe = () => (gitProbeMod ||= import('./git_probe.mjs'));

let storeMod = null;
const getStore = () => (storeMod ||= import('./swarm_store.mjs'));

const __dirname = import.meta.dirname || dirname(new URL(import.meta.url).pathname);
const SIDE_ID_RE = /^[a-z0-9._-]{3,128}$/i;
const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WORKTREE_ACTION_BYTES = 16 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-src 'none'; child-src 'none'; base-uri 'self'; form-action 'self'",
};

const STANDALONE_PRELOAD_JS = `(function(){
  var params = new URLSearchParams(window.location.search);
  var conv = params.get('conversationId') || '';
  window.sidecar = {
    conversationId: conv,
    standalone: true,
    fetch: function(path, opts) { return window.fetch(path, opts); },
    getWorkspaceUris: async function() { return []; },
    onWorkspaceChange: function() { return function() {}; },
    ui: {
      toggleConversation: function() {},
      toggleAuxPane: function() {},
      addArtifactComment: function() {}
    },
    agent: null
  };
})();`;

function fastEtag(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1 ^ buf.length;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    if (i < 4096 || (i & 3) === 0) h2 = Math.imul(h2 ^ b, 0x85ebca6b);
  }
  return `"${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}"`;
}

function loadDistAssets(distDir) {
  const indexPath = join(distDir, 'index.html');
  const indexGzPath = join(distDir, 'index.html.gz');
  let htmlRawCache = null;
  let htmlGzCache = null;
  let htmlEtagCache = '';
  let rootHdrBaseCache = null;
  let rootHdrGzCache = null;
  let rootHdrRawCache = null;

  const ensureGz = () => {
    if (htmlEtagCache) return;
    const hasIndex = existsSync(indexPath);
    const hasGz = hasIndex && existsSync(indexGzPath);
    if (hasGz) {
      htmlGzCache = readFileSync(indexGzPath);
    } else {
      htmlRawCache = hasIndex
        ? readFileSync(indexPath)
        : Buffer.from('<!doctype html><html><body><p>Fleet dist/index.html missing. Run npm run build in frontend/.</p></body></html>');
      htmlGzCache = zlibMod ? zlibMod.gzipSync(htmlRawCache, { level: 9 }) : null;
    }
    htmlEtagCache = fastEtag(htmlGzCache || htmlRawCache);
    rootHdrBaseCache = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
      ETag: htmlEtagCache,
      ...SECURITY_HEADERS,
    };
    rootHdrGzCache = htmlGzCache
      ? { ...rootHdrBaseCache, 'Content-Encoding': 'gzip', 'Content-Length': htmlGzCache.length }
      : null;
  };
  const getHtmlRaw = () => {
    ensureGz();
    if (!htmlRawCache) {
      htmlRawCache = existsSync(indexPath)
        ? readFileSync(indexPath)
        : zlibMod && htmlGzCache
          ? zlibMod.gunzipSync(htmlGzCache)
          : Buffer.from('');
    }
    if (!rootHdrRawCache) rootHdrRawCache = { ...rootHdrBaseCache, 'Content-Length': htmlRawCache.length };
    return htmlRawCache;
  };
  const getRootHdrRaw = () => {
    getHtmlRaw();
    return rootHdrRawCache;
  };

  let fontsMap = null;
  const fontsDir = join(distDir, 'fonts');
  function getFontsMap() {
    if (fontsMap) return fontsMap;
    fontsMap = new Map();
    if (existsSync(fontsDir)) {
      for (const file of readdirSync(fontsDir)) {
        if (!file.endsWith('.woff2')) continue;
        const fontPath = join(fontsDir, file);
        let loaded = null;
        const ensure = () => {
          if (!loaded) {
            const buf = readFileSync(fontPath);
            const etag = fastEtag(buf);
            const hdr304 = {
              'Content-Type': 'font/woff2',
              'Cache-Control': 'public, max-age=31536000, immutable',
              ETag: etag,
              ...SECURITY_HEADERS,
            };
            loaded = { raw: buf, etag, hdr304, hdr200: { ...hdr304, 'Content-Length': buf.length } };
          }
          return loaded;
        };
        fontsMap.set(`/fonts/${file}`, {
          get raw() { return ensure().raw; },
          get etag() { return ensure().etag; },
          get hdr304() { return ensure().hdr304; },
          get hdr200() { return ensure().hdr200; },
        });
      }
    }
    return fontsMap;
  }
  return {
    get htmlRaw() { return getHtmlRaw(); },
    getHtmlRaw,
    get htmlGzip() { ensureGz(); return htmlGzCache; },
    get htmlEtag() { ensureGz(); return htmlEtagCache; },
    get rootHdrBase() { ensureGz(); return rootHdrBaseCache; },
    get rootHdrGz() { ensureGz(); return rootHdrGzCache; },
    getRootHdrRaw,
    get fonts() { return getFontsMap(); },
  };
}

function packJsonPayload(obj, etagOverride = '') {
  const rawBuf = Buffer.from(JSON.stringify(obj));
  const etag = etagOverride || fastEtag(rawBuf);
  const hdr304 = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
    ETag: etag,
    ...SECURITY_HEADERS,
  };
  const hdrRaw = { ...hdr304, 'Content-Length': rawBuf.length };
  let gzBuf = null;
  let hdrGz = null;
  function getGzip() {
    if (rawBuf.length < 256 || !zlibMod) return null;
    if (!gzBuf) {
      gzBuf = zlibMod.gzipSync(rawBuf);
      hdrGz = { ...hdr304, 'Content-Encoding': 'gzip', 'Content-Length': gzBuf.length };
    }
    return { gz: gzBuf, hdrGz };
  }
  return {
    raw: rawBuf,
    getRaw: () => rawBuf,
    get gz() { return getGzip()?.gz || null; },
    get hdrGz() { return getGzip()?.hdrGz || null; },
    getGzip,
    etag,
    hdr304,
    hdrRaw,
  };
}

function isLoopbackHostHeader(host) {
  if (!host) return true;
  if (host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost') return true;
  const h = String(host).trim().toLowerCase();
  return (
    h === '127.0.0.1' ||
    h.startsWith('127.0.0.1:') ||
    h === 'localhost' ||
    h.startsWith('localhost:') ||
    h === '[::1]' ||
    h.startsWith('[::1]:')
  );
}

function isLoopbackOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
  } catch {
    return false;
  }
}

/** Build framework-agnostic route handlers with pre-serialized/pre-gzipped response caching. */
export function createFleetHandlers({
  store,
  assets: sharedAssets = null,
  distDir = join(__dirname, 'dist'),
  appDataDir = '',
  defaultConversationId = '',
  isSidecar = false,
  sendMessageFn = null,
} = {}) {
  const {
    ID_RE = SIDE_ID_RE,
    buildSwarmSnapshot,
    computeSwarmFingerprint,
    findAppDataDirs,
    findCoordinatorConvId,
    getSwarmMetaKeys,
    getSwarmRoster,
    listSwarms,
    oneLine,
    resolveAllowedFrame,
    resolveConversationSwarm,
    roleOf,
    unseenBy,
    validatePlanPatch,
    writeSwarmPlan,
  } = store;
  const assets = sharedAssets || loadDistAssets(distDir);
  let cachedDirs = { at: 0, dirs: null };
  const getAppDirs = () => {
    const now = Date.now();
    if (cachedDirs.dirs && now - cachedDirs.at < 1000) return cachedDirs.dirs;
    const dirs = findAppDataDirs(appDataDir);
    cachedDirs = { at: now, dirs };
    return dirs;
  };
  const pack = (obj, etagOverride = '') => packJsonPayload(obj, etagOverride);

  let healthPacked = null;
  let healthKey = '';

  const swarmPayloadCache = new Map(); // cacheKey -> { etag, packed }
  const worktreesPayloadCache = new Map(); // rootsKey -> { at, packed }
  let swarmsListCache = { at: 0, key: '', sig: '', swarms: [], packed: null };

  function getHealthPacked(sleepState = null) {
    const appDataDirs = getAppDirs();
    const idleSleep = sleepState ? Boolean(sleepState.idleSleep) : false;
    const sseCount = sleepState ? Number(sleepState.sseClients) || 0 : 0;
    const key = `${appDataDirs.join('\0')}|${isSidecar}|${Boolean(sendMessageFn)}|${defaultConversationId}|${idleSleep}|${sseCount}`;
    if (!healthPacked || healthKey !== key) {
      healthKey = key;
      healthPacked = pack({
        ok: true,
        name: 'fleet',
        version: '1.23.0',
        mode: isSidecar ? 'sidecar' : 'standalone',
        canSendMessage: Boolean(sendMessageFn),
        sseStream: !isSidecar,
        idleSleep,
        sseClients: sseCount,
        appDataDirs,
        conversationId: defaultConversationId || null,
      });
    }
    return healthPacked;
  }

  function getSwarmsEntry() {
    const appDataDirs = getAppDirs();
    const now = Date.now();
    const key = appDataDirs.join('\0');
    if (swarmsListCache.packed && swarmsListCache.key === key && now - swarmsListCache.at < 1500) {
      return swarmsListCache;
    }
    const swarms = listSwarms(appDataDirs, (appData, id, snap, keys) => {
      if (defaultConversationId && defaultConversationId !== id) return;
      const member = snap.members.find((m) => m.conversation_id === id)?.name || null;
      const cacheKey = `${id}|conversation|${isSidecar}|${Boolean(sendMessageFn)}`;
      const fullEtag = `${id}|${member || ''}|${snap.etag}`;
      const prev = swarmPayloadCache.get(cacheKey);
      if (prev && prev.fullEtag === fullEtag) {
        prev.checkedAt = now;
        return;
      }
      const packed = pack(
        {
          conversationId: id,
          swarm: id,
          member,
          resolvedFrom: 'conversation',
          ...snap,
          ...unseenBy(snap, member),
          etag: fullEtag,
          capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar, sseStream: !isSidecar },
        },
        fastEtag(fullEtag),
      );
      const unchangedPacked = pack({ conversationId: id, swarm: id, member, unchanged: true, etag: fullEtag });
      if (swarmPayloadCache.has(cacheKey)) swarmPayloadCache.delete(cacheKey);
      else if (swarmPayloadCache.size >= 1) swarmPayloadCache.delete(swarmPayloadCache.keys().next().value);
      swarmPayloadCache.set(cacheKey, {
        checkedAt: now,
        appData,
        swarm: id,
        member: member || '',
        membersKey: keys?.membersKey || '',
        boardKey: keys?.boardKey || '',
        fullEtag,
        packed,
        unchangedPacked,
      });
    });
    const sig = swarms.map((s) => `${s.id}:${s.head}:${s.triageCount}:${s.totalTokens}:${s.activeCount}`).join(',');
    if (swarmsListCache.packed && swarmsListCache.sig === sig && swarmsListCache.key === key) {
      swarmsListCache.at = now;
      return swarmsListCache;
    }
    const packed = pack({
      swarms,
      defaultConversationId: defaultConversationId || swarms[0]?.id || null,
      appDataDirs,
    });
    swarmsListCache = { at: now, key, sig, swarms, packed };
    return swarmsListCache;
  }

  const getSwarmsPacked = () => getSwarmsEntry().packed;

  function getSwarmPacked(query = {}) {
    const appDataDirs = getAppDirs();
    const requestedConv = typeof query.conversationId === 'string' ? query.conversationId.trim() : '';
    const fallbackConv = !requestedConv ? defaultConversationId : '';
    const includeRaw = query.raw === '1' || query.raw === 'true';
    let conv = requestedConv || fallbackConv;
    let resolvedFrom = 'conversation';

    if (!conv) {
      const swarmsData = getSwarmsEntry().swarms;
      if (swarmsData.length) {
        conv = swarmsData[0].id;
        resolvedFrom = 'latest';
      }
    }

    if (!conv || !ID_RE.test(conv)) {
      return pack({
        conversationId: conv || null,
        swarm: null,
        member: null,
        resolvedFrom,
        capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar },
        swarms: getSwarmsEntry().swarms,
      });
    }

    const cacheKey = `${conv}|${isSidecar}|${Boolean(sendMessageFn)}`;
    const convKey = `${conv}|conversation|${isSidecar}|${Boolean(sendMessageFn)}`;
    const now = Date.now();
    const hit = !includeRaw ? swarmPayloadCache.get(cacheKey) || swarmPayloadCache.get(convKey) : null;
    if (hit) {
      if (now - hit.checkedAt < 1000) {
        if (query.etag && query.etag === hit.fullEtag) return hit.unchangedPacked;
        return hit.packed;
      }
      const fp = computeSwarmFingerprint(hit.appData, hit.swarm);
      if (fp) {
        const candidateEtag = `${hit.swarm}|${hit.member || ''}|${fp.etag}`;
        if (candidateEtag === hit.fullEtag) {
          hit.checkedAt = now;
          hit.membersKey = fp.membersKey;
          hit.boardKey = fp.boardKey;
          if (query.etag && query.etag === hit.fullEtag) return hit.unchangedPacked;
          return hit.packed;
        }
      }
    }

    const res = resolveConversationSwarm(appDataDirs, conv);
    if (!res.swarm || !res.appData) {
      return pack({
        conversationId: conv,
        swarm: null,
        member: null,
        resolvedFrom,
        capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar },
        swarms: getSwarmsEntry().swarms,
      });
    }

    if (hit && hit.appData === res.appData && hit.swarm === res.swarm) {
      const fp = computeSwarmFingerprint(res.appData, res.swarm);
      if (fp && `${res.swarm}|${res.member || ''}|${fp.etag}` === hit.fullEtag) {
        hit.checkedAt = now;
        if (query.etag && query.etag === hit.fullEtag) return hit.unchangedPacked;
        return hit.packed;
      }
    }

    const snap = buildSwarmSnapshot(res.appData, res.swarm, { includeRaw });
    if (!snap) {
      return pack({
        conversationId: conv,
        swarm: null,
        member: null,
        resolvedFrom,
        capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar },
        swarms: getSwarmsEntry().swarms,
      });
    }

    const keys = getSwarmMetaKeys(res.appData, res.swarm);
    const etag = `${res.swarm}|${res.member || ''}|${snap.etag}`;
    if (query.etag && query.etag === etag) {
      return pack({ conversationId: conv, swarm: res.swarm, member: res.member, unchanged: true, etag });
    }

    if (hit && hit.fullEtag === etag) {
      hit.checkedAt = now;
      if (keys) {
        hit.membersKey = keys.membersKey;
        hit.boardKey = keys.boardKey;
      }
      return hit.packed;
    }

    const packed = pack(
      {
        conversationId: conv,
        swarm: res.swarm,
        member: res.member,
        resolvedFrom,
        ...snap,
        ...unseenBy(snap, res.member),
        etag,
        capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar, sseStream: !isSidecar },
      },
      fastEtag(etag),
    );
    if (!includeRaw) {
      const unchangedPacked = pack({ conversationId: conv, swarm: res.swarm, member: res.member, unchanged: true, etag });
      if (swarmPayloadCache.has(cacheKey)) swarmPayloadCache.delete(cacheKey);
      else if (swarmPayloadCache.size >= 1) swarmPayloadCache.delete(swarmPayloadCache.keys().next().value);
      swarmPayloadCache.set(cacheKey, {
        checkedAt: now,
        appData: res.appData,
        swarm: res.swarm,
        member: res.member || '',
        membersKey: keys?.membersKey || '',
        boardKey: keys?.boardKey || '',
        fullEtag: etag,
        packed,
        unchangedPacked,
      });
    }
    return packed;
  }

    function getWorktreesPackedSync(query = {}) {
      const rootsKey = typeof query.roots === 'string' ? query.roots : '';
      if (rootsKey.length > 8192) return null;
      const hit = worktreesPayloadCache.get(rootsKey);
      if (hit && Date.now() - hit.at < 3000) return hit.packed;
      return null;
    }

    async function getWorktreesPacked(query = {}) {
      const rootsKey = typeof query.roots === 'string' ? query.roots : '';
      if (rootsKey.length > 8192) {
        return pack({ roots: [], worktrees: [], collisions: [], rejected: ['roots parameter too large'], cachedTtlMs: 3000 });
      }
      const sync = getWorktreesPackedSync(query);
      if (sync) return sync;
      const now = Date.now();
      const { probeWorktrees } = await getGitProbe();
      const data = await probeWorktrees(rootsKey);
      const packed = pack(data);
      if (worktreesPayloadCache.has(rootsKey)) worktreesPayloadCache.delete(rootsKey);
      else if (worktreesPayloadCache.size >= 1) worktreesPayloadCache.delete(worktreesPayloadCache.keys().next().value);
      worktreesPayloadCache.set(rootsKey, { at: now, packed });
      return packed;
    }

  async function getWorktreeDiff(query = {}) {
    const { probeWorktreeDiff } = await getGitProbe();
    const res = await probeWorktreeDiff({
      root: typeof query.root === 'string' ? query.root : '',
      worktree: typeof query.worktree === 'string' ? query.worktree : '',
      path: typeof query.path === 'string' ? query.path : '',
      file: typeof query.file === 'string' ? query.file : '',
      mode: typeof query.mode === 'string' ? query.mode : 'working',
      maxBytes: Number(query.maxBytes) || 8192,
    });
    return { status: res.status || (res.ok ? 200 : 400), packed: pack(res) };
  }

  async function postWorktreeAction(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, json: { ok: false, error: 'JSON object body required' } };
    }
    if (body.confirm === false) {
      return { status: 400, json: { ok: false, error: 'Confirmation required' } };
    }
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    if (!action) {
      return { status: 400, json: { ok: false, error: 'action is required' } };
    }
    const rawPath = typeof body.path === 'string' ? body.path : typeof body.worktree === 'string' ? body.worktree : '';
    if (!rawPath.trim()) {
      return { status: 400, json: { ok: false, action, error: 'worktree path is required' } };
    }
    if (body.root !== undefined && typeof body.root !== 'string') {
      return { status: 400, json: { ok: false, action, error: 'root must be a string' } };
    }
    if (body.targetBranch !== undefined && typeof body.targetBranch !== 'string') {
      return { status: 400, json: { ok: false, action, error: 'targetBranch must be a string' } };
    }
    if (body.deleteBranch !== undefined && typeof body.deleteBranch !== 'boolean') {
      return { status: 400, json: { ok: false, action, error: 'deleteBranch must be a boolean' } };
    }

    const { executeWorktreeAction } = await getGitProbe();
    const res = await executeWorktreeAction({
      action,
      root: typeof body.root === 'string' ? body.root : '',
      path: typeof body.path === 'string' ? body.path : '',
      worktree: typeof body.worktree === 'string' ? body.worktree : '',
      targetBranch: typeof body.targetBranch === 'string' ? body.targetBranch : '',
      deleteBranch: body.deleteBranch === true,
    });
    worktreesPayloadCache.clear();
    return { status: res.httpStatus, json: res.payload };
  }

  function getFrame(query = {}) {
    const appDataDirs = getAppDirs();
    let conv = typeof query.conversationId === 'string' && query.conversationId.trim() ? query.conversationId.trim() : defaultConversationId;
    if (!conv) {
      const available = listSwarms(appDataDirs);
      if (available.length) conv = available[0].id;
    }
    const targetPath = typeof query.path === 'string' ? query.path : '';
    if (!conv || !ID_RE.test(conv) || !targetPath) {
      return { status: 404, contentType: 'text/plain', body: 'not found' };
    }
    const resolved = resolveConversationSwarm(appDataDirs, conv);
    if (!resolved.swarm || !resolved.appData) {
      return { status: 404, contentType: 'text/plain', body: 'not found' };
    }
    const frame = resolveAllowedFrame(resolved.appData, resolved.swarm, targetPath);
    if (!frame) {
      return { status: 404, contentType: 'text/plain', body: 'not found' };
    }
    try {
      return {
        status: 200,
        contentType: frame.contentType,
        body: readFileSync(frame.real),
        headers: { 'Cache-Control': 'private, max-age=3600', ...SECURITY_HEADERS },
      };
    } catch {
      return { status: 404, contentType: 'text/plain', body: 'not found' };
    }
  }

  async function postNudge(body = {}) {
    if (!body || body.confirm !== true) {
      return { status: 400, json: { error: 'Confirmation required (confirm: true)' } };
    }
    const rawMsg = typeof body.message === 'string' ? body.message : '';
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawMsg)) {
      return { status: 400, json: { error: 'Control characters are not permitted in nudge message' } };
    }
    const message = rawMsg.trim();
    if (!message || message.length > 4000) {
      return { status: 400, json: { error: 'Non-empty message (<= 4000 chars) required' } };
    }
    const rawIds = Array.isArray(body.conversationIds) ? body.conversationIds : null;
    if (rawIds) {
      if (rawIds.length === 0 || rawIds.length > 24) {
        return { status: 400, json: { error: 'Between 1 and 24 target conversationIds required' } };
      }
      const targets = [];
      const seen = new Set();
      for (const item of rawIds) {
        const id = typeof item === 'string' ? item.trim() : '';
        if (!id || !ID_RE.test(id)) {
          return { status: 400, json: { error: 'Valid target conversationIds required' } };
        }
        if (!seen.has(id)) {
          seen.add(id);
          targets.push(id);
        }
      }
      if (!sendMessageFn) {
        return {
          status: 501,
          json: { error: 'Direct agent broadcast requires live Antigravity sidecar runtime' },
        };
      }
      const results = [];
      for (const id of targets) {
        results.push(await sendMessageFn(id, message));
      }
      return { status: 200, json: { ok: true, delivered: targets.length, results } };
    }
    const targetConv = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!targetConv || !ID_RE.test(targetConv)) {
      return { status: 400, json: { error: 'Valid target conversationId required' } };
    }
    if (!sendMessageFn) {
      return {
        status: 501,
        json: { error: 'Direct agent nudge requires live Antigravity sidecar runtime' },
      };
    }
    const result = await sendMessageFn(targetConv, message);
    return { status: 200, json: { ok: true, result } };
  }

  function invalidateSwarmPayloadCache(swarmId) {
    for (const [k, entry] of swarmPayloadCache.entries()) {
      if (entry?.swarm === swarmId) swarmPayloadCache.delete(k);
    }
    swarmsListCache = { at: 0, key: '', sig: '', swarms: [], packed: null };
  }

  async function postPlan(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) {
      return { status: 400, json: { error: 'Confirmation required (confirm: true)' } };
    }
    const conv = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!conv || !ID_RE.test(conv)) {
      return { status: 400, json: { error: 'Valid conversationId required' } };
    }
    if (body.ifMatch !== undefined && typeof body.ifMatch !== 'string') {
      return { status: 400, json: { error: 'ifMatch must be a string' } };
    }
    const ifMatch = typeof body.ifMatch === 'string' ? body.ifMatch.trim() : '';
    if (SINGLE_LINE_CTRL_RE.test(ifMatch)) {
      return { status: 400, json: { error: 'Control characters are not permitted in ifMatch' } };
    }
    const mode = body.mode === undefined ? 'patch' : body.mode;
    if (mode !== 'patch' && mode !== 'replace') {
      return { status: 400, json: { error: 'mode must be "patch" or "replace"' } };
    }
    if (body.notifyCoordinator !== undefined && typeof body.notifyCoordinator !== 'boolean') {
      return { status: 400, json: { error: 'notifyCoordinator must be a boolean' } };
    }
    if (validatePlanPatch) {
      const valid = validatePlanPatch(body.patch);
      if (!valid.ok) return { status: valid.status || 400, json: { error: valid.error } };
    }

    const appDataDirs = getAppDirs();
    const res = resolveConversationSwarm(appDataDirs, conv);
    if (!res.swarm || !res.appData) {
      return { status: 404, json: { error: 'Swarm not found' } };
    }

    const written = writeSwarmPlan(res.appData, res.swarm, {
      ifMatch,
      mode,
      patch: body.patch,
    });
    if (!written.ok) {
      if (written.status === 409) {
        invalidateSwarmPayloadCache(res.swarm);
        return {
          status: 409,
          json: {
            error: written.error || 'plan changed on disk',
            plan: written.plan || null,
            etag: written.etag || written.plan?.etag || '',
          },
        };
      }
      return { status: written.status || 400, json: { error: written.error || 'Failed to write plan' } };
    }

    invalidateSwarmPayloadCache(res.swarm);

    let notified = false;
    if (body.notifyCoordinator === true && sendMessageFn) {
      const coordId = (findCoordinatorConvId ? findCoordinatorConvId(res.appData, res.swarm) : null) || res.swarm;
      if (coordId) {
        try {
          const summaryRaw = written.plan?.title || written.plan?.goal || 'plan.json';
          const summary = oneLine ? oneLine(summaryRaw, 180) : String(summaryRaw).slice(0, 180);
          await sendMessageFn(
            coordId,
            `[fleet-plan-updated] Plan updated (${written.plan?.schema || 'fleet'}, etag ${written.etag}): ${summary}`,
          );
          notified = true;
        } catch {
          notified = false;
        }
      }
    }

    return {
      status: 200,
      json: {
        ok: true,
        plan: written.plan,
        etag: written.etag,
        notified,
      },
    };
  }

  const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
  const SINGLE_LINE_CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
  const WORKER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
  const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
  const MEMBER_REF_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  const RESERVED_WORKERS = new Set(['all', 'coordinator', 'here']);
  const RESERVED_MEMBER_REFS = new Set(['all', 'here', '__proto__', 'constructor', 'prototype']);
  const RESERVED_CHANNELS = new Set(['main', 'all', 'here']);
  const PROTECTED_ROLES = new Set(['coordinator', 'narrator', 'monitor']);
  const PROTECTED_NAME_RE = /^(?:coordinator|narrator|monitor)(?:-\d+)?$/i;
  const COORDINATOR_NAME_RE = /^coordinator(?:-\d+)?$/i;
  const MAX_SEQ_INT = 1_000_000_000;
  const WORKSPACE_MODES = new Set(['inherit', 'share', 'branch']);
  const CHANNEL_ACTIONS = new Set(['create', 'archive', 'subscribe', 'unsubscribe']);
  const GATE_VERDICTS = new Set(['verified', 'blocked', 'ship']);
  const CONTROL_OPS = new Set(['board_post', 'spawn_worker', 'switch_model', 'kill_worker', 'channel_op', 'gate_verdict']);

  function checkControlString(val, field, { required = false, maxLen = 4000, singleLine = false } = {}) {
    if (val === undefined || val === null) {
      return required ? { ok: false, error: `${field} is required` } : { ok: true, value: '' };
    }
    if (typeof val !== 'string') {
      return { ok: false, error: `${field} must be a string` };
    }
    if ((singleLine ? SINGLE_LINE_CTRL_RE : CTRL_RE).test(val)) {
      return { ok: false, error: `Control characters are not permitted in ${field}` };
    }
    if (val.length > maxLen) {
      return { ok: false, error: `${field} exceeds maximum length (${maxLen})` };
    }
    const trimmed = val.trim();
    if (required && !trimmed) {
      return { ok: false, error: `${field} is required` };
    }
    return { ok: true, value: trimmed };
  }

  async function postControl(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) {
      return { status: 400, json: { error: 'Confirmation required (confirm: true)' } };
    }
    const convCheck = checkControlString(body.conversationId, 'conversationId', { required: true, maxLen: 128, singleLine: true });
    if (!convCheck.ok || !ID_RE.test(convCheck.value)) {
      return { status: 400, json: { error: 'Valid conversationId required' } };
    }
    const conv = convCheck.value;
    const op = typeof body.op === 'string' ? body.op.trim() : '';
    if (!CONTROL_OPS.has(op)) {
      return { status: 400, json: { error: 'Unsupported control op' } };
    }

    const bad = (error) => ({ status: 400, json: { error } });
    const inlineClean = (s, max = 160) => (oneLine ? oneLine(s, max) : String(s).replace(/\s+/g, ' ').trim().slice(0, max));

    let directive = '';
    let killTarget = '';
    let forceUnmerged = false;

    if (op === 'board_post') {
      const textChk = checkControlString(body.text, 'text', { required: true, maxLen: 4000 });
      if (!textChk.ok) return bad(textChk.error);
      const chanChk = checkControlString(body.channel, 'channel', { required: false, maxLen: 64, singleLine: true });
      if (!chanChk.ok) return bad(chanChk.error);
      let channel = chanChk.value;
      if (channel && channel !== 'main') {
        if (!CHANNEL_NAME_RE.test(channel) || RESERVED_CHANNELS.has(channel)) {
          return bad('Invalid channel name');
        }
      } else {
        channel = 'main';
      }
      let replyToSeq = 0;
      if (body.replyToSeq !== undefined && body.replyToSeq !== null) {
        if (typeof body.replyToSeq !== 'number' || !Number.isSafeInteger(body.replyToSeq) || body.replyToSeq <= 0 || body.replyToSeq > MAX_SEQ_INT) {
          return bad('replyToSeq must be a positive integer');
        }
        replyToSeq = body.replyToSeq;
      }
      const header = `[fleet-operator:board_post] channel=#${channel}${replyToSeq ? ` replyTo=#${replyToSeq}` : ''}`;
      const bodyLine = replyToSeq && !textChk.value.includes(`#${replyToSeq}`)
        ? `Re #${replyToSeq}: ${textChk.value}`
        : textChk.value;
      directive = `${header}\nPost on the swarm board${channel !== 'main' ? ` in #${channel}` : ''}:\n${bodyLine}`;
    } else if (op === 'spawn_worker') {
      const nameChk = checkControlString(body.name, 'name', { required: true, maxLen: 64, singleLine: true });
      if (!nameChk.ok) return bad(nameChk.error);
      const name = nameChk.value;
      if (!WORKER_NAME_RE.test(name) || RESERVED_WORKERS.has(name) || name.startsWith('coordinator-')) {
        return bad('Invalid worker name');
      }
      const briefChk = checkControlString(body.brief, 'brief', { required: true, maxLen: 4000 });
      if (!briefChk.ok) return bad(briefChk.error);
      const workspaceMode = body.workspaceMode === undefined || body.workspaceMode === null ? 'inherit' : body.workspaceMode;
      if (typeof workspaceMode !== 'string' || !WORKSPACE_MODES.has(workspaceMode)) {
        return bad('workspaceMode must be inherit, share, or branch');
      }
      const chanChk = checkControlString(body.channel, 'channel', { required: false, maxLen: 64, singleLine: true });
      if (!chanChk.ok) return bad(chanChk.error);
      const channel = chanChk.value;
      if (channel && (!CHANNEL_NAME_RE.test(channel) || RESERVED_CHANNELS.has(channel))) {
        return bad('Invalid channel name');
      }
      const modelChk = checkControlString(body.model, 'model', { required: false, maxLen: 256, singleLine: true });
      if (!modelChk.ok) return bad(modelChk.error);
      const forkChk = checkControlString(body.forkFrom, 'forkFrom', { required: false, maxLen: 128, singleLine: true });
      if (!forkChk.ok) return bad(forkChk.error);
      if (forkChk.value && ((!MEMBER_REF_RE.test(forkChk.value) && !ID_RE.test(forkChk.value)) || RESERVED_MEMBER_REFS.has(forkChk.value.toLowerCase()))) {
        return bad('Invalid forkFrom member');
      }
      const header = `[fleet-operator:spawn_worker] name=${name} workspace=${workspaceMode}${channel ? ` channel=#${channel}` : ''}${modelChk.value ? ` model=${modelChk.value}` : ''}${forkChk.value ? ` forkFrom=${forkChk.value}` : ''}`;
      directive = `${header}\nSpawn worker ${name} via swarm(action:"add", name:${JSON.stringify(name)}, workspace:${JSON.stringify(workspaceMode)}${modelChk.value ? `, model:${JSON.stringify(modelChk.value)}` : ''}${forkChk.value ? `, fork:${JSON.stringify(forkChk.value)}` : ''}) with brief:\n${briefChk.value}`;
    } else if (op === 'switch_model') {
      const memChk = checkControlString(body.member, 'member', { required: true, maxLen: 64, singleLine: true });
      if (!memChk.ok || !MEMBER_REF_RE.test(memChk.value) || RESERVED_MEMBER_REFS.has(memChk.value.toLowerCase())) {
        return bad(memChk.ok ? 'Invalid member name' : memChk.error);
      }
      const modelChk = checkControlString(body.model, 'model', { required: true, maxLen: 256, singleLine: true });
      if (!modelChk.ok) return bad(modelChk.error);
      const reasonChk = checkControlString(body.reason, 'reason', { required: false, maxLen: 4000, singleLine: true });
      if (!reasonChk.ok) return bad(reasonChk.error);
      const header = `[fleet-operator:switch_model] member=${memChk.value} model=${modelChk.value}${reasonChk.value ? ` reason=${inlineClean(reasonChk.value, 160)}` : ''}`;
      directive = `${header}\nSwitch @${memChk.value} to model ${modelChk.value} via swarm(action:"model", name:${JSON.stringify(memChk.value)}, model:${JSON.stringify(modelChk.value)})${reasonChk.value ? `. Reason: ${reasonChk.value}` : '.'}`;
    } else if (op === 'kill_worker') {
      const memChk = checkControlString(body.member, 'member', { required: true, maxLen: 64, singleLine: true });
      if (!memChk.ok || !MEMBER_REF_RE.test(memChk.value) || RESERVED_MEMBER_REFS.has(memChk.value.toLowerCase())) {
        return bad(memChk.ok ? 'Invalid member name' : memChk.error);
      }
      if (body.forceUnmerged !== undefined && typeof body.forceUnmerged !== 'boolean') {
        return bad('forceUnmerged must be a boolean');
      }
      const reasonChk = checkControlString(body.reason, 'reason', { required: false, maxLen: 4000, singleLine: true });
      if (!reasonChk.ok) return bad(reasonChk.error);
      killTarget = memChk.value;
      forceUnmerged = body.forceUnmerged === true;
      const header = `[fleet-operator:kill_worker] member=${killTarget} forceUnmerged=${forceUnmerged}${reasonChk.value ? ` reason=${inlineClean(reasonChk.value, 160)}` : ''}`;
      directive = `${header}\nKill worker @${killTarget} via swarm(action:"kill", name:${JSON.stringify(killTarget)})${forceUnmerged ? ' (operator confirmed forceUnmerged=true)' : ''}${reasonChk.value ? `. Reason: ${reasonChk.value}` : '.'}`;
    } else if (op === 'channel_op') {
      const action = typeof body.action === 'string' ? body.action.trim() : '';
      if (!CHANNEL_ACTIONS.has(action)) {
        return bad('action must be create, archive, subscribe, or unsubscribe');
      }
      const chanChk = checkControlString(body.channel, 'channel', { required: true, maxLen: 64, singleLine: true });
      if (!chanChk.ok) return bad(chanChk.error);
      const channel = chanChk.value;
      if (!CHANNEL_NAME_RE.test(channel) || RESERVED_CHANNELS.has(channel)) {
        return bad('Invalid channel name');
      }
      const topicChk = checkControlString(body.topic, 'topic', { required: false, maxLen: 4000, singleLine: true });
      if (!topicChk.ok) return bad(topicChk.error);
      const needsMember = action === 'subscribe' || action === 'unsubscribe';
      const memChk = checkControlString(body.member, 'member', { required: needsMember, maxLen: 64, singleLine: true });
      if (!memChk.ok) return bad(memChk.error);
      if (memChk.value && (!MEMBER_REF_RE.test(memChk.value) || RESERVED_MEMBER_REFS.has(memChk.value.toLowerCase()))) {
        return bad('Invalid member name');
      }
      const header = `[fleet-operator:channel_op] action=${action} channel=#${channel}${memChk.value ? ` member=${memChk.value}` : ''}${topicChk.value ? ` topic=${inlineClean(topicChk.value, 160)}` : ''}`;
      directive = `${header}\nRun channel operation ${action} on #${channel}${memChk.value ? ` for @${memChk.value}` : ''}${topicChk.value ? ` with topic ${JSON.stringify(topicChk.value)}` : ''}.`;
    } else if (op === 'gate_verdict') {
      const verdict = typeof body.verdict === 'string' ? body.verdict.trim() : '';
      if (!GATE_VERDICTS.has(verdict)) {
        return bad('verdict must be verified, blocked, or ship');
      }
      if (typeof body.seq !== 'number' || !Number.isSafeInteger(body.seq) || body.seq <= 0 || body.seq > MAX_SEQ_INT) {
        return bad('seq must be a positive integer');
      }
      const targetChk = checkControlString(body.targetMember, 'targetMember', { required: false, maxLen: 64, singleLine: true });
      if (!targetChk.ok) return bad(targetChk.error);
      if (targetChk.value && (!MEMBER_REF_RE.test(targetChk.value) || RESERVED_MEMBER_REFS.has(targetChk.value.toLowerCase()))) {
        return bad('Invalid targetMember name');
      }
      const noteChk = checkControlString(body.note, 'note', { required: true, maxLen: 4000 });
      if (!noteChk.ok) return bad(noteChk.error);
      const header = `[fleet-operator:gate_verdict] verdict=${verdict} seq=#${body.seq}${targetChk.value ? ` targetMember=${targetChk.value}` : ''}`;
      directive = `${header}\nOperator gate verdict [${verdict}] on #${body.seq}${targetChk.value ? ` for @${targetChk.value}` : ''}:\n${noteChk.value}`;
    }

    const appDataDirs = getAppDirs();
    const res = resolveConversationSwarm(appDataDirs, conv);
    if (!res.swarm || !res.appData) {
      return { status: 404, json: { error: 'Swarm not found' } };
    }
    const roster = getSwarmRoster ? getSwarmRoster(res.appData, res.swarm) : null;
    const coordinatorId = findCoordinatorConvId
      ? findCoordinatorConvId(roster || res.appData, roster ? '' : res.swarm)
      : null;
    if (!coordinatorId) {
      return { status: 404, json: { error: 'Coordinator conversation not found' } };
    }

    if (op === 'kill_worker') {
      const membersMap = roster?.members && typeof roster.members === 'object' ? roster.members : null;
      const memberObj = membersMap && Object.hasOwn(membersMap, killTarget) ? membersMap[killTarget] : null;
      const targetRole = roleOf ? roleOf(killTarget, memberObj) : (memberObj?.role || '');
      if (targetRole === 'coordinator' || COORDINATOR_NAME_RE.test(killTarget)) {
        return bad(`Refusing to kill coordinator role "${killTarget}"`);
      }
      const isProtected = PROTECTED_ROLES.has(targetRole) || PROTECTED_NAME_RE.test(killTarget);
      const explicitProtected = body.explicit === true || body.allowProtected === true || body.forceProtected === true;
      if (isProtected && !explicitProtected) {
        return bad(`Refusing to kill protected role "${killTarget}" without explicit confirmation`);
      }
      if (membersMap && !memberObj) {
        return { status: 404, json: { error: `Member "${killTarget}" not found in swarm` } };
      }
      if (memberObj?.killed) {
        return { status: 409, json: { error: `Member "${killTarget}" is already killed` } };
      }
      if (memberObj?.workspace && memberObj.workspace_mode !== 'inherit' && !forceUnmerged) {
        const { probeMemberWorktree } = await getGitProbe();
        const probe = await probeMemberWorktree(memberObj.workspace);
        if (probe.ok && (probe.dirtyFiles > 0 || probe.ahead > 0)) {
          return {
            status: 409,
            json: {
              error: 'unmerged worktree',
              dirtyFiles: probe.dirtyFiles,
              ahead: probe.ahead,
            },
          };
        }
      }
    }

    if (!sendMessageFn) {
      return {
        status: 501,
        json: { error: 'Swarm control requires live Antigravity sidecar runtime' },
      };
    }

    await sendMessageFn(coordinatorId, directive);
    const deliveredAt = new Date().toISOString();
    return {
      status: 200,
      json: {
        ok: true,
        op,
        coordinatorId,
        directivePreview: inlineClean(directive, 240),
        deliveredAt,
      },
    };
  }

  function resolveStreamTarget(query = {}) {
    const appDataDirs = getAppDirs();
    const requestedConv = typeof query.conversationId === 'string' ? query.conversationId.trim() : '';
    let conv = requestedConv || defaultConversationId;
    if (!conv) {
      const swarmsData = getSwarmsEntry().swarms;
      if (swarmsData.length) conv = swarmsData[0].id;
    }
    if (!conv || !ID_RE.test(conv)) return null;
    const res = resolveConversationSwarm(appDataDirs, conv);
    if (!res.swarm || !res.appData) return null;
    const fp = computeSwarmFingerprint(res.appData, res.swarm);
    return {
      conversationId: conv,
      appData: res.appData,
      swarm: res.swarm,
      member: res.member || '',
      etag: fp ? `${res.swarm}|${res.member || ''}|${fp.etag}` : '',
    };
  }

  return {
    assets,
    computeSwarmFingerprint,
    getHealthPacked,
    getSwarmsPacked,
    getSwarmPacked,
    getWorktreesPackedSync,
    getWorktreesPacked,
    getWorktreeDiff,
    getFrame,
    postNudge,
    postPlan,
    postControl,
    postWorktreeAction,
    resolveStreamTarget,
  };
}

/** Create standalone HTTP request router with gzip, ETag/304, Host-403, and SSE stream support. */
export async function createStandaloneRouter({
  distDir = join(__dirname, 'dist'),
  appDataDir = '',
  defaultConversationId = '',
  sendMessageFn = null,
  deferStore = false,
} = {}) {
  const assets = loadDistAssets(distDir);
  let handlers = null;
  let handlersPromise = null;
  const ensureHandlers = () =>
    (handlersPromise ||= Promise.all([getStore(), ensureZlib()]).then(([store]) => {
      handlers = createFleetHandlers({
        store,
        assets,
        distDir,
        appDataDir,
        defaultConversationId,
        isSidecar: false,
        sendMessageFn,
      });
      return handlers;
    }));
  if (!deferStore) await ensureHandlers();

  const bootDirs = appDataDir ? [appDataDir] : process.env.FLEET_APP_DATA_DIR ? [process.env.FLEET_APP_DATA_DIR] : [];
  let quickHealthAwake = null;
  let quickHealthSleep = null;
  const getQuickHealthPacked = () => {
    const cached = idleSleep ? quickHealthSleep : quickHealthAwake;
    if (cached && sseClients.size === (idleSleep ? 0 : sseClients.size)) {
      if (idleSleep || sseClients.size === 0) return cached;
    }
    const packed = packJsonPayload({
      ok: true,
      name: 'fleet',
      version: '1.23.0',
      mode: 'standalone',
      canSendMessage: Boolean(sendMessageFn),
      sseStream: true,
      idleSleep,
      sseClients: sseClients.size,
      appDataDirs: bootDirs,
      conversationId: defaultConversationId || null,
    });
    if (idleSleep && sseClients.size === 0) quickHealthSleep = packed;
    else if (!idleSleep && sseClients.size === 0) quickHealthAwake = packed;
    return packed;
  };

  let preloadBuf = null;
  let preloadHdrs = null;
  const MAX_SSE_CLIENTS = 64;
  const SSE_POLL_MS = 150;
  const SSE_PING_MS = 15000;
  const sseClients = new Set();
  let sseTimer = null;
  let idleSleep = true;

  function stopSseTimerIfIdle() {
    if (sseClients.size === 0) {
      if (sseTimer) {
        clearInterval(sseTimer);
        sseTimer = null;
      }
      idleSleep = true;
    }
  }

  function wakeFromIdle() {
    idleSleep = false;
  }

  function ensureSseTimer() {
    if (sseTimer || sseClients.size === 0) return;
    idleSleep = false;
    sseTimer = setInterval(() => {
      if (sseClients.size === 0) {
        stopSseTimerIfIdle();
        return;
      }
      const now = Date.now();
      const fpCache = new Map();
      for (const client of sseClients) {
        if (client.res.writableEnded || client.res.destroyed) {
          sseClients.delete(client);
          continue;
        }
        const key = `${client.appData}\0${client.swarm}`;
        let fp = fpCache.get(key);
        if (fp === undefined) {
          fp = handlers?.computeSwarmFingerprint ? handlers.computeSwarmFingerprint(client.appData, client.swarm) : null;
          fpCache.set(key, fp);
        }
        if (fp) {
          const nextEtag = `${client.swarm}|${client.member}|${fp.etag}`;
          if (nextEtag !== client.lastEtag) {
            client.lastEtag = nextEtag;
            client.lastPingAt = now;
            const payload = JSON.stringify({
              conversationId: client.conversationId,
              swarm: client.swarm,
              etag: nextEtag,
            });
            try {
              client.res.write(`event: swarm\ndata: ${payload}\n\n`);
            } catch {
              sseClients.delete(client);
            }
            continue;
          }
        }
        if (now - client.lastPingAt >= SSE_PING_MS) {
          client.lastPingAt = now;
          try {
            client.res.write(`event: ping\ndata: {"ts":${now}}\n\n`);
          } catch {
            sseClients.delete(client);
          }
        }
      }
      stopSseTimerIfIdle();
    }, SSE_POLL_MS);
    sseTimer.unref();
  }

  function getPreload() {
    if (!preloadBuf) {
      preloadBuf = Buffer.from(STANDALONE_PRELOAD_JS);
      preloadHdrs = {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': preloadBuf.length,
        ...SECURITY_HEADERS,
      };
    }
    return { buf: preloadBuf, headers: preloadHdrs };
  }

  function sendPacked(req, res, status, packed) {
    if (status === 200 && req.headers['if-none-match'] === packed.etag) {
      res.writeHead(304, packed.hdr304);
      res.end();
      return;
    }
    const ae = req.headers['accept-encoding'];
    if (typeof ae === 'string' && ae.includes('gzip')) {
      const gzEntry = packed.getGzip ? packed.getGzip() : packed.gz ? { gz: packed.gz, hdrGz: packed.hdrGz } : null;
      if (gzEntry) {
        res.writeHead(status, gzEntry.hdrGz);
        res.end(gzEntry.gz);
        return;
      }
    }
    const raw = packed.getRaw ? packed.getRaw() : packed.raw;
    res.writeHead(status, packed.hdrRaw);
    res.end(raw);
  }

  function parseQueryFast(search) {
    if (!search || search.length <= 1) return {};
    if (search.indexOf('&') === -1) {
      const eq = search.indexOf('=');
      if (eq > 1) {
        const k = search.slice(1, eq);
        const v = search.slice(eq + 1);
        if (k.indexOf('%') === -1 && v.indexOf('%') === -1 && v.indexOf('+') === -1) {
          return { [k]: v };
        }
        try {
          return { [decodeURIComponent(k.replace(/\+/g, ' '))]: decodeURIComponent(v.replace(/\+/g, ' ')) };
        } catch {}
      }
    }
    const out = {};
    const sp = new URLSearchParams(search);
    for (const [k, v] of sp) out[k] = v;
    return out;
  }

  function handleRequest(req, res) {
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }

    const rawUrl = req.url || '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const search = qIdx === -1 ? '' : rawUrl.slice(qIdx);

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (req.headers['if-none-match'] === assets.htmlEtag) {
        res.writeHead(304, assets.rootHdrBase);
        res.end();
        return;
      }
      const ae = req.headers['accept-encoding'];
      if (typeof ae === 'string' && ae.includes('gzip') && assets.rootHdrGz && assets.htmlGzip) {
        res.writeHead(200, assets.rootHdrGz);
        res.end(assets.htmlGzip);
        return;
      }
      const rawHtml = assets.getHtmlRaw();
      res.writeHead(200, assets.getRootHdrRaw());
      res.end(rawHtml);
      return;
    }

    if (req.method === 'GET' && pathname === '/preload.js') {
      const p = getPreload();
      res.writeHead(200, p.headers);
      res.end(p.buf);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/fonts/') && assets.fonts.has(pathname)) {
      const font = assets.fonts.get(pathname);
      if (req.headers['if-none-match'] === font.etag) {
        res.writeHead(304, font.hdr304);
        res.end();
        return;
      }
      res.writeHead(200, font.hdr200);
      res.end(font.raw);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const sleepState = { idleSleep, sseClients: sseClients.size };
      return sendPacked(req, res, 200, handlers ? handlers.getHealthPacked(sleepState) : getQuickHealthPacked());
    }

    const withHandlers = (fn) => {
      wakeFromIdle();
      if (handlers) return fn(handlers);
      ensureHandlers().then(fn, (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      });
    };

    if (req.method === 'GET' && pathname === '/api/swarms') {
      return withHandlers((h) => sendPacked(req, res, 200, h.getSwarmsPacked()));
    }
    if (req.method === 'GET' && pathname === '/api/swarm') {
      const q = parseQueryFast(search);
      return withHandlers((h) => sendPacked(req, res, 200, h.getSwarmPacked(q)));
    }
    if (req.method === 'GET' && pathname === '/api/swarm/stream') {
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'too many stream clients' }));
        return;
      }
      const q = parseQueryFast(search);
      return withHandlers((h) => {
        const target = h.resolveStreamTarget(q);
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
          res.end(JSON.stringify({ error: 'swarm not found' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...SECURITY_HEADERS,
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const client = {
          req,
          res,
          conversationId: target.conversationId,
          appData: target.appData,
          swarm: target.swarm,
          member: target.member,
          lastEtag: target.etag,
          lastPingAt: Date.now(),
        };
        sseClients.add(client);
        res.write(
          `: connected\nevent: swarm\ndata: ${JSON.stringify({
            conversationId: target.conversationId,
            swarm: target.swarm,
            etag: target.etag,
          })}\n\n`,
        );
        ensureSseTimer();
        const cleanup = () => {
          sseClients.delete(client);
          stopSseTimerIfIdle();
        };
        req.on('close', cleanup);
        res.on('error', cleanup);
      });
    }
    if (req.method === 'GET' && pathname === '/api/worktrees') {
      const q = parseQueryFast(search);
      if (handlers) {
        const sync = handlers.getWorktreesPackedSync(q);
        if (sync) return sendPacked(req, res, 200, sync);
      }
      return withHandlers((h) => h.getWorktreesPacked(q).then((packed) => sendPacked(req, res, 200, packed)));
    }
    if (req.method === 'GET' && pathname === '/api/worktrees/diff') {
      const q = parseQueryFast(search);
      return withHandlers((h) => h.getWorktreeDiff(q).then((out) => sendPacked(req, res, out.status, out.packed)));
    }
    if (req.method === 'GET' && pathname === '/api/frame') {
      const q = parseQueryFast(search);
      return withHandlers((h) => {
        const out = h.getFrame(q);
        const buf = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body));
        res.writeHead(out.status, { 'Content-Type': out.contentType, 'Content-Length': buf.length, ...(out.headers || SECURITY_HEADERS) });
        res.end(buf);
      });
    }

    function handleJsonPost(req, res, fn, maxBytes = MAX_BODY_BYTES) {
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      const cl = Number(req.headers['content-length']);
      if (Number.isFinite(cl) && cl > maxBytes) {
        req.pause();
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }
      wakeFromIdle();
      let bytes = 0;
      const chunks = [];
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          aborted = true;
          req.pause();
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
          res.end(JSON.stringify({ error: 'payload too large' }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (aborted) return;
        let parsed = {};
        const text = Buffer.concat(chunks).toString('utf-8').trim();
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            return sendPacked(req, res, 400, packJsonPayload({ error: 'invalid JSON body' }));
          }
        }
        try {
          const h = handlers || (await ensureHandlers());
          const out = await fn(h, parsed);
          sendPacked(req, res, out.status, packJsonPayload(out.json));
        } catch (err) {
          sendPacked(req, res, 500, packJsonPayload({ error: String(err?.message || err) }));
        }
      });
    }

    if (req.method === 'POST' && pathname === '/api/nudge') {
      return handleJsonPost(req, res, (h, body) => h.postNudge(body));
    }
    if (req.method === 'POST' && pathname === '/api/plan') {
      return handleJsonPost(req, res, (h, body) => h.postPlan(body));
    }
    if (req.method === 'POST' && pathname === '/api/control') {
      return handleJsonPost(req, res, (h, body) => h.postControl(body));
    }
    if (req.method === 'POST' && pathname === '/api/worktrees/action') {
      return handleJsonPost(req, res, (h, body) => h.postWorktreeAction(body), MAX_WORKTREE_ACTION_BYTES);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Not found');
  }

  return {
    handleRequest,
    ensureHandlers,
    getSleepState: () => ({ idleSleep, sseClients: sseClients.size, timerActive: Boolean(sseTimer) }),
    closeClients: () => {
      for (const client of sseClients) {
        try {
          client.res.end();
        } catch {}
      }
      sseClients.clear();
      stopSseTimerIfIdle();
    },
  };
}

/** Start standalone loopback HTTP server with gzip, ETag/304, Host-403, and prompt 413 enforcement. */
export async function startStandaloneServer({
  port = 18430,
  host = BIND_HOST,
  distDir = join(__dirname, 'dist'),
  appDataDir = '',
  defaultConversationId = '',
  sendMessageFn = null,
  deferStore = false,
} = {}) {
  const router = await createStandaloneRouter({ distDir, appDataDir, defaultConversationId, sendMessageFn, deferStore });
  const server = createServer(router.handleRequest);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  if (deferStore) setImmediate(() => { void router.ensureHandlers(); });
  const addr = server.address();
  return {
    server,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    getSleepState: router.getSleepState,
    close: () => {
      router.closeClients();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Run inside Antigravity's SidecarApp gateway. */
export async function runSidecarApp({ appDataDir = '' } = {}) {
  if (process.execArgv.includes('--jitless')) {
    try {
      const { setFlagsFromString } = await import('node:v8');
      setFlagsFromString('--max-semi-space-size=1 --optimize-for-size --memory-reducer');
    } catch {}
  }
  const [{ SidecarApp, Response }, store] = await Promise.all([import('sidecar_sdk'), getStore(), ensureZlib()]);
  const app = new SidecarApp();
  const handlers = createFleetHandlers({
    store,
    appDataDir,
    defaultConversationId: app.config.conversationId || '',
    isSidecar: true,
    sendMessageFn: (convId, message) => app.sendMessage(convId, message),
  });

  app.page('/', () => new Response(handlers.assets.htmlRaw, {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-cache', ETag: handlers.assets.htmlEtag, ...SECURITY_HEADERS },
  }));

  for (const [route, font] of handlers.assets.fonts.entries()) {
    app.api(
      route,
      () =>
        new Response(font.raw, {
          contentType: 'font/woff2',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: font.etag, ...SECURITY_HEADERS },
        }),
      'GET',
    );
  }

  app.api('/api/health', () => new Response(handlers.getHealthPacked().raw, { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
  app.api('/api/swarms', () => new Response(handlers.getSwarmsPacked().raw, { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
  app.api('/api/swarm', (data) => new Response(handlers.getSwarmPacked(data).raw, { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
  app.api('/api/worktrees', async (data) => new Response((await handlers.getWorktreesPacked(data)).raw, { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
  app.api('/api/worktrees/diff', async (data) => {
    const out = await handlers.getWorktreeDiff(data);
    return new Response(out.packed.raw, { status: out.status, contentType: 'application/json', headers: SECURITY_HEADERS });
  }, 'GET');
  app.api('/api/frame', (data) => {
    const out = handlers.getFrame(data);
    return new Response(out.body, { status: out.status, contentType: out.contentType, headers: out.headers || SECURITY_HEADERS });
  }, 'GET');
  app.api('/api/nudge', async (data) => {
    const out = await handlers.postNudge(data);
    return new Response(JSON.stringify(out.json), { status: out.status, contentType: 'application/json', headers: SECURITY_HEADERS });
  }, 'POST');
  const registerJsonPost = (path, fn, maxBytes = MAX_BODY_BYTES) => {
    app.api(path, async (data) => {
      let payload = data;
      if (typeof data === 'string') {
        if (Buffer.byteLength(data, 'utf8') > maxBytes) {
          return new Response(JSON.stringify({ error: 'payload too large' }), {
            status: 413,
            contentType: 'application/json',
            headers: SECURITY_HEADERS,
          });
        }
        try {
          payload = JSON.parse(data);
        } catch {
          return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
            status: 400,
            contentType: 'application/json',
            headers: SECURITY_HEADERS,
          });
        }
      } else if (data && typeof data === 'object') {
        try {
          if (Buffer.byteLength(JSON.stringify(data), 'utf8') > maxBytes) {
            return new Response(JSON.stringify({ error: 'payload too large' }), {
              status: 413,
              contentType: 'application/json',
              headers: SECURITY_HEADERS,
            });
          }
        } catch {}
      }
      const out = await fn(payload);
      return new Response(JSON.stringify(out.json), { status: out.status, contentType: 'application/json', headers: SECURITY_HEADERS });
    }, 'POST');
  };

  registerJsonPost('/api/plan', (payload) => handlers.postPlan(payload));
  registerJsonPost('/api/control', (payload) => handlers.postControl(payload));
  registerJsonPost('/api/worktrees/action', (payload) => handlers.postWorktreeAction(payload), MAX_WORKTREE_ACTION_BYTES);

  await app.run();
}
