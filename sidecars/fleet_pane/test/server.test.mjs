import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { startStandaloneServer } from '../main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function makeScratchDir(prefix) {
  const base = join(__dirname, '.scratch');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function setupFixtureAppData() {
  const dir = makeScratchDir('http-');
  const distDir = join(dir, 'dist');
  mkdirSync(distDir, { recursive: true });
  const stubHtml = '<!doctype html><html><body>' + 'Fleet'.repeat(120) + '</body></html>';
  writeFileSync(distDir + '/index.html', stubHtml);
  writeFileSync(distDir + '/index.html.gz', gzipSync(Buffer.from(stubHtml), { level: 9 }));

  const appData = join(dir, 'appdata');
  const coord = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const worker = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const swDir = join(appData, 'brain', coord, '.system_generated', 'swarm');
  mkdirSync(swDir, { recursive: true });
  mkdirSync(join(appData, 'brain', worker), { recursive: true });

  const goodPng = join(appData, 'brain', worker, 'good.png');
  const unlistedPng = join(appData, 'brain', worker, 'unlisted.png');
  const outsideFile = join(dir, 'secret.png');
  const evilSymlink = join(appData, 'brain', worker, 'symlink.png');
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  writeFileSync(goodPng, pngBytes);
  writeFileSync(unlistedPng, pngBytes);
  writeFileSync(outsideFile, pngBytes);
  symlinkSync(outsideFile, evilSymlink);

  writeFileSync(
    join(swDir, 'members.json'),
    JSON.stringify({
      title: 'HTTP Test Swarm',
      members: {
        coordinator: { conversation_id: coord, role: 'coordinator' },
        worker: { conversation_id: worker, role: 'worker' },
      },
    }),
  );
  writeFileSync(
    join(swDir, 'board.jsonl'),
    JSON.stringify({
      seq: 1,
      agent: 'worker',
      text: `Screenshot: ${goodPng} | Valid\nScreenshot: ${evilSymlink} | Escape`,
    }) + '\n',
  );

  return { dir, distDir, appData, coord, worker, goodPng, unlistedPng, evilSymlink };
}

test('standalone server enforces gzip, ETag/304, security headers, Host-403, Origin-403, 413, and frame confinement', async () => {
  const fx = setupFixtureAppData();
  const nudged = [];
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
    sendMessageFn: async (conv, msg) => {
      nudged.push({ conv, msg });
      return { ok: true };
    },
  });

  try {
    // 1. Gzip + ETag + 304 + Security headers on /
    const res1 = await fetch(`${srv.url}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res1.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(res1.headers.get('content-security-policy')?.includes("frame-src 'none'"));
    assert.equal(res1.headers.get('vary'), 'Accept-Encoding');
    const etag = res1.headers.get('etag');
    assert.ok(etag);
    const bodyText = await res1.text();
    assert.ok(bodyText.includes('Fleet'));

    // Raw socket check confirms actual gzip wire bytes
    const rawGz = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`);
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks)));
      sock.on('error', reject);
    });
    const sepIdx = rawGz.indexOf('\r\n\r\n');
    const hdrText = rawGz.slice(0, sepIdx).toString('utf-8');
    assert.ok(hdrText.includes('Content-Encoding: gzip'));
    assert.ok(gunzipSync(rawGz.slice(sepIdx + 4)).toString('utf-8').includes('Fleet'));

    const res304 = await fetch(`${srv.url}/`, { headers: { 'If-None-Match': etag } });
    assert.equal(res304.status, 304);

    // 2. Host header DNS rebinding 403 check via raw TCP
    const badHostResp = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(`GET /api/health HTTP/1.1\r\nHost: evil.attacker.example\r\nConnection: close\r\n\r\n`);
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      sock.on('error', reject);
    });
    assert.ok(badHostResp.startsWith('HTTP/1.1 403'));

    // 3. Cross-origin POST CSRF 403 check
    const csrfRes = await fetch(`${srv.url}/api/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ confirm: true, conversationId: fx.worker, message: 'hi' }),
    });
    assert.equal(csrfRes.status, 403);

    // 4. Raw TCP prompt 413 with open write half (client does NOT send body after header)
    const prompt413 = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(
          `POST /api/nudge HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nContent-Type: application/json\r\nContent-Length: 9999999\r\n\r\n`,
        );
      });
      const chunks = [];
      sock.setTimeout(2000, () => {
        sock.destroy();
        reject(new Error('timeout waiting for prompt 413'));
      });
      sock.on('data', (c) => {
        chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf-8');
        if (text.includes('\r\n\r\n')) {
          sock.destroy();
          resolve(text);
        }
      });
      sock.on('error', reject);
    });
    assert.ok(prompt413.startsWith('HTTP/1.1 413'));

    // 5. Confirmation-gated POST /api/nudge
    const noConfirm = await fetch(`${srv.url}/api/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: fx.worker, message: 'wake up' }),
    });
    assert.equal(noConfirm.status, 400);
    assert.equal(nudged.length, 0);

    const yesConfirm = await fetch(`${srv.url}/api/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, conversationId: fx.worker, message: 'wake up' }),
    });
    assert.equal(yesConfirm.status, 200);
    assert.equal(nudged.length, 1);

    const badCtrl = await fetch(`${srv.url}/api/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, conversationId: fx.worker, message: 'hi\x00there' }),
    });
    assert.equal(badCtrl.status, 400);
    assert.equal(nudged.length, 1);

    // 6. CWE-22 & CWE-59 /api/frame hardening
    const fGood = await fetch(`${srv.url}/api/frame?conversationId=${fx.coord}&path=${encodeURIComponent(fx.goodPng)}`);
    assert.equal(fGood.status, 200);
    assert.equal(fGood.headers.get('content-type'), 'image/png');

    const fUnlisted = await fetch(`${srv.url}/api/frame?conversationId=${fx.coord}&path=${encodeURIComponent(fx.unlistedPng)}`);
    assert.equal(fUnlisted.status, 404);

    const fSymlink = await fetch(`${srv.url}/api/frame?conversationId=${fx.coord}&path=${encodeURIComponent(fx.evilSymlink)}`);
    assert.equal(fSymlink.status, 404);

    const fTraversal = await fetch(`${srv.url}/api/frame?conversationId=${fx.coord}&path=${encodeURIComponent(fx.appData + '/brain/../appdata/secret.png')}`);
    assert.equal(fTraversal.status, 404);

    // 7. CWE-22 /api/worktrees/diff validation
    const dBad = await fetch(`${srv.url}/api/worktrees/diff?root=/etc&worktree=/etc&file=../passwd`);
    assert.equal(dBad.status, 400);
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('install.sh --dest deploys plugin bundle cleanly and installed main.mjs boots', async () => {
  const tmp = makeScratchDir('install-');
  const distDir = join(REPO_ROOT, 'sidecars', 'fleet_pane', 'dist');
  const hadDist = existsSync(join(distDir, 'index.html'));
  let child = null;
  try {
    if (!hadDist) {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>stub</body></html>');
    }
    const dest = join(tmp, 'plugins', 'fleet');
    execFileSync(join(REPO_ROOT, 'install.sh'), ['--dest', dest], { stdio: 'pipe' });
    assert.ok(existsSync(join(dest, 'plugin.json')));
    assert.ok(existsSync(join(dest, 'assets', 'logo.svg')));
    assert.ok(existsSync(join(dest, 'skills', 'fleet', 'SKILL.md')));
    assert.ok(existsSync(join(dest, 'rules', 'AGENTS.md')));
    assert.ok(existsSync(join(dest, 'sidecars', 'fleet_pane', 'sidecar.json')));
    assert.ok(existsSync(join(dest, 'sidecars', 'fleet_pane', 'main.mjs')));
    assert.ok(existsSync(join(dest, 'sidecars', 'fleet_pane', 'channels.mjs')));
    assert.ok(existsSync(join(dest, 'sidecars', 'fleet_pane', 'git_probe.mjs')));
    assert.ok(existsSync(join(dest, 'sidecars', 'fleet_pane', 'swarm_store.mjs')));
    assert.ok(existsSync(join(dest, 'sidecars', 'fleet_pane', 'dist', 'index.html')));
    if (existsSync(join(distDir, 'index.html.gz'))) {
      assert.ok(existsSync(join(dest, 'sidecars', 'fleet_pane', 'dist', 'index.html.gz')));
    }

    const installedMain = join(dest, 'sidecars', 'fleet_pane', 'main.mjs');
    child = spawn('node', [installedMain, '--port', '0', '--app-data-dir', tmp], {
      cwd: join(dest, 'sidecars', 'fleet_pane'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`installed main.mjs boot timeout: ${buf}`)), 3000);
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.stderr.on('data', (chunk) => {
        buf += chunk;
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`installed main.mjs exited early (${code}): ${buf}`));
      });
    });

    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200);
    const json = await health.json();
    assert.equal(json.ok, true);
    assert.equal(json.name, 'fleet');
    assert.equal(json.version, '1.15.0');
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (!hadDist) rmSync(distDir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /api/swarm/stream sustains 5 concurrent SSE clients and pushes live deltas on append', async () => {
  const fx = setupFixtureAppData();
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  const socks = [];
  try {
    const buffers = Array.from({ length: 5 }, () => '');
    await Promise.all(
      Array.from({ length: 5 }, (_, idx) => {
        return new Promise((resolve, reject) => {
          const s = net.connect(srv.port, '127.0.0.1', () => {
            s.write(`GET /api/swarm/stream?conversationId=${fx.coord} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nAccept: text/event-stream\r\n\r\n`);
          });
          socks.push(s);
          s.setEncoding('utf-8');
          s.on('data', (chunk) => {
            buffers[idx] += chunk;
            if (buffers[idx].includes('event: swarm\ndata:')) resolve();
          });
          s.on('error', reject);
        });
      }),
    );

    const initialCounts = buffers.map((b) => (b.match(/event: swarm/g) || []).length);
    assert.deepEqual(initialCounts, [1, 1, 1, 1, 1]);

    const boardFile = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm', 'board.jsonl');
    appendFileSync(boardFile, JSON.stringify({ seq: 2, agent: 'coordinator', text: '@worker new delta' }) + '\n');

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (buffers.every((b) => (b.match(/event: swarm/g) || []).length >= 2)) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    const finalCounts = buffers.map((b) => (b.match(/event: swarm/g) || []).length);
    assert.ok(finalCounts.every((c) => c >= 2), `Expected >=2 SSE events on all 5 clients, got ${JSON.stringify(finalCounts)}`);
  } finally {
    for (const s of socks) s.destroy();
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('POST /api/nudge supports confirmation-gated multi-worker conversationIds broadcast and validation', async () => {
  const fx = setupFixtureAppData();
  const nudged = [];
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
    sendMessageFn: async (conv, msg) => {
      nudged.push({ conv, msg });
      return { ok: true };
    },
  });

  try {
    const post = (body) =>
      fetch(`${srv.url}/api/nudge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Empty / >24 / invalid ID / missing confirm / >4000 / control chars must all fail 400
    assert.equal((await post({ confirm: true, conversationIds: [], message: 'hi' })).status, 400);
    assert.equal(
      (await post({ confirm: true, conversationIds: Array.from({ length: 25 }, (_, i) => `conv-${i}`), message: 'hi' })).status,
      400,
    );
    assert.equal((await post({ confirm: true, conversationIds: [fx.worker, '../bad'], message: 'hi' })).status, 400);
    assert.equal((await post({ conversationIds: [fx.coord, fx.worker], message: 'hi' })).status, 400);
    assert.equal((await post({ confirm: true, conversationIds: [fx.coord, fx.worker], message: 'x'.repeat(4001) })).status, 400);
    assert.equal((await post({ confirm: true, conversationIds: [fx.coord, fx.worker], message: 'hi\x07there' })).status, 400);
    assert.equal(nudged.length, 0);

    // Deduplicated valid multi-target broadcast succeeds
    const okRes = await post({
      confirm: true,
      conversationIds: [fx.coord, fx.worker, fx.coord],
      message: 'Wave status check',
    });
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.delivered, 2);
    assert.equal(body.results.length, 2);
    assert.deepEqual(
      nudged.map((x) => x.conv),
      [fx.coord, fx.worker],
    );
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
