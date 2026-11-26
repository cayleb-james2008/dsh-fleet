/**
 * Fleet Antigravity Sidecar + Standalone HTTP Bootstrap.
 * Binds loopback HTTP immediately for sub-55ms cold boot and delegates full
 * routing, SSE, gzip/ETag caching, and SidecarApp RPC lazily to ./server_core.mjs.
 */
import { createServer } from 'node:http';

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '1';
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function isLoopbackHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  const col = h.lastIndexOf(':');
  const bare = h.startsWith('[') ? (h.endsWith(']') ? h : h.slice(0, h.indexOf(']') + 1)) : col > 0 ? h.slice(0, col) : h;
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]';
}

export async function createFleetHandlers(opts) {
  return (await import('./server_core.mjs')).createFleetHandlers(opts);
}

export async function startStandaloneServer(opts) {
  return (await import('./server_core.mjs')).startStandaloneServer(opts);
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
    const { runSidecarApp } = await import('./server_core.mjs');
    return runSidecarApp({ appDataDir });
  }

  let router = null;
  let routerPromise = null;
  const ensureRouter = () =>
    (routerPromise ||= import('./server_core.mjs').then(({ createStandaloneRouter }) =>
      createStandaloneRouter({ appDataDir, deferStore: true }).then((r) => (router = r)),
    ));

  let bootHealthBuf = null;
  const server = createServer((req, res) => {
    if (router) return router.handleRequest(req, res);
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close', ...SECURITY_HEADERS });
      res.end('{"error":"forbidden host"}');
      return;
    }
    const url = req.url || '/';
    if (req.method === 'GET' && (url === '/api/health' || url.startsWith('/api/health?'))) {
      if (!bootHealthBuf) {
        const dirs = appDataDir ? [appDataDir] : process.env.FLEET_APP_DATA_DIR ? [process.env.FLEET_APP_DATA_DIR] : [];
        bootHealthBuf = Buffer.from(JSON.stringify({
          ok: true,
          name: 'fleet',
          version: '1.26.0',
          mode: 'standalone',
          canSendMessage: false,
          sseStream: true,
          deltaStream: true,
          transcriptInspector: true,
          idleSleep: true,
          sseClients: 0,
          appDataDirs: dirs,
          conversationId: null,
        }));
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': bootHealthBuf.length,
        ...SECURITY_HEADERS,
      });
      res.end(bootHealthBuf);
      return;
    }
    ensureRouter().then(
      (r) => r.handleRequest(req, res),
      (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      },
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  console.log(`[fleet_pane] standalone server listening on http://127.0.0.1:${addr.port}`);

  const warmTimer = setTimeout(() => {
    if (process.execArgv.includes('--jitless')) {
      import('node:v8').then(({ setFlagsFromString }) => {
        try {
          setFlagsFromString('--max-semi-space-size=1 --optimize-for-size --memory-reducer');
        } catch {}
      }).catch(() => {});
    }
    void ensureRouter().then((r) => r.ensureHandlers());
  }, 25);
  warmTimer.unref();
}

const isEntry =
  process.argv[1] &&
  (import.meta.filename ? import.meta.filename === process.argv[1] : process.argv[1].endsWith('/main.mjs'));
if (isEntry) {
  runCli().catch((err) => {
    console.error('[fleet_pane] fatal:', err);
    process.exit(1);
  });
}
