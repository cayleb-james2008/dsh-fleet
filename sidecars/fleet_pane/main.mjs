/**
 * Fleet Antigravity Sidecar + Standalone HTTP Backend.
 *
 * Dual runtime:
 * 1. Inside Antigravity (`ANTIGRAVITY_SIDECAR_WEB_PORT` set & not `FLEET_STANDALONE=1`):
 *    registers routes on `SidecarApp` from `sidecar_sdk`.
 * 2. Standalone loopback mode (CLI flags `--port <n>`, `--app-data-dir <dir>`,
 *    `PORT`, or `FLEET_STANDALONE=1`): serves pre-compressed gzip + ETag/304 UI,
 *    security headers, Host loopback-403 check, prompt 413 payload enforcement,
 *    and `/preload.js` browser shim.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { probeWorktrees } from './git_probe.mjs';
import {
  ID_RE,
  buildSwarmSnapshot,
  findAppDataDirs,
  listSwarms,
  resolveAllowedFrame,
  resolveConversationSwarm,
  unseenBy,
} from './swarm_store.mjs';

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

function loadDistAssets(distDir) {
  const indexPath = join(distDir, 'index.html');
  const htmlRaw = existsSync(indexPath)
    ? readFileSync(indexPath)
    : Buffer.from('<!doctype html><html><body><p>Fleet dist/index.html missing. Run npm run build in frontend/.</p></body></html>');
  const htmlGzip = gzipSync(htmlRaw, { level: 9 });
  const htmlEtag = `"${createHash('sha256').update(htmlRaw).digest('hex').slice(0, 16)}"`;

  const fonts = new Map();
  const fontsDir = join(distDir, 'fonts');
  if (existsSync(fontsDir)) {
    for (const file of readdirSync(fontsDir)) {
      if (!file.endsWith('.woff2')) continue;
      const buf = readFileSync(join(fontsDir, file));
      fonts.set(`/fonts/${file}`, {
        raw: buf,
        etag: `"${createHash('sha256').update(buf).digest('hex').slice(0, 16)}"`,
      });
    }
  }
  return { htmlRaw, htmlGzip, htmlEtag, fonts };
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

/** Build framework-agnostic route handlers shared by `SidecarApp` and standalone HTTP mode. */
export function createFleetHandlers({
  distDir = join(__dirname, 'dist'),
  appDataDir = '',
  defaultConversationId = '',
  isSidecar = false,
  sendMessageFn = null,
} = {}) {
  const assets = loadDistAssets(distDir);
  const getAppDirs = () => findAppDataDirs(appDataDir);

  function getHealth() {
    const appDataDirs = getAppDirs();
    return {
      ok: true,
      name: 'fleet',
      version: '1.0.0',
      mode: isSidecar ? 'sidecar' : 'standalone',
      canSendMessage: Boolean(sendMessageFn),
      appDataDirs,
      conversationId: defaultConversationId || null,
    };
  }

  function getSwarms() {
    const appDataDirs = getAppDirs();
    const swarms = listSwarms(appDataDirs);
    return {
      swarms,
      defaultConversationId: defaultConversationId || swarms[0]?.id || null,
      appDataDirs,
    };
  }

  function getSwarm(query = {}) {
    const appDataDirs = getAppDirs();
    const requestedConv = typeof query.conversationId === 'string' ? query.conversationId.trim() : '';
    const fallbackConv = !requestedConv ? defaultConversationId : '';
    let conv = requestedConv || fallbackConv;
    let resolvedFrom = 'conversation';

    if (!conv) {
      const available = listSwarms(appDataDirs);
      if (available.length) {
        conv = available[0].id;
        resolvedFrom = 'latest';
      }
    }

    if (!conv || !ID_RE.test(conv)) {
      return {
        conversationId: conv || null,
        swarm: null,
        member: null,
        resolvedFrom,
        capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar },
        swarms: listSwarms(appDataDirs),
      };
    }

    const res = resolveConversationSwarm(appDataDirs, conv);
    if (!res.swarm || !res.appData) {
      const available = listSwarms(appDataDirs);
      return {
        conversationId: conv,
        swarm: null,
        member: null,
        resolvedFrom,
        capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar },
        swarms: available,
      };
    }

    const snap = buildSwarmSnapshot(res.appData, res.swarm);
    if (!snap) {
      return {
        conversationId: conv,
        swarm: null,
        member: null,
        resolvedFrom,
        capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar },
        swarms: listSwarms(appDataDirs),
      };
    }

    const etag = `${res.swarm}|${res.member || ''}|${snap.etag}`;
    if (query.etag && query.etag === etag) {
      return { conversationId: conv, swarm: res.swarm, member: res.member, unchanged: true, etag };
    }

    return {
      conversationId: conv,
      swarm: res.swarm,
      member: res.member,
      resolvedFrom,
      ...snap,
      ...unseenBy(snap, res.member),
      etag,
      capabilities: { canSendMessage: Boolean(sendMessageFn), isSidecar },
    };
  }

  async function getWorktrees(query = {}) {
    return probeWorktrees(query.roots || '');
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
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const targetConv = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!message || message.length > 4000) {
      return { status: 400, json: { error: 'Non-empty message (<= 4000 chars) required' } };
    }
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

  return {
    assets,
    getHealth,
    getSwarms,
    getSwarm,
    getWorktrees,
    getFrame,
    postNudge,
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

  function sendJson(req, res, status, data, extraHeaders = {}) {
    const raw = Buffer.from(JSON.stringify(data));
    const etag = `"${createHash('sha256').update(raw).digest('hex').slice(0, 16)}"`;
    const baseHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
      ETag: etag,
      ...SECURITY_HEADERS,
      ...extraHeaders,
    };
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    if (acceptsGzip && raw.length >= 256) {
      const gz = gzipSync(raw);
      res.writeHead(status, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
      return;
    }
    res.writeHead(status, { ...baseHeaders, 'Content-Length': raw.length });
    res.end(raw);
  }

  const server = createServer(async (req, res) => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }

    const url = new URL(req.url || '/', `http://${host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const { htmlRaw, htmlGzip, htmlEtag } = handlers.assets;
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        Vary: 'Accept-Encoding',
        ETag: htmlEtag,
        ...SECURITY_HEADERS,
      };
      if (req.headers['if-none-match'] === htmlEtag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': htmlGzip.length });
        res.end(htmlGzip);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': htmlRaw.length });
      res.end(htmlRaw);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/preload.js') {
      const buf = Buffer.from(STANDALONE_PRELOAD_JS);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': buf.length,
        ...SECURITY_HEADERS,
      });
      res.end(buf);
      return;
    }

    if (req.method === 'GET' && handlers.assets.fonts.has(url.pathname)) {
      const font = handlers.assets.fonts.get(url.pathname);
      const headers = {
        'Content-Type': 'font/woff2',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: font.etag,
        'Content-Length': font.raw.length,
        ...SECURITY_HEADERS,
      };
      if (req.headers['if-none-match'] === font.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(font.raw);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(req, res, 200, handlers.getHealth());
    }
    if (req.method === 'GET' && url.pathname === '/api/swarms') {
      return sendJson(req, res, 200, handlers.getSwarms());
    }
    if (req.method === 'GET' && url.pathname === '/api/swarm') {
      const q = Object.fromEntries(url.searchParams.entries());
      return sendJson(req, res, 200, handlers.getSwarm(q));
    }
    if (req.method === 'GET' && url.pathname === '/api/worktrees') {
      const q = Object.fromEntries(url.searchParams.entries());
      return sendJson(req, res, 200, await handlers.getWorktrees(q));
    }
    if (req.method === 'GET' && url.pathname === '/api/frame') {
      const q = Object.fromEntries(url.searchParams.entries());
      const out = handlers.getFrame(q);
      const buf = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body));
      res.writeHead(out.status, { 'Content-Type': out.contentType, 'Content-Length': buf.length, ...(out.headers || SECURITY_HEADERS) });
      res.end(buf);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/nudge') {
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
            return sendJson(req, res, 400, { error: 'invalid JSON body' });
          }
        }
        const out = await handlers.postNudge(parsed);
        sendJson(req, res, out.status, out.json);
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function runCli() {
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

    app.api('/api/health', () => new Response(JSON.stringify(handlers.getHealth()), { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
    app.api('/api/swarms', () => new Response(JSON.stringify(handlers.getSwarms()), { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
    app.api('/api/swarm', (data) => new Response(JSON.stringify(handlers.getSwarm(data)), { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
    app.api('/api/worktrees', async (data) => new Response(JSON.stringify(await handlers.getWorktrees(data)), { contentType: 'application/json', headers: SECURITY_HEADERS }), 'GET');
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
