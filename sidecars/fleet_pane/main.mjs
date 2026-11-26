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
import { fileURLToPath } from 'node:url';
import { crc32, gunzipSync, gzipSync } from 'node:zlib';
import {
  ID_RE,
  buildSwarmSnapshot,
  computeSwarmFingerprint,
  findAppDataDirs,
  getSwarmMetaKeys,
  listSwarms,
  resolveAllowedFrame,
  resolveConversationSwarm,
  unseenBy,
} from './swarm_store.mjs';

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '1';
}

let gitProbeMod = null;
const getGitProbe = () => (gitProbeMod ||= import('./git_probe.mjs'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

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
  const c1 = crc32(buf);
  const c2 = crc32(buf.subarray(0, Math.min(buf.length, 4096)), (c1 ^ buf.length) >>> 0);
  return `"${c1.toString(16).padStart(8, '0')}${c2.toString(16).padStart(8, '0')}"`;
}

function loadDistAssets(distDir) {
  const indexPath = join(distDir, 'index.html');
  const indexGzPath = join(distDir, 'index.html.gz');
  const hasIndex = existsSync(indexPath);
  const hasGz = hasIndex && existsSync(indexGzPath);
  let htmlRawCache = hasGz
    ? null
    : hasIndex
      ? readFileSync(indexPath)
      : Buffer.from('<!doctype html><html><body><p>Fleet dist/index.html missing. Run npm run build in frontend/.</p></body></html>');
  const htmlGzip = hasGz ? readFileSync(indexGzPath) : gzipSync(htmlRawCache, { level: 9 });
  const htmlEtag = fastEtag(htmlGzip);
  const rootHdrBase = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
    ETag: htmlEtag,
    ...SECURITY_HEADERS,
  };
  const rootHdrGz = { ...rootHdrBase, 'Content-Encoding': 'gzip', 'Content-Length': htmlGzip.length };
  let rootHdrRaw = htmlRawCache ? { ...rootHdrBase, 'Content-Length': htmlRawCache.length } : null;
  const getHtmlRaw = () => {
    if (!htmlRawCache) {
      htmlRawCache = hasIndex ? readFileSync(indexPath) : gunzipSync(htmlGzip);
      rootHdrRaw = { ...rootHdrBase, 'Content-Length': htmlRawCache.length };
    }
    return htmlRawCache;
  };
  const getRootHdrRaw = () => {
    if (!rootHdrRaw) getHtmlRaw();
    return rootHdrRaw;
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
  return { get htmlRaw() { return getHtmlRaw(); }, getHtmlRaw, htmlGzip, htmlEtag, rootHdrBase, rootHdrGz, getRootHdrRaw, get fonts() { return getFontsMap(); } };
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
    if (rawBuf.length < 256) return null;
    if (!gzBuf) {
      gzBuf = gzipSync(rawBuf);
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
  distDir = join(__dirname, 'dist'),
  appDataDir = '',
  defaultConversationId = '',
  isSidecar = false,
  sendMessageFn = null,
} = {}) {
  const assets = loadDistAssets(distDir);
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

  function getHealthPacked() {
    const appDataDirs = getAppDirs();
    const key = `${appDataDirs.join('\0')}|${isSidecar}|${Boolean(sendMessageFn)}|${defaultConversationId}`;
    if (!healthPacked || healthKey !== key) {
      healthKey = key;
      healthPacked = pack({
        ok: true,
        name: 'fleet',
        version: '1.12.0',
        mode: isSidecar ? 'sidecar' : 'standalone',
        canSendMessage: Boolean(sendMessageFn),
        sseStream: !isSidecar,
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
    if (swarmsListCache.packed && swarmsListCache.key === key && now - swarmsListCache.at < 1000) {
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
      else if (swarmPayloadCache.size >= 2) swarmPayloadCache.delete(swarmPayloadCache.keys().next().value);
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
      if (now - hit.checkedAt < 250) {
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
      else if (swarmPayloadCache.size >= 2) swarmPayloadCache.delete(swarmPayloadCache.keys().next().value);
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

  async function getWorktreesPacked(query = {}) {
    const rootsKey = String(query.roots || '');
    const now = Date.now();
    const hit = worktreesPayloadCache.get(rootsKey);
    if (hit && now - hit.at < 3000) return hit.packed;
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
      file: typeof query.file === 'string' ? query.file : '',
      maxBytes: Number(query.maxBytes) || 8192,
    });
    return { status: res.status || (res.ok ? 200 : 400), packed: pack(res) };
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
    return {
      status: 200,
      contentType: frame.contentType,
      body: readFileSync(frame.real),
      headers: { 'Cache-Control': 'private, max-age=3600', ...SECURITY_HEADERS },
    };
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
    getHealthPacked,
    getSwarmsPacked,
    getSwarmPacked,
    getWorktreesPacked,
    getWorktreeDiff,
    getFrame,
    postNudge,
    resolveStreamTarget,
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
} = {}) {
  const handlers = createFleetHandlers({
    distDir,
    appDataDir,
    defaultConversationId,
    isSidecar: false,
    sendMessageFn,
  });

  const preloadBuf = Buffer.from(STANDALONE_PRELOAD_JS);
  const MAX_SSE_CLIENTS = 64;
  const SSE_POLL_MS = 150;
  const SSE_PING_MS = 15000;
  const sseClients = new Set();
  let sseTimer = null;

  function stopSseTimerIfIdle() {
    if (sseClients.size === 0 && sseTimer) {
      clearInterval(sseTimer);
      sseTimer = null;
    }
  }

  function ensureSseTimer() {
    if (sseTimer || sseClients.size === 0) return;
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
          fp = computeSwarmFingerprint(client.appData, client.swarm);
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
            client.res.write(': ping\n\n');
          } catch {
            sseClients.delete(client);
          }
        }
      }
      stopSseTimerIfIdle();
    }, SSE_POLL_MS);
    sseTimer.unref();
  }

  const preloadHeaders = {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Length': preloadBuf.length,
    ...SECURITY_HEADERS,
  };

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

  const server = createServer((req, res) => {
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
      const assets = handlers.assets;
      if (req.headers['if-none-match'] === assets.htmlEtag) {
        res.writeHead(304, assets.rootHdrBase);
        res.end();
        return;
      }
      const ae = req.headers['accept-encoding'];
      if (typeof ae === 'string' && ae.includes('gzip')) {
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
      res.writeHead(200, preloadHeaders);
      res.end(preloadBuf);
      return;
    }

    if (req.method === 'GET' && handlers.assets.fonts.has(pathname)) {
      const font = handlers.assets.fonts.get(pathname);
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
      return sendPacked(req, res, 200, handlers.getHealthPacked());
    }
    if (req.method === 'GET' && pathname === '/api/swarms') {
      return sendPacked(req, res, 200, handlers.getSwarmsPacked());
    }
    if (req.method === 'GET' && pathname === '/api/swarm') {
      return sendPacked(req, res, 200, handlers.getSwarmPacked(parseQueryFast(search)));
    }
    if (req.method === 'GET' && pathname === '/api/swarm/stream') {
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'too many stream clients' }));
        return;
      }
      const target = handlers.resolveStreamTarget(parseQueryFast(search));
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
      return;
    }
    if (req.method === 'GET' && pathname === '/api/worktrees') {
      handlers.getWorktreesPacked(parseQueryFast(search)).then((packed) => sendPacked(req, res, 200, packed));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/worktrees/diff') {
      handlers.getWorktreeDiff(parseQueryFast(search)).then((out) => sendPacked(req, res, out.status, out.packed));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/frame') {
      const out = handlers.getFrame(parseQueryFast(search));
      const buf = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body));
      res.writeHead(out.status, { 'Content-Type': out.contentType, 'Content-Length': buf.length, ...(out.headers || SECURITY_HEADERS) });
      res.end(buf);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/nudge') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      const cl = Number(req.headers['content-length']);
      if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
        req.pause();
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }
      let bytes = 0;
      const chunks = [];
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
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
        const out = await handlers.postNudge(parsed);
        sendPacked(req, res, out.status, packJsonPayload(out.json));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  return {
    server,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    close: () => {
      for (const client of sseClients) {
        try {
          client.res.end();
        } catch {}
      }
      sseClients.clear();
      stopSseTimerIfIdle();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function runCli() {
  if (process.execArgv.includes('--jitless') && !process.execArgv.includes('--optimize-for-size')) {
    try {
      const { setFlagsFromString } = await import('node:v8');
      setFlagsFromString('--max-semi-space-size=1 --optimize-for-size');
    } catch {}
  }
  const args = process.argv.slice(2);
  let port = Number(process.env.PORT || 18430);
  let appDataDir = process.env.FLEET_APP_DATA_DIR || '';
  let standalone = process.env.FLEET_STANDALONE === '1' || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[++i]);
      standalone = true;
    } else if (args[i] === '--app-data-dir' && args[i + 1]) {
      appDataDir = args[++i];
    } else if (args[i] === '--standalone') {
      standalone = true;
    }
  }

  if (!standalone && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    const { SidecarApp, Response } = await import('sidecar_sdk');
    const app = new SidecarApp();
    const handlers = createFleetHandlers({
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

    await app.run();
    return;
  }

  const srv = await startStandaloneServer({ port, appDataDir });
  console.log(`[fleet_pane] standalone server listening on ${srv.url}`);
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) {
  runCli().catch((err) => {
    console.error('[fleet_pane] fatal:', err);
    process.exit(1);
  });
}
