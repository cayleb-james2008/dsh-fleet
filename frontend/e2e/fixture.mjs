// fixture.mjs: build Fleet, run it on a free port with the fixture agent and a throwaway git repo, hand it the five
// fixture sessions (seed), stop it and every agent it started.
// Everything it writes (data, logs, pid files, shots) goes to frontend/e2e/.out.
//   node e2e/fixture.mjs start   start on fresh data and print the URL      node e2e/fixture.mjs stop
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(E2E, '../..')
export const OUT = path.join(E2E, '.out'), RUN = path.join(OUT, 'run')
const STATE = path.join(RUN, 'ports.json'), FIX = path.join(E2E, 'fixtures')
const AGENT = path.join(RUN, 'agent.sh')
const BIN = path.join(process.env.CARGO_TARGET_DIR || path.join(ROOT, 'target'), 'debug/fleet-rs')
// Playwright comes from the frontend's own devDependencies; the browser is the installed Chrome for Testing build.
export const CHROME = process.env.E2E_CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
export const launch = (opts = {}) => chromium.launch({ headless: true, executablePath: CHROME, ...opts })

let st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null
export let BASE = st && `http://127.0.0.1:${st.app}/`

export const results = []
export function report(name, checks) {
  const pass = checks.filter(c => c.pass ?? c.p).length
  results.push({ name, pass, total: checks.length })
  console.log(`\n${name}: ${pass}/${checks.length} pass`)
  if (pass !== checks.length) process.exitCode = 1
}

export function build() {
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
  const link = path.join(ROOT, 'rune/node_modules')
  if (!fs.existsSync(link)) fs.symlinkSync('../frontend/node_modules', link)
  run('npm', ['run', 'build'], path.join(ROOT, 'frontend'))
  // the binary embeds assets/index.html with include_str: touch the sources so cargo rebuilds
  const now = new Date()
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) if (f.endsWith('.rs')) fs.utimesSync(path.join(ROOT, 'src', f), now, now)
  run('cargo', ['build', '--offline'], ROOT)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const listening = port => new Promise(res => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
const freePort = () => new Promise((res, rej) => { const s = net.createServer().once('error', rej).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
async function pickPort(taken) { for (;;) { const p = await freePort(); if (p !== 9230 && !taken.includes(p)) return p } }

// Only ever signal a pid this fixture wrote, and only while its command line is still the one it started.
function alive(name, mark) {
  const f = path.join(RUN, `${name}.pid`)
  if (!fs.existsSync(f)) return 0
  const pid = Number(fs.readFileSync(f, 'utf8'))
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(mark) ? pid : 0 } catch { return 0 }
}
async function kill(name, mark) {
  const pid = alive(name, mark)
  if (pid) {
    try { process.kill(-pid, 'SIGTERM') } catch {}
    for (let i = 0; i < 30 && alive(name, mark); i++) await sleep(100)
    if (alive(name, mark)) try { process.kill(-pid, 'SIGKILL') } catch {}
    for (let i = 0; i < 20 && alive(name, mark); i++) await sleep(100)
  }
  fs.rmSync(path.join(RUN, `${name}.pid`), { force: true })
}
function launchProc(name, cmd, args, env) {
  const log = fs.openSync(path.join(RUN, `${name}.log`), 'w')
  const child = spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', log, log] })
  fs.closeSync(log); child.unref()
  fs.writeFileSync(path.join(RUN, `${name}.pid`), String(child.pid))
}

export async function start({ fresh = false } = {}) {
  fs.mkdirSync(RUN, { recursive: true })
  if (!st) { st = { app: await pickPort([]) }; fs.writeFileSync(STATE, JSON.stringify(st)) }
  BASE = `http://127.0.0.1:${st.app}/`
  await kill('app', BIN); await killAgents()
  for (let i = 0; i < 20 && await listening(st.app); i++) await sleep(200)
  if (await listening(st.app)) throw new Error(`port ${st.app} is still held`)
  if (fresh || !fs.existsSync(path.join(RUN, 'data'))) {
    for (const d of ['data', 'repo']) fs.rmSync(path.join(RUN, d), { recursive: true, force: true })
    fs.mkdirSync(path.join(RUN, 'data'))
    const git = (...a) => execFileSync('git', ['-C', path.join(RUN, 'repo'), ...a], { stdio: 'ignore' })
    execFileSync('git', ['init', '-q', '-b', 'main', path.join(RUN, 'repo')], { stdio: 'ignore' })
    fs.writeFileSync(path.join(RUN, 'repo/README.md'), 'seed\n')
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('add', '-A'); git('commit', '-qm', 'init')
  }
  for (const d of ['home', 'tmp', 'agents']) fs.mkdirSync(path.join(RUN, d), { recursive: true })
  fs.copyFileSync(path.join(FIX, 'agent.sh'), AGENT); fs.chmodSync(AGENT, 0o755)
  const env = { PATH: '/usr/bin:/bin', HOME: path.join(RUN, 'home'), TMPDIR: path.join(RUN, 'tmp'), TZ: 'UTC', LANG: 'C.UTF-8' }
  launchProc('app', BIN, ['policies.rn'], { ...env, FLEET_AGENT: AGENT, FLEET_DATA: path.join(RUN, 'data'), PORT: String(st.app), FLEET_UPDATE_MODE: 'off', FLEET_NO_OPEN: '1' })
  for (let i = 0; i < 50; i++) {
    if (await fetch(BASE + 'api/policy').then(r => r.ok, () => false)) return BASE
    await sleep(300)
  }
  throw new Error('Fleet did not come up:\n' + fs.readFileSync(path.join(RUN, 'app.log'), 'utf8').slice(-800))
}
export const reset = () => start({ fresh: true })

// Five fixture sessions: two pass, one fails its check, two stream for ten minutes.
export async function seed() {
  const repo = path.join(RUN, 'repo'), origin = new URL(BASE).origin
  for (const s of [
    { task: 'Add the export button to the reports page and cover it with a test' },
    { task: 'Write the changelog entry for 0.4' },
    { task: 'Fix the sign-in redirect loop on the staging host', check: 'false' },
    { task: 'slow: Migrate the billing tables to the new schema' },
    { task: 'slow: Profile the search endpoint and cut p95 under 200 ms' },
  ]) {
    const r = await fetch(BASE + 'api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ repo, project: 'fixture', ...s }) })
    if (!r.ok) throw new Error(`seed: ${r.status} ${await r.text()}`)
  }
}

// Agents run in their own process groups, so stopping Fleet does not reach them: each one wrote its pid to RUN/agents.
async function killAgents() {
  const dir = path.join(RUN, 'agents')
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) await kill(`agents/${path.basename(f, '.pid')}`, AGENT)
}

export async function stop() {
  await kill('app', BIN); await killAgents()
  fs.rmSync(STATE, { force: true }); st = null; BASE = null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2]
  if (cmd === 'start') console.log(await start({ fresh: true }))
  else if (cmd === 'stop') await stop()
  else { console.error('usage: node e2e/fixture.mjs start|stop'); process.exit(2) }
}
