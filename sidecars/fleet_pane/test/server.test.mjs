import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { startStandaloneServer } from '../main.mjs';
import { createFleetHandlers, runSidecarApp } from '../server_core.mjs';
import * as store from '../swarm_store.mjs';

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
    assert.equal(json.version, '1.27.0');
    assert.equal(json.idleSleep, true);
    assert.equal(json.sseClients, 0);
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

test('Zero-client idle sleep pauses background SSE polling on disconnect and wakes cleanly on next request', async () => {
  const fx = setupFixtureAppData();
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  try {
    // 1. Boots idle with zero background timers
    assert.deepEqual(srv.getSleepState(), { idleSleep: true, sseClients: 0, timerActive: false });
    const h0 = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(h0.idleSleep, true);
    assert.equal(h0.sseClients, 0);

    // 2. SSE connect wakes server and starts timer
    let sock;
    await new Promise((resolve, reject) => {
      sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(`GET /api/swarm/stream?conversationId=${fx.coord} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nAccept: text/event-stream\r\n\r\n`);
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (c) => {
        buf += c;
        if (buf.includes('event: swarm\n')) resolve();
      });
      sock.on('error', reject);
    });
    assert.deepEqual(srv.getSleepState(), { idleSleep: false, sseClients: 1, timerActive: true });
    const h1 = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(h1.idleSleep, false);
    assert.equal(h1.sseClients, 1);

    // 3. Disconnecting the last SSE client enters idleSleep and clears sseTimer
    sock.destroy();
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !srv.getSleepState().idleSleep) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(srv.getSleepState(), { idleSleep: true, sseClients: 0, timerActive: false });
    const h2 = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(h2.idleSleep, true);
    assert.equal(h2.sseClients, 0);

    // 4. Subsequent HTTP request wakes immediately and serves fresh data
    const snap = await fetch(`${srv.url}/api/swarm?conversationId=${fx.coord}`);
    assert.equal(snap.status, 200);
    const snapJson = await snap.json();
    assert.equal(snapJson.swarm, fx.coord);
    assert.equal(srv.getSleepState().idleSleep, false);
    assert.equal(srv.getSleepState().timerActive, false);
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('POST /api/plan supports create/patch/replace via member or coordinator ID, CAS 409, Origin-403, 413, 400, and notifyCoordinator', async () => {
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
    const postPlan = (body, headers = {}) =>
      fetch(`${srv.url}/api/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    // 1. Origin-403 CSRF check
    const badOrigin = await postPlan(
      { confirm: true, conversationId: fx.coord, ifMatch: '', mode: 'patch', patch: { title: 'X' } },
      { Origin: 'https://evil.example' },
    );
    assert.equal(badOrigin.status, 403);

    // 2. Host-403 DNS rebinding check
    const badHost = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(`POST /api/plan HTTP/1.1\r\nHost: evil.attacker.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      sock.on('error', reject);
    });
    assert.ok(badHost.startsWith('HTTP/1.1 403'));

    // 3. 413 payload > 64 KB cap (both Content-Length and streaming body)
    const oversized = await postPlan({
      confirm: true,
      conversationId: fx.coord,
      ifMatch: '',
      mode: 'patch',
      patch: { goal: 'a'.repeat(70 * 1024) },
    });
    assert.equal(oversized.status, 413);

    // 4. 400 validation errors: missing confirm, bad mode, bad status, control chars
    assert.equal((await postPlan({ conversationId: fx.coord, ifMatch: '', patch: { title: 'No confirm' } })).status, 400);
    assert.equal((await postPlan({ confirm: true, conversationId: fx.coord, mode: 'drop', patch: { title: 'Bad mode' } })).status, 400);
    assert.equal(
      (
        await postPlan({
          confirm: true,
          conversationId: fx.coord,
          patch: { workstreams: [{ id: 'ws-1', title: 'Bad', owner: 'worker', status: 'bogus' }] },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await postPlan({
          confirm: true,
          conversationId: fx.coord,
          patch: { goal: 'Bad\x07bell' },
        })
      ).status,
      400,
    );

    // 5. 404 unknown swarm
    const missingSwarm = await postPlan({
      confirm: true,
      conversationId: '99999999-9999-4999-8999-999999999999',
      ifMatch: '',
      mode: 'patch',
      patch: { title: 'Missing' },
    });
    assert.equal(missingSwarm.status, 404);

    // 6. Create native-compatible plan when absent (ifMatch: "")
    const createdRes = await postPlan({
      confirm: true,
      conversationId: fx.coord,
      ifMatch: '',
      mode: 'patch',
      notifyCoordinator: false,
      patch: {
        goalTitle: 'HTTP Plan Title',
        goalLine: 'HTTP Plan Line',
        tasks: { worker: 'Build endpoint' },
        threads: [{ id: 't-1', title: 'Main Thread', goal: 'Ship', tasks: ['worker'] }],
      },
    });
    assert.equal(createdRes.status, 200);
    const created = await createdRes.json();
    assert.equal(created.ok, true);
    assert.equal(created.notified, false);
    assert.equal(created.plan.schema, 'native');
    assert.equal(created.plan.goal, 'HTTP Plan Line');
    assert.equal(created.etag, created.plan.etag);

    // Immediate GET /api/swarm sees new plan without stale cache
    const snapAfterCreate = await (await fetch(`${srv.url}/api/swarm?conversationId=${fx.coord}`)).json();
    assert.equal(snapAfterCreate.plan?.goal, 'HTTP Plan Line');
    assert.equal(snapAfterCreate.plan?.etag, created.etag);

    // 7. Patch via worker conversationId with notifyCoordinator: true
    const patchedRes = await postPlan({
      confirm: true,
      conversationId: fx.worker,
      ifMatch: created.etag,
      mode: 'patch',
      notifyCoordinator: true,
      patch: {
        gate: 'npm test',
        workstreams: [{ id: 'ws-1', title: 'Plan API', owner: 'worker', status: 'done' }],
        milestones: [{ title: 'M1', status: 'done' }],
        risks: [{ title: 'None', severity: 'low' }],
      },
    });
    assert.equal(patchedRes.status, 200);
    const patched = await patchedRes.json();
    assert.equal(patched.ok, true);
    assert.equal(patched.notified, true);
    assert.equal(patched.plan.schema, 'hybrid');
    assert.equal(patched.plan.goalTitle, 'HTTP Plan Title');
    assert.equal(patched.plan.tasks.worker, 'Build endpoint');
    assert.equal(nudged.length, 1);
    assert.equal(nudged[0].conv, fx.coord);
    assert.ok(nudged[0].msg.startsWith('[fleet-plan-updated]'));

    // 8. Stale ifMatch produces 409 Conflict with latest normalized plan
    const conflictRes = await postPlan({
      confirm: true,
      conversationId: fx.coord,
      ifMatch: created.etag,
      mode: 'patch',
      patch: { gate: 'stale' },
    });
    assert.equal(conflictRes.status, 409);
    const conflict = await conflictRes.json();
    assert.equal(conflict.error, 'plan changed on disk');
    assert.equal(conflict.plan.etag, patched.etag);

    // 9. Mode replace with latest etag updates Fleet fields cleanly
    const replaceRes = await postPlan({
      confirm: true,
      conversationId: fx.coord,
      ifMatch: patched.etag,
      mode: 'replace',
      patch: {
        goalLine: 'Final Plan Line',
        workstreams: [{ id: 'ws-1', title: 'Plan API', owner: 'worker', status: 'verified' }],
      },
    });
    assert.equal(replaceRes.status, 200);
    const replaced = await replaceRes.json();
    assert.equal(replaced.plan.goal, 'Final Plan Line');
    assert.equal(replaced.plan.gate, '');
    assert.deepEqual(replaced.plan.milestones, []);
    assert.equal(replaced.plan.workstreams[0].status, 'verified');
    assert.equal(replaced.plan.tasks.worker, 'Build endpoint');
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('GET /api/worktrees, /api/worktrees/diff (working|branch), and POST /api/worktrees/action enforce security and execute git lifecycle cleanly', async () => {
  const fx = setupFixtureAppData();
  const baseDir = makeScratchDir('http-wt-');
  const repoDir = join(baseDir, 'repo');
  const wtClean = join(baseDir, 'wt-clean');
  const wtConflict = join(baseDir, 'wt-conflict');

  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  try {
    execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'shared.txt'), 'base shared\n');
    writeFileSync(join(repoDir, 'src', 'app.txt'), 'base app\n');
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'Initial'], { stdio: 'ignore' });

    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/clean', wtClean], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/conflict', wtConflict], { stdio: 'ignore' });

    // Committed change on feat/clean (does not touch shared.txt)
    writeFileSync(join(wtClean, 'src', 'clean-only.txt'), 'clean branch change\n');
    execFileSync('git', ['-C', wtClean, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', wtClean, 'commit', '-m', 'Add clean file'], { stdio: 'ignore' });
    // Dirty working edit on src/app.txt in wtClean (mixed collision with committed edit in wtConflict)
    writeFileSync(join(wtClean, 'src', 'app.txt'), 'dirty working edit\n');

    // Committed changes on feat/conflict touching both shared.txt and src/app.txt
    writeFileSync(join(wtConflict, 'shared.txt'), 'conflict branch change\n');
    writeFileSync(join(wtConflict, 'src', 'app.txt'), 'conflict app branch change\n');
    execFileSync('git', ['-C', wtConflict, 'commit', '-am', 'Conflict branch edits'], { stdio: 'ignore' });

    // Advance main on shared.txt so feat/conflict conflicts with main while feat/clean is clean (behind 1)
    writeFileSync(join(repoDir, 'shared.txt'), 'main advanced shared\n');
    execFileSync('git', ['-C', repoDir, 'commit', '-am', 'Advance main shared'], { stdio: 'ignore' });

    // 1. GET /api/worktrees enriched schema + mixed collision
    const wtRes = await fetch(`${srv.url}/api/worktrees?roots=${encodeURIComponent(repoDir)}`);
    assert.equal(wtRes.status, 200);
    const wtBody = await wtRes.json();
    assert.ok(Array.isArray(wtBody.collisions));
    const appCollision = wtBody.collisions.find((c) => c.file === 'src/app.txt');
    assert.ok(appCollision);
    assert.equal(appCollision.kind, 'mixed');
    assert.equal(appCollision.worktrees.length, 2);

    const cleanInfo = wtBody.worktrees.find((w) => w.branch === 'feat/clean');
    const conflictInfo = wtBody.worktrees.find((w) => w.branch === 'feat/conflict');
    assert.equal(cleanInfo?.mergeability, 'dirty');
    assert.deepEqual(cleanInfo?.branchFiles, ['src/clean-only.txt']);
    assert.equal(cleanInfo?.commits.length, 1);
    assert.equal(conflictInfo?.mergeability, 'conflict');
    assert.deepEqual(conflictInfo?.conflictFiles, ['shared.txt']);

    // 2. GET /api/worktrees/diff?path=...&file=...&mode=working|branch + security guards
    const dBranch = await fetch(
      `${srv.url}/api/worktrees/diff?path=${encodeURIComponent(wtClean)}&file=${encodeURIComponent('src/clean-only.txt')}&mode=branch`,
    );
    assert.equal(dBranch.status, 200);
    const dBranchJson = await dBranch.json();
    assert.equal(dBranchJson.mode, 'branch');
    assert.ok(dBranchJson.diff.includes('+clean branch change'));

    const dWorking = await fetch(
      `${srv.url}/api/worktrees/diff?path=${encodeURIComponent(wtClean)}&file=${encodeURIComponent('src/app.txt')}&mode=working`,
    );
    assert.equal(dWorking.status, 200);
    const dWorkingJson = await dWorking.json();
    assert.equal(dWorkingJson.mode, 'working');
    assert.ok(dWorkingJson.diff.includes('+dirty working edit'));

    // Reject subdir path (must be canonical worktree root), traversal, and symlink escape
    const dSubdir = await fetch(
      `${srv.url}/api/worktrees/diff?path=${encodeURIComponent(join(wtClean, 'src'))}&file=app.txt&mode=working`,
    );
    assert.equal(dSubdir.status, 404);

    const dTrav = await fetch(
      `${srv.url}/api/worktrees/diff?path=${encodeURIComponent(wtClean)}&file=${encodeURIComponent('../repo/shared.txt')}&mode=branch`,
    );
    assert.equal(dTrav.status, 400);

    symlinkSync('/etc/hosts', join(wtClean, 'evil-link'));
    const dSym = await fetch(
      `${srv.url}/api/worktrees/diff?path=${encodeURIComponent(wtClean)}&file=evil-link&mode=working`,
    );
    assert.equal(dSym.status, 404);
    rmSync(join(wtClean, 'evil-link'));

    // 3. POST /api/worktrees/action security guards: Host-403, Origin-403, 413 (>16 KiB), confinement
    const postAction = (body, headers = {}) =>
      fetch(`${srv.url}/api/worktrees/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    const badOrigin = await postAction(
      { action: 'dry_run_merge', path: wtConflict },
      { Origin: 'https://evil.example' },
    );
    assert.equal(badOrigin.status, 403);

    const badHost = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(`POST /api/worktrees/action HTTP/1.1\r\nHost: evil.attacker.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      sock.on('error', reject);
    });
    assert.ok(badHost.startsWith('HTTP/1.1 403'));

    const oversized16k = await postAction({
      action: 'dry_run_merge',
      path: wtConflict,
      targetBranch: 'a'.repeat(17 * 1024),
    });
    assert.equal(oversized16k.status, 413);

    const badPath = await postAction({ action: 'dry_run_merge', path: join(wtClean, 'src') });
    assert.equal(badPath.status, 404);

    const rmMain = await postAction({ action: 'remove_worktree', path: repoDir });
    assert.equal(rmMain.status, 400);

    // 4. dry_run_merge: conflict vs clean
    const dryConflictRes = await postAction({ action: 'dry_run_merge', path: wtConflict });
    assert.equal(dryConflictRes.status, 200);
    const dryConflict = await dryConflictRes.json();
    assert.equal(dryConflict.ok, true);
    assert.equal(dryConflict.status, 'conflict');
    assert.equal(dryConflict.clean, false);
    assert.deepEqual(dryConflict.conflicts, ['shared.txt']);

    const dryCleanRes = await postAction({ action: 'dry_run_merge', path: wtClean });
    assert.equal(dryCleanRes.status, 200);
    const dryClean = await dryCleanRes.json();
    assert.equal(dryClean.ok, true);
    assert.equal(dryClean.status, 'clean');
    assert.equal(dryClean.clean, true);
    assert.deepEqual(dryClean.conflicts, []);

    // 5. rebase auto-aborts on conflict & preserves clean state
    const rebaseConflictRes = await postAction({ action: 'rebase', path: wtConflict });
    assert.equal(rebaseConflictRes.status, 409);
    const rebaseConflict = await rebaseConflictRes.json();
    assert.equal(rebaseConflict.ok, false);
    assert.equal(rebaseConflict.aborted, true);
    assert.deepEqual(rebaseConflict.conflicts, ['shared.txt']);
    assert.equal(existsSync(join(repoDir, '.git', 'worktrees', 'wt-conflict', 'rebase-merge')), false);
    assert.equal(execFileSync('git', ['-C', wtConflict, 'status', '--porcelain'], { encoding: 'utf8' }), '');

    // 6. Dirty worktree blocks ff_merge, rebase, and remove_worktree; unmerged clean blocks remove_worktree
    assert.equal((await postAction({ action: 'ff_merge', path: wtClean })).status, 409);
    assert.equal((await postAction({ action: 'rebase', path: wtClean })).status, 409);
    assert.equal((await postAction({ action: 'remove_worktree', path: wtClean })).status, 409);

    // Clean wtClean -> diverged ff_merge still refused (409), unmerged remove still refused (409)
    execFileSync('git', ['-C', wtClean, 'checkout', '--', 'src/app.txt'], { stdio: 'ignore' });
    assert.equal((await postAction({ action: 'ff_merge', path: wtClean })).status, 409);
    assert.equal((await postAction({ action: 'remove_worktree', path: wtClean })).status, 409);

    // 7. Rebase wtClean cleanly onto main -> ff_merge succeeds -> remove_worktree succeeds
    const rebaseCleanRes = await postAction({ action: 'rebase', path: wtClean });
    assert.equal(rebaseCleanRes.status, 200);
    const rebaseClean = await rebaseCleanRes.json();
    assert.equal(rebaseClean.ok, true);
    assert.equal(rebaseClean.status, 'rebased');

    const ffRes = await postAction({ action: 'ff_merge', path: wtClean });
    assert.equal(ffRes.status, 200);
    const ffJson = await ffRes.json();
    assert.equal(ffJson.ok, true);
    assert.equal(ffJson.status, 'merged');
    assert.equal(existsSync(join(repoDir, 'src', 'clean-only.txt')), true);

    // Cache invalidated: GET /api/worktrees sees feat/clean merged (ahead === 0)
    const afterMergeWt = await (await fetch(`${srv.url}/api/worktrees?roots=${encodeURIComponent(repoDir)}`)).json();
    const mergedClean = afterMergeWt.worktrees.find((w) => w.branch === 'feat/clean');
    assert.equal(mergedClean?.ahead, 0);
    assert.equal(mergedClean?.landStatus, 'merged');

    // remove_worktree succeeds now that wtClean is clean & merged
    const rmCleanRes = await postAction({ action: 'remove_worktree', path: wtClean, deleteBranch: true });
    assert.equal(rmCleanRes.status, 200);
    const rmClean = await rmCleanRes.json();
    assert.equal(rmClean.ok, true);
    assert.equal(rmClean.status, 'removed');
    assert.equal(rmClean.result.branchDeleted, true);
    assert.equal(existsSync(wtClean), false);

    // Unmerged wtConflict is still refused removal
    const rmUnmergedRes = await postAction({ action: 'remove_worktree', path: wtConflict });
    assert.equal(rmUnmergedRes.status, 409);
  } finally {
    await srv.close();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('POST /api/control executes all 6 ops, enforces 400/403/404/409/413/501 guards, and snapshot exposes replyRefs', async () => {
  const fx = setupFixtureAppData();
  const baseDir = makeScratchDir('http-ctrl-');
  const repoDir = join(baseDir, 'repo');
  const wtDirty = join(baseDir, 'wt-dirty');
  const wtClean = join(baseDir, 'wt-clean');
  const noCoordSwarm = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const noCoordWorker = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const delivered = [];

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'Initial'], { stdio: 'ignore' });

  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/dirty-worker', wtDirty], { stdio: 'ignore' });
  writeFileSync(join(wtDirty, 'committed.txt'), 'ahead\n');
  execFileSync('git', ['-C', wtDirty, 'add', 'committed.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', wtDirty, 'commit', '-m', 'Worker commit'], { stdio: 'ignore' });
  writeFileSync(join(wtDirty, 'dirty.txt'), 'uncommitted\n');

  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'feat/clean-worker', wtClean], { stdio: 'ignore' });

  const swDir = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm');
  const monitorConv = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const cleanConv = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  writeFileSync(
    join(swDir, 'members.json'),
    JSON.stringify({
      title: 'Control Test Swarm',
      members: {
        coordinator: { conversation_id: fx.coord, role: 'coordinator' },
        worker: { conversation_id: fx.worker, role: 'worker', workspace_mode: 'share', workspace: wtDirty },
        'clean-worker': { conversation_id: cleanConv, role: 'worker', workspace_mode: 'share', workspace: wtClean },
        monitor: { conversation_id: monitorConv, role: 'monitor' },
      },
    }),
  );
  writeFileSync(
    join(swDir, 'board.jsonl'),
    [
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@worker Begin work' }),
      JSON.stringify({ seq: 2, agent: 'worker', text: 'Re #1: Ready for review' }),
    ].join('\n') + '\n',
  );

  // Second swarm with no coordinator member (tests 404 coordinator missing)
  const noCoordDir = join(fx.appData, 'brain', noCoordSwarm, '.system_generated', 'swarm');
  mkdirSync(noCoordDir, { recursive: true });
  writeFileSync(
    join(noCoordDir, 'members.json'),
    JSON.stringify({
      title: 'Orphan Swarm',
      members: {
        solo: { conversation_id: noCoordWorker, role: 'worker' },
      },
    }),
  );
  writeFileSync(join(noCoordDir, 'board.jsonl'), JSON.stringify({ seq: 1, agent: 'solo', text: 'Orphan post' }) + '\n');

  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
    sendMessageFn: async (conv, msg) => {
      delivered.push({ conv, msg });
      return { ok: true };
    },
  });

  const srvNoSend = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
    sendMessageFn: null,
  });

  try {
    const postControl = (body, headers = {}, base = srv.url) =>
      fetch(`${base}/api/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    // 1. Security guards: Origin-403, Host-403, 413 (> 64 KB)
    assert.equal(
      (
        await postControl(
          { confirm: true, conversationId: fx.coord, op: 'board_post', text: 'Hi' },
          { Origin: 'https://evil.example' },
        )
      ).status,
      403,
    );

    const badHost = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write(`POST /api/control HTTP/1.1\r\nHost: evil.attacker.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      sock.on('error', reject);
    });
    assert.ok(badHost.startsWith('HTTP/1.1 403'));

    assert.equal(
      (
        await postControl({
          confirm: true,
          conversationId: fx.coord,
          op: 'spawn_worker',
          name: 'qa-bot',
          brief: 'a'.repeat(70 * 1024),
        })
      ).status,
      413,
    );

    // 2. 400 validation errors
    assert.equal((await postControl({ conversationId: fx.coord, op: 'board_post', text: 'Missing confirm' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: '../bad', op: 'board_post', text: 'Bad conv' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'unknown_op' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'board_post', text: 'x'.repeat(4001) })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'board_post', text: 'bad\x07ctrl' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'all', brief: 'x' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'coordinator', brief: 'x' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'BadName', brief: 'x' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'channel_op', action: 'create', channel: 'main' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'channel_op', action: 'create', channel: 'Bad_Chan' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'channel_op', action: 'subscribe', channel: 'backend' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'switch_model', member: 'worker', model: 'bad\nmodel' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'gate_verdict', verdict: 'verified', seq: 0, note: 'Bad seq' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'kill_worker', member: 'coordinator', forceUnmerged: true })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'kill_worker', member: 'monitor' })).status, 400);
    assert.equal((await postControl({ confirm: true, conversationId: fx.coord, op: 'kill_worker', member: 'narrator' })).status, 400);

    // 3. 404 missing swarm or missing coordinator
    assert.equal(
      (
        await postControl({
          confirm: true,
          conversationId: '99999999-9999-4999-8999-999999999999',
          op: 'board_post',
          text: 'Missing swarm',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await postControl({
          confirm: true,
          conversationId: noCoordWorker,
          op: 'board_post',
          text: 'No coordinator',
        })
      ).status,
      404,
    );

    // 4. 409 unmerged worktree guard & forceUnmerged bypass
    const unmergedRes = await postControl({
      confirm: true,
      conversationId: fx.coord,
      op: 'kill_worker',
      member: 'worker',
      reason: 'Finished',
    });
    assert.equal(unmergedRes.status, 409);
    const unmergedBody = await unmergedRes.json();
    assert.equal(unmergedBody.error, 'unmerged worktree');
    assert.equal(unmergedBody.dirtyFiles, 1);
    assert.equal(unmergedBody.ahead, 1);
    assert.equal(delivered.length, 0);

    const forceKillRes = await postControl({
      confirm: true,
      conversationId: fx.coord,
      op: 'kill_worker',
      member: 'worker',
      forceUnmerged: true,
      reason: 'Abandoning scratch',
    });
    assert.equal(forceKillRes.status, 200);
    const forceKillBody = await forceKillRes.json();
    assert.equal(forceKillBody.ok, true);
    assert.equal(forceKillBody.op, 'kill_worker');
    assert.equal(forceKillBody.coordinatorId, fx.coord);
    assert.ok(forceKillBody.directivePreview.startsWith('[fleet-operator:kill_worker]'));
    assert.ok(forceKillBody.deliveredAt);

    const cleanKillRes = await postControl({
      confirm: true,
      conversationId: fx.coord,
      op: 'kill_worker',
      member: 'clean-worker',
    });
    assert.equal(cleanKillRes.status, 200);

    // 5. Remaining 5 ops (resolved via worker conversationId -> delivered to coordinatorId)
    const ops = [
      {
        op: 'board_post',
        payload: { confirm: true, conversationId: fx.worker, op: 'board_post', channel: 'backend', text: 'Run integration tests', replyToSeq: 2 },
      },
      {
        op: 'spawn_worker',
        payload: {
          confirm: true,
          conversationId: fx.coord,
          op: 'spawn_worker',
          name: 'qa-bot',
          brief: 'Verify backend endpoints',
          workspaceMode: 'share',
          channel: 'backend',
          model: 'gemini-3-pro',
          forkFrom: 'coordinator',
        },
      },
      {
        op: 'switch_model',
        payload: { confirm: true, conversationId: fx.coord, op: 'switch_model', member: 'worker', model: 'gemini-3-pro', reason: 'quota exhausted' },
      },
      {
        op: 'channel_op',
        payload: { confirm: true, conversationId: fx.coord, op: 'channel_op', action: 'create', channel: 'release-qa', topic: 'Wave E3 checks' },
      },
      {
        op: 'gate_verdict',
        payload: { confirm: true, conversationId: fx.coord, op: 'gate_verdict', verdict: 'verified', seq: 2, targetMember: 'worker', note: 'All 18 tests passed' },
      },
    ];

    for (const item of ops) {
      const res = await postControl(item.payload);
      assert.equal(res.status, 200, `Expected 200 for ${item.op}`);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.op, item.op);
      assert.equal(json.coordinatorId, fx.coord);
      assert.ok(json.directivePreview.startsWith(`[fleet-operator:${item.op}]`));
      assert.ok(typeof json.deliveredAt === 'string' && json.deliveredAt.length > 0);
    }

    assert.equal(delivered.length, 7);
    for (const d of delivered) {
      assert.equal(d.conv, fx.coord);
      const firstLine = d.msg.split('\n')[0];
      assert.ok(/^\[fleet-operator:[a-z_]+\]/.test(firstLine), `Invalid single-line header: ${firstLine}`);
    }

    // 6. GET /api/swarm snapshot exposes replyRefs
    const snapRes = await fetch(`${srv.url}/api/swarm?conversationId=${fx.coord}`);
    assert.equal(snapRes.status, 200);
    const snapJson = await snapRes.json();
    assert.deepEqual(snapJson.replyRefs, { 1: [2] });

    // 7. 501 when !sendMessageFn
    const noSendRes = await postControl(
      { confirm: true, conversationId: fx.coord, op: 'board_post', text: 'Should fail 501' },
      {},
      srvNoSend.url,
    );
    assert.equal(noSendRes.status, 501);
  } finally {
    await srv.close();
    await srvNoSend.close();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('GET /api/swarm serves swarms with channel control records without ReferenceError', async () => {
  const fx = setupFixtureAppData();
  const boardPath = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm', 'board.jsonl');
  writeFileSync(
    boardPath,
    [
      { seq: 1, agent: 'coordinator', text: '@all Launch', time: '12:00:00', control: { op: 'create', channel: 'backend', topic: 'Backend' } },
      { seq: 2, agent: 'coordinator', channel: 'backend', text: '@worker Build API', time: '12:01:00' },
      { seq: 3, agent: 'worker', channel: 'backend', text: '@coordinator Re #2: Ready', time: '12:02:00' },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });
  try {
    const res = await fetch(`${srv.url}/api/swarm?conversationId=${fx.coord}`);
    assert.equal(res.status, 200);
    const snap = await res.json();
    assert.equal(snap.channels?.length, 1);
    assert.equal(snap.channels[0].name, 'backend');
    assert.deepEqual(snap.replyRefs, { 2: [3] });

    const workerRes = await fetch(`${srv.url}/api/swarm?conversationId=${fx.worker}`);
    assert.equal(workerRes.status, 200);
    const workerSnap = await workerRes.json();
    assert.ok(Array.isArray(workerSnap.unseen));
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('POST /api/plan enforces concurrent CAS 409 conflict, corrupt plan recovery, and control-char guards', async () => {
  const fx = setupFixtureAppData();
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  try {
    const postPlan = (body) =>
      fetch(`${srv.url}/api/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Seed initial plan
    const initRes = await postPlan({
      confirm: true,
      conversationId: fx.coord,
      ifMatch: '',
      mode: 'patch',
      patch: { title: 'Concurrent Seed', gate: 'npm test' },
    });
    assert.equal(initRes.status, 200);
    const { etag } = await initRes.json();

    // Fire 5 concurrent updates holding the same etag -> strictly 1 wins (200), 4 conflict (409)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postPlan({
          confirm: true,
          conversationId: fx.coord,
          ifMatch: etag,
          mode: 'patch',
          patch: { title: `Winner-${i}` },
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409, 409, 409, 409]);

    for (const r of results) {
      if (r.status === 409) {
        const j = await r.json();
        assert.equal(j.error, 'plan changed on disk');
        assert.ok(j.etag && j.etag !== etag);
        assert.equal(j.plan?.etag, j.etag);
      }
    }

    // Corrupt plan.json on disk -> 409 returns current etag so caller can recover cleanly
    const planPath = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm', 'plan.json');
    writeFileSync(planPath, '{corrupt json');
    const staleRes = await postPlan({
      confirm: true,
      conversationId: fx.coord,
      ifMatch: '',
      mode: 'patch',
      patch: { title: 'Recovered' },
    });
    assert.equal(staleRes.status, 409);
    const staleJson = await staleRes.json();
    assert.equal(staleJson.plan, null);
    assert.ok(staleJson.etag && staleJson.etag.includes(':'));

    const recoverRes = await postPlan({
      confirm: true,
      conversationId: fx.coord,
      ifMatch: staleJson.etag,
      mode: 'replace',
      patch: { title: 'Recovered Plan', gate: 'node --test' },
    });
    assert.equal(recoverRes.status, 200);

    // Reject newline / Unicode line separator in ifMatch
    assert.equal(
      (await postPlan({ confirm: true, conversationId: fx.coord, ifMatch: 'abc\ndef', patch: { title: 'X' } })).status,
      400,
    );
    assert.equal(
      (await postPlan({ confirm: true, conversationId: fx.coord, ifMatch: 'abc\u2028def', patch: { title: 'X' } })).status,
      400,
    );
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('POST /api/control rejects adversarial fuzz payloads and protects coordinator/missing/killed members', async () => {
  const fx = setupFixtureAppData();
  const swDir = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm');
  writeFileSync(
    join(swDir, 'members.json'),
    JSON.stringify({
      title: 'Fuzz Control Swarm',
      members: {
        coordinator: { conversation_id: fx.coord, role: 'coordinator' },
        worker: { conversation_id: fx.worker, role: 'worker' },
        dead: { conversation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'worker', killed: true },
        monitor: { conversation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'monitor' },
      },
    }),
  );

  const delivered = [];
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
    sendMessageFn: async (conv, msg) => {
      delivered.push({ conv, msg });
      return { ok: true };
    },
  });

  try {
    const postControl = (body) =>
      fetch(`${srv.url}/api/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const badPayloads = [
      // Newlines & Unicode line separators in single-line header fields
      { confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'qa-bot', brief: 'ok', model: 'gemini\ninjected' },
      { confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'qa-bot', brief: 'ok', model: 'gemini\u2028injected' },
      { confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'qa-bot', brief: 'ok', forkFrom: 'worker\u2029bad' },
      { confirm: true, conversationId: fx.coord, op: 'switch_model', member: 'worker', model: 'gemini\r\nheader' },
      { confirm: true, conversationId: fx.coord, op: 'switch_model', member: 'worker', model: 'gemini-3', reason: 'quota\u0085nel' },
      { confirm: true, conversationId: fx.coord, op: 'channel_op', action: 'create', channel: 'ops', topic: 'line1\nline2' },
      { confirm: true, conversationId: fx.coord, op: 'gate_verdict', verdict: 'verified', seq: 1, targetMember: 'worker\n', note: 'ok' },
      // Oversized fields
      { confirm: true, conversationId: fx.coord, op: 'switch_model', member: 'worker', model: 'm'.repeat(257) },
      { confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'qa-bot', brief: 'b'.repeat(4001) },
      { confirm: true, conversationId: fx.coord, op: 'gate_verdict', verdict: 'verified', seq: 1, note: 'n'.repeat(4001) },
      // Invalid / reserved channel & member names & out-of-range seq
      { confirm: true, conversationId: fx.coord, op: 'board_post', channel: 'MAIN', text: 'hi' },
      { confirm: true, conversationId: fx.coord, op: 'board_post', channel: 'here', text: 'hi' },
      { confirm: true, conversationId: fx.coord, op: 'board_post', text: 'hi', replyToSeq: 1e30 },
      { confirm: true, conversationId: fx.coord, op: 'gate_verdict', verdict: 'verified', seq: 1e30, note: 'ok' },
      { confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'here', brief: 'hi' },
      { confirm: true, conversationId: fx.coord, op: 'spawn_worker', name: 'coordinator-2', brief: 'hi' },
      { confirm: true, conversationId: fx.coord, op: 'switch_model', member: 'all', model: 'gemini-3' },
      { confirm: true, conversationId: fx.coord, op: 'switch_model', member: '__proto__', model: 'gemini-3' },
      { confirm: true, conversationId: fx.coord, op: 'channel_op', action: 'subscribe', channel: 'ops', member: 'here' },
      // Protected coordinator even with explicit=true + forceUnmerged=true
      { confirm: true, conversationId: fx.coord, op: 'kill_worker', member: 'coordinator', explicit: true, allowProtected: true, forceProtected: true, forceUnmerged: true },
      { confirm: true, conversationId: fx.coord, op: 'kill_worker', member: 'constructor' },
    ];

    for (const p of badPayloads) {
      const r = await postControl(p);
      assert.equal(r.status, 400, `Expected 400 for payload ${JSON.stringify(p)}`);
    }

    // Missing and already-killed worker return 404 and 409 respectively
    assert.equal(
      (await postControl({ confirm: true, conversationId: fx.coord, op: 'kill_worker', member: 'ghost' })).status,
      404,
    );
    assert.equal(
      (await postControl({ confirm: true, conversationId: fx.coord, op: 'kill_worker', member: 'dead' })).status,
      409,
    );
    assert.equal(delivered.length, 0);
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('HTTP caches stay bounded under query and root churn', async () => {
  const fx = setupFixtureAppData();
  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  try {
    // Churn /api/worktrees with oversized and varying roots queries
    const hugeRoots = 'a'.repeat(9000);
    const hugeRes = await fetch(`${srv.url}/api/worktrees?roots=${hugeRoots}`);
    assert.equal(hugeRes.status, 200);
    const hugeJson = await hugeRes.json();
    assert.deepEqual(hugeJson.rejected, ['roots parameter too large']);

    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${srv.url}/api/worktrees?roots=${encodeURIComponent(`/nonexistent-root-${i}`)}`);
      assert.equal(r.status, 200);
      const s = await fetch(`${srv.url}/api/swarm?conversationId=unknown-conv-${i}`);
      assert.equal(s.status, 200);
    }
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('GET /api/swarm/delta supports full, incremental append, fs.watch wakeup (<300ms), timeout, truncation, abort cleanup, and 400/404 validation', async () => {
  const fx = setupFixtureAppData();
  const swDir = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm');
  const boardPath = join(swDir, 'board.jsonl');
  const workerLogs = join(fx.appData, 'brain', fx.worker, '.system_generated', 'logs');
  mkdirSync(workerLogs, { recursive: true });
  const trPath = join(workerLogs, 'transcript.jsonl');
  writeFileSync(
    trPath,
    JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 100, output_tokens: 20 }) + '\n',
  );

  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  try {
    // 1. Capabilities advertised in /api/health and /api/swarm
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.deltaStream, true);
    assert.equal(health.capabilities?.deltaStream, true);

    const snap0 = await (await fetch(`${srv.url}/api/swarm?conversationId=${fx.coord}`)).json();
    assert.equal(snap0.capabilities?.deltaStream, true);
    assert.equal(typeof snap0.contextLimit, 'number');
    assert.equal(typeof snap0.contextPct, 'number');
    assert.equal(typeof snap0.cost?.totalUsd, 'number');
    assert.equal(typeof snap0.cost?.cacheHitPct, 'number');
    assert.equal(typeof snap0.cost?.cacheSavingsUsd, 'number');
    assert.equal(typeof snap0.cost?.pricingKnown, 'boolean');
    assert.ok(snap0.byModel && typeof snap0.byModel === 'object');
    assert.equal(typeof snap0.burnSummary?.costUsd, 'number');
    assert.equal(typeof snap0.burnSummary?.pricingKnown, 'boolean');

    // 2. Validation errors (400 / 404)
    const badQueries = [
      `conversationId=${encodeURIComponent('../evil')}`,
      `conversationId=ab`,
      `conversationId=${fx.coord}&since=-1`,
      `conversationId=${fx.coord}&since=abc`,
      `conversationId=${fx.coord}&since=1.5`,
      `conversationId=${fx.coord}&waitMs=-5`,
      `conversationId=${fx.coord}&waitMs=25001`,
      `conversationId=${fx.coord}&waitMs=nope`,
    ];
    for (const qs of badQueries) {
      const r = await fetch(`${srv.url}/api/swarm/delta?${qs}`);
      assert.equal(r.status, 400, `Expected 400 for ?${qs}`);
    }
    const notFound = await fetch(`${srv.url}/api/swarm/delta?conversationId=00000000-0000-4000-8000-000000000000`);
    assert.equal(notFound.status, 404);

    // 3. since=0 returns mode: "full"
    const fullRes = await fetch(`${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=0`);
    assert.equal(fullRes.status, 200);
    const fullJson = await fullRes.json();
    assert.equal(fullJson.ok, true);
    assert.equal(fullJson.mode, 'full');
    assert.equal(fullJson.unchanged, false);
    assert.equal(fullJson.head, 1);
    assert.equal(fullJson.etag, snap0.etag);

    // 4. Unchanged timeout with waitMs=120 resolves unchanged: true and leaves zero leaked watchers
    const t0 = Date.now();
    const timeoutRes = await fetch(
      `${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=1&etag=${encodeURIComponent(fullJson.etag)}&waitMs=120`,
    );
    const elapsedTimeout = Date.now() - t0;
    assert.equal(timeoutRes.status, 200);
    const timeoutJson = await timeoutRes.json();
    assert.equal(timeoutJson.ok, true);
    assert.equal(timeoutJson.unchanged, true);
    assert.equal(timeoutJson.head, 1);
    assert.ok(elapsedTimeout >= 90, `Expected >=90ms wait before timeout, got ${elapsedTimeout}ms`);
    assert.deepEqual(srv.getDeltaStats(), { activeWaiters: 0, activeSwarmWatchers: 0, activeFsWatchers: 0 });

    // 5. Live fs.watch wakeup (<300ms) on board.jsonl append while parked on waitMs=5000
    let appendAt = 0;
    setTimeout(() => {
      appendAt = Date.now();
      appendFileSync(
        boardPath,
        JSON.stringify({ seq: 2, agent: 'coordinator', text: '@worker Re #1: live delta push' }) + '\n',
      );
    }, 50);

    const delta1Res = await fetch(
      `${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=1&etag=${encodeURIComponent(fullJson.etag)}&waitMs=5000`,
    );
    const wakeLatency = Date.now() - appendAt;
    assert.equal(delta1Res.status, 200);
    const delta1 = await delta1Res.json();
    assert.equal(delta1.ok, true);
    assert.equal(delta1.mode, 'delta');
    assert.equal(delta1.unchanged, false);
    assert.equal(delta1.head, 2);
    assert.equal(delta1.messagesDelta.length, 1);
    assert.equal(delta1.messagesDelta[0].seq, 2);
    assert.deepEqual(delta1.replyRefsDelta, { 1: [2] });
    assert.equal(delta1.edgesDelta.length, 1);
    assert.ok(wakeLatency < 300, `Expected <300ms fs.watch wakeup on board append, got ${wakeLatency}ms`);
    assert.deepEqual(srv.getDeltaStats(), { activeWaiters: 0, activeSwarmWatchers: 0, activeFsWatchers: 0 });

    // 6. Live fs.watch wakeup (<300ms) on transcript.jsonl append while parked
    let trAppendAt = 0;
    setTimeout(() => {
      trAppendAt = Date.now();
      appendFileSync(
        trPath,
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 250, output_tokens: 50 }) + '\n',
      );
    }, 50);

    const delta2Res = await fetch(
      `${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=2&etag=${encodeURIComponent(delta1.etag)}&waitMs=5000`,
    );
    const trWakeLatency = Date.now() - trAppendAt;
    assert.equal(delta2Res.status, 200);
    const delta2 = await delta2Res.json();
    assert.equal(delta2.mode, 'delta');
    assert.equal(delta2.messagesDelta.length, 0);
    assert.equal(delta2.usage.totalTokens, 420);
    assert.equal(typeof delta2.contextLimit, 'number');
    assert.equal(typeof delta2.contextPct, 'number');
    assert.equal(typeof delta2.cost?.totalUsd, 'number');
    assert.ok(delta2.byModel && typeof delta2.byModel === 'object');
    assert.equal(typeof delta2.burnSummary?.costUsd, 'number');
    assert.ok(trWakeLatency < 300, `Expected <300ms wakeup on transcript append, got ${trWakeLatency}ms`);
    assert.deepEqual(srv.getDeltaStats(), { activeWaiters: 0, activeSwarmWatchers: 0, activeFsWatchers: 0 });

    // 7. Client abort cleans up active waiter and fs.watch immediately
    const ac = new AbortController();
    const parkedPromise = fetch(
      `${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=2&etag=${encodeURIComponent(delta2.etag)}&waitMs=10000`,
      { signal: ac.signal },
    ).catch((err) => err);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(srv.getDeltaStats().activeWaiters, 1);
    assert.ok(srv.getDeltaStats().activeFsWatchers >= 1);
    ac.abort();
    await parkedPromise;
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(srv.getDeltaStats(), { activeWaiters: 0, activeSwarmWatchers: 0, activeFsWatchers: 0 });

    // 8. Truncation falls back to mode: "full"
    writeFileSync(
      boardPath,
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@worker reset board' }) + '\n',
    );
    const truncRes = await fetch(
      `${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=2&etag=${encodeURIComponent(delta2.etag)}&waitMs=0`,
    );
    assert.equal(truncRes.status, 200);
    const truncJson = await truncRes.json();
    assert.equal(truncJson.mode, 'full');
    assert.equal(truncJson.head, 1);
    assert.equal(truncJson.messages.length, 1);

    // 9. Sidecar handler mode (isSidecar: true) advertises sseStream: false and deltaStream: true and serves /api/swarm/delta
    const sidecarHandlers = createFleetHandlers({
      store,
      distDir: fx.distDir,
      appDataDir: fx.appData,
      defaultConversationId: fx.coord,
      isSidecar: true,
    });
    const sidecarHealth = JSON.parse(sidecarHandlers.getHealthPacked().raw.toString('utf8'));
    assert.equal(sidecarHealth.sseStream, false);
    assert.equal(sidecarHealth.deltaStream, true);
    assert.equal(sidecarHealth.capabilities?.sseStream, false);
    assert.equal(sidecarHealth.capabilities?.deltaStream, true);

    const sidecarDelta = await sidecarHandlers.getSwarmDelta({ conversationId: fx.coord, since: '0', waitMs: '0' });
    assert.equal(sidecarDelta.status, 200);
    const sidecarDeltaJson = JSON.parse(sidecarDelta.packed.raw.toString('utf8'));
    assert.equal(sidecarDeltaJson.mode, 'full');
    assert.equal(sidecarDeltaJson.capabilities?.isSidecar, true);
    assert.equal(sidecarDeltaJson.capabilities?.deltaStream, true);
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('GET /api/transcript works across standalone HTTP and runSidecarApp RPC with pagination, filters, scrubbing, and confinement', async () => {
  const fx = setupFixtureAppData();
  const workerLogs = join(fx.appData, 'brain', fx.worker, '.system_generated', 'logs');
  mkdirSync(workerLogs, { recursive: true });

  const outsideFile = join(fx.dir, 'outside-transcript.jsonl');
  writeFileSync(outsideFile, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'SECRET' }) + '\n');
  const evilMemberId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const evilLogs = join(fx.appData, 'brain', evilMemberId, '.system_generated', 'logs');
  mkdirSync(evilLogs, { recursive: true });
  symlinkSync(outsideFile, join(evilLogs, 'transcript.jsonl'));

  const swDir = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm');
  writeFileSync(
    join(swDir, 'members.json'),
    JSON.stringify({
      title: 'Transcript HTTP Test',
      members: {
        coordinator: { conversation_id: fx.coord, role: 'coordinator' },
        worker: { conversation_id: fx.worker, role: 'worker' },
        evil_sym: { conversation_id: evilMemberId, role: 'worker' },
      },
    }),
  );

  const bigStderr = 'E'.repeat(2600);
  writeFileSync(
    join(workerLogs, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T11:00:00Z',
        content: 'Run tests in /home/cayleb/repo with ghp_abcdef1234567890',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T11:00:01Z',
        model: 'gemini-3-pro',
        input_tokens: 400,
        cache_read_tokens: 100,
        output_tokens: 40,
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', token: 'Bearer secret-bearer-999' } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'ERROR',
        created_at: '2026-11-26T11:00:03Z',
        content: `Created At: 2026-11-26T11:00:01Z\nCompleted At: 2026-11-26T11:00:03Z\nstderr: sk-ant-secret12345678\n${bigStderr}`,
      }),
      JSON.stringify({
        step_index: 3,
        type: 'ERROR_MESSAGE',
        status: 'ERROR',
        created_at: '2026-11-26T11:00:05Z',
        error: 'Rate limit AIzaSyFakeKey1234567890',
      }),
    ].join('\n') + '\n',
  );

  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  let hook = null;
  try {
    // 1. /api/health advertises capabilities.transcriptInspector
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.capabilities?.transcriptInspector, true);
    assert.equal(health.capabilities?.deltaStream, true);

    // 2. Standalone HTTP GET /api/transcript pagination + correlation + scrubbing
    const p1Res = await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&limit=2`);
    assert.equal(p1Res.status, 200);
    const p1 = await p1Res.json();
    assert.equal(p1.ok, true);
    assert.equal(p1.member, 'worker');
    assert.equal(p1.conversationId, fx.worker);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.nextBefore, 1);
    assert.deepEqual(p1.steps.map((s) => s.stepIndex), [3, 1]);
    assert.ok(!p1.steps[0].error.includes('AIzaSyFakeKey1234567890'));
    assert.equal(p1.steps[1].durationMs, 2000);
    assert.equal(p1.steps[1].toolCalls[0].status, 'ERROR');
    assert.ok(!p1.steps[1].toolCalls[0].outputPreview.includes('sk-ant-secret12345678'));
    assert.ok(!JSON.stringify(p1.steps[1].toolCalls[0].args).includes('secret-bearer-999'));
    assert.ok(Buffer.byteLength(p1.steps[1].toolCalls[0].outputPreview, 'utf8') <= 2048);

    const p2Res = await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&before=${p1.nextBefore}&limit=2`);
    assert.equal(p2Res.status, 200);
    const p2 = await p2Res.json();
    assert.equal(p2.hasMore, false);
    assert.equal(p2.nextBefore, null);
    assert.deepEqual(p2.steps.map((s) => s.stepIndex), [0]);
    assert.ok(p2.steps[0].content.includes('~/repo'));
    assert.ok(!p2.steps[0].content.includes('ghp_abcdef1234567890'));

    // 3. filter=errors and filter=tools
    const errRes = await (await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&filter=errors`)).json();
    assert.deepEqual(errRes.steps.map((s) => s.stepIndex), [3, 1]);
    const toolRes = await (await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&filter=tools`)).json();
    assert.deepEqual(toolRes.steps.map((s) => s.stepIndex), [1]);

    // 3b. limit clamping (limit=0 -> 1, limit=200 -> accepted & bounded) and Host-403
    const clampedMin = await (await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&limit=0`)).json();
    assert.equal(clampedMin.steps.length, 1);
    const clampedMax = await (await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&limit=200`)).json();
    assert.equal(clampedMax.steps.length, 3);

    // 4. Standalone validation & confinement rejections (400 / 404)
    assert.equal((await fetch(`${srv.url}/api/transcript?member=worker`)).status, 400);
    assert.equal((await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}`)).status, 400);
    assert.equal((await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=missing`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=evil_sym`)).status, 400);
    assert.equal((await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&filter=bad`)).status, 400);
    assert.equal((await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&before=abc`)).status, 400);

    // 5. runSidecarApp RPC invocation via SidecarApp mock
    const rpcState = { app: null };
    globalThis.__FLEET_TEST_SIDECAR_RPC = rpcState;
    globalThis.__FLEET_TEST_COORD = fx.coord;
    hook = registerHooks({
      resolve(specifier, ctx, next) {
        if (specifier === 'sidecar_sdk') return { shortCircuit: true, url: 'sidecar_sdk:fleet-test-mock' };
        return next(specifier, ctx);
      },
      load(url, ctx, next) {
        if (url === 'sidecar_sdk:fleet-test-mock') {
          return {
            shortCircuit: true,
            format: 'module',
            source: `
              export class Response {
                constructor(body, opts = {}) {
                  this.body = body;
                  this.status = opts.status ?? 200;
                  this.contentType = opts.contentType || 'application/json';
                  this.headers = opts.headers || {};
                }
              }
              export class SidecarApp {
                constructor() {
                  this.config = { conversationId: globalThis.__FLEET_TEST_COORD || '' };
                  this.routes = new Map();
                  globalThis.__FLEET_TEST_SIDECAR_RPC.app = this;
                }
                page() {}
                api(route, fn, method = 'GET') { this.routes.set(method + ' ' + route, fn); }
                async sendMessage() { return { ok: true }; }
                async run() {}
              }
            `,
          };
        }
        return next(url, ctx);
      },
    });

    await runSidecarApp({ appDataDir: fx.appData });
    const app = rpcState.app;
    assert.ok(app, 'runSidecarApp should instantiate SidecarApp');
    const healthHandler = app.routes.get('GET /api/health');
    const trHandler = app.routes.get('GET /api/transcript');
    assert.equal(typeof healthHandler, 'function');
    assert.equal(typeof trHandler, 'function');

    const rpcHealthResp = await healthHandler();
    const rpcHealth = JSON.parse(Buffer.from(rpcHealthResp.body).toString('utf8'));
    assert.equal(rpcHealth.capabilities?.isSidecar, true);
    assert.equal(rpcHealth.capabilities?.transcriptInspector, true);

    const rpcTrResp = await trHandler({ conversationId: fx.coord, member: 'worker', limit: 2, filter: 'errors' });
    assert.equal(rpcTrResp.status, 200);
    const rpcTr = JSON.parse(Buffer.from(rpcTrResp.body).toString('utf8'));
    assert.equal(rpcTr.ok, true);
    assert.deepEqual(rpcTr.steps.map((s) => s.stepIndex), [3, 1]);

    const rpcSymResp = await trHandler({ conversationId: fx.coord, member: 'evil_sym' });
    assert.equal(rpcSymResp.status, 400);
  } finally {
    hook?.deregister?.();
    delete globalThis.__FLEET_TEST_SIDECAR_RPC;
    delete globalThis.__FLEET_TEST_COORD;
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('E1/E2 HTTP hardening: rapid delta reconnects clean waiters without cap exhaustion and /api/transcript enforces binary/UTF-8 & symlink safety', async () => {
  const fx = setupFixtureAppData();
  const swDir = join(fx.appData, 'brain', fx.coord, '.system_generated', 'swarm');
  const workerLogs = join(fx.appData, 'brain', fx.worker, '.system_generated', 'logs');
  mkdirSync(workerLogs, { recursive: true });

  const symLogsMember = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const symLogsParent = join(fx.appData, 'brain', symLogsMember, '.system_generated');
  mkdirSync(symLogsParent, { recursive: true });
  const outsideDir = join(fx.dir, 'outside-tr');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'NOPE' }) + '\n');
  symlinkSync(outsideDir, join(symLogsParent, 'logs'));

  writeFileSync(
    join(swDir, 'members.json'),
    JSON.stringify({
      title: 'HTTP Hardening',
      members: {
        coordinator: { conversation_id: fx.coord, role: 'coordinator' },
        worker: { conversation_id: fx.worker, role: 'worker' },
        sym_logs: { conversation_id: symLogsMember, role: 'worker' },
      },
    }),
  );
  const boardPath = join(swDir, 'board.jsonl');
  writeFileSync(boardPath, JSON.stringify({ seq: 1, agent: 'coordinator', text: '@worker init' }) + '\n');

  // >512 KiB transcript with binary garbage + valid UTF-8 step + prose vs short secrets
  const binLine = Buffer.concat([Buffer.from([0x7b, 0xff, 0xfe, 0x00]), Buffer.alloc(4096, 0x80), Buffer.from('\n')]);
  const trChunks = [];
  for (let i = 0; i < 135; i++) trChunks.push(binLine);
  trChunks.push(
    Buffer.from(
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Bearer authentication ok; leaked Bearer ab12 and ghp_1234 and sk-ab12 🚀',
        tool_calls: [],
      }) + '\n',
      'utf8',
    ),
  );
  writeFileSync(join(workerLogs, 'transcript.jsonl'), Buffer.concat(trChunks));

  const srv = await startStandaloneServer({
    port: 0,
    distDir: fx.distDir,
    appDataDir: fx.appData,
    defaultConversationId: fx.coord,
  });

  try {
    const snap = await (await fetch(`${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=0`)).json();
    assert.equal(snap.mode, 'full');

    // 1. Rapidly open & abort 80 (> MAX_DELTA_WAITERS=64) long-poll sockets via http.request.destroy() and raw TCP close
    for (let batch = 0; batch < 5; batch++) {
      await Promise.all(
        Array.from({ length: 16 }, (_, idx) =>
          new Promise((resolve) => {
            if ((batch * 16 + idx) % 2 === 0) {
              const req = http.request(
                {
                  hostname: '127.0.0.1',
                  port: srv.port,
                  path: `/api/swarm/delta?conversationId=${fx.coord}&since=1&etag=${encodeURIComponent(snap.etag)}&waitMs=15000`,
                },
                () => {},
              );
              req.on('error', () => {});
              req.end();
              setTimeout(() => {
                req.destroy();
                resolve();
              }, 15);
            } else {
              const sock = net.connect(srv.port, '127.0.0.1', () => {
                sock.write(
                  `GET /api/swarm/delta?conversationId=${fx.coord}&since=1&etag=${encodeURIComponent(snap.etag)}&waitMs=15000 HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n\r\n`,
                );
                setTimeout(() => {
                  sock.destroy();
                  resolve();
                }, 15);
              });
              sock.on('error', () => resolve());
            }
          }),
        ),
      );
    }

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(srv.getDeltaStats(), { activeWaiters: 0, activeSwarmWatchers: 0, activeFsWatchers: 0 });

    // Next delta long-poll succeeds (never 503 exhausted)
    const afterStorm = await fetch(
      `${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=1&etag=${encodeURIComponent(snap.etag)}&waitMs=60`,
    );
    assert.equal(afterStorm.status, 200);
    const afterStormJson = await afterStorm.json();
    assert.equal(afterStormJson.unchanged, true);
    assert.deepEqual(srv.getDeltaStats(), { activeWaiters: 0, activeSwarmWatchers: 0, activeFsWatchers: 0 });

    // 2. Corrupt partial tail line then truncate mid-delta -> transitions cleanly to mode: "full"
    appendFileSync(boardPath, '{"seq":2,"partial');
    const partialRes = await (await fetch(`${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=1&etag=${encodeURIComponent(snap.etag)}&waitMs=0`)).json();
    assert.equal(partialRes.mode, 'delta');
    assert.equal(partialRes.head, 1);

    truncateSync(boardPath, 0);
    const truncRes = await (await fetch(`${srv.url}/api/swarm/delta?conversationId=${fx.coord}&since=1&etag=${encodeURIComponent(partialRes.etag)}&waitMs=0`)).json();
    assert.equal(truncRes.mode, 'full');
    assert.equal(truncRes.head, 0);

    // 3. /api/transcript rejects intermediate symlink & %2e%2e traversal, and scrubs short secrets cleanly
    assert.equal((await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=sym_logs`)).status, 400);
    assert.equal((await fetch(`${srv.url}/api/transcript?conversationId=%2e%2e&member=worker`)).status, 400);

    const trRes = await fetch(`${srv.url}/api/transcript?conversationId=${fx.coord}&member=worker&limit=5`);
    assert.equal(trRes.status, 200);
    const trJson = await trRes.json();
    assert.deepEqual(trJson.steps.map((s) => s.stepIndex), [1]);
    assert.ok(trJson.steps[0].content.includes('Bearer authentication ok'));
    assert.ok(trJson.steps[0].content.includes('🚀'));
    assert.ok(!trJson.steps[0].content.includes('ab12'));
    assert.ok(!trJson.steps[0].content.includes('ghp_1234'));
    assert.ok(!trJson.steps[0].content.includes('sk-ab12'));
  } finally {
    await srv.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
