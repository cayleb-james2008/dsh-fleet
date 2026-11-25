// gate.mjs: Fleet v0.12.0 Desktop-Workbench E2E gate.
// Verifies 1440/1280/768/390/320 in light & dark, DOM Range text clipping, 3-pane collapsible workbench,
// Goal-to-DAG planner, virtualized 55k transcript, Unified/Split diff, Check/Auto-heal timeline, DAG graph,
// PR confirmation gate, Settings-only Light/Dark (#67), zero Rune jargon (#155), and prefers-reduced-motion.
import { BASE, OUT as E2E_OUT, launch, reset, seed, report } from './fixture.mjs'
import fs from 'node:fs'
const OUT = `${E2E_OUT}/gate`
fs.mkdirSync(OUT, { recursive: true })
await reset(); await seed()
await new Promise(r => setTimeout(r, 8000))
const b = await launch()

const MEASURE = () => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const rgba = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const L = ([r, g, bb]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bb)
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0.5) return c.slice(0, 3) } return [255, 255, 255] }
  const inter = [...document.querySelectorAll('a[href],button,input,select,textarea,[role=button],summary,[tabindex]:not([tabindex="-1"])')].filter(vis)
  const name = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').trim()
  const min = innerWidth < 768 ? 44 : 24
  const small = inter.filter(e => { const r = e.getBoundingClientRect(); return r.width < min || r.height < min }).map(e => `${e.tagName}:${name(e).slice(0, 30)}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`)
  const unnamed = inter.filter(e => !name(e) && !(e.id && document.querySelector(`label[for="${e.id}"]`))).map(e => e.outerHTML.slice(0, 90))
  const low = []; let minFont = 99; let minRatio = 99
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
    if (el.closest('[aria-hidden="true"]')) continue
    const fs = parseFloat(getComputedStyle(el).fontSize); minFont = Math.min(minFont, fs)
    const fg = rgba(getComputedStyle(el).color); const bg = bgOf(el)
    const a = fg[3]; const mix = [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a))
    const l1 = L(mix), l2 = L(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    minRatio = Math.min(minRatio, ratio)
    if (ratio < (fs >= 18.66 ? 3 : 4.5)) low.push(`${ratio.toFixed(2)}:${(el.innerText || '').trim().slice(0, 30)}`)
  }
  const clipped = [...document.querySelectorAll('body *')].filter(e => {
    if (!vis(e)) return false
    const r = e.getBoundingClientRect()
    if (r.right <= innerWidth + 1 && r.left >= -1) return false
    for (let p = e.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX
      if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return false
    }
    return true
  }).map(e => e.tagName + '.' + String(e.className?.baseVal ?? e.className).slice(0, 40) + ' r=' + Math.round(e.getBoundingClientRect().right)).slice(0, 5)
  const rangeClipped = []
  for (const el of document.querySelectorAll('header *, nav *, h1, h2, h3, button, badge, [role="tab"]')) {
    if (!vis(el) || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
    const st = getComputedStyle(el)
    if (st.textOverflow === 'ellipsis' || st.overflowX === 'auto' || st.overflowX === 'scroll') continue
    const cr = el.getBoundingClientRect()
    const range = document.createRange()
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue
      range.selectNodeContents(node)
      const tr = range.getBoundingClientRect()
      if (tr.width > 0 && (tr.right > cr.right + 2 || tr.left < cr.left - 2)) {
        rangeClipped.push(`${el.tagName}:${node.textContent.trim().slice(0, 24)}:${Math.round(tr.right)}>${Math.round(cr.right)}`)
      }
    }
  }
  const detailsCount = document.querySelectorAll('details').length
  return {
    clipped,
    rangeClipped: rangeClipped.slice(0, 6),
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    interactive: inter.length,
    smallTargets: small.length,
    smallSample: small.slice(0, 12),
    unnamed: unnamed.slice(0, 4),
    lowContrast: low.length,
    lowSample: low.slice(0, 6),
    minRatio: Math.round(minRatio * 100) / 100,
    minFont,
    detailsCount,
  }
}

const errs = [], checks = []
const ok = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')) }
async function open(w, h, theme = 'light', extra = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme, hasTouch: w < 768, ...extra })
  await ctx.addInitScript((t) => { try { localStorage.setItem('fleet-theme', t) } catch {} }, theme)
  const p = await ctx.newPage()
  p.__allow = /$^/
  p.on('pageerror', e => errs.push(`${w}-${theme}: pageerror ${e.message}`))
  p.on('console', m => { if (m.type() === 'error' && !p.__allow.test(m.text())) errs.push(`${w}-${theme}: ${m.text().slice(0, 140)} @ ${m.location().url}`) })
  return { ctx, p }
}
const ready = p => p.waitForSelector('div[aria-label="Session lanes"] article', { timeout: 15000 })
const cards = p => p.locator('div[aria-label="Session lanes"] article')

for (const theme of ['light', 'dark']) for (const [vn, w, h] of [['1440', 1440, 900], ['1280', 1280, 800], ['768', 768, 1024], ['390', 390, 844], ['320', 320, 640]]) {
  const { ctx, p } = await open(w, h, theme)
  await p.goto(BASE); await ready(p); await p.waitForTimeout(800)
  const m = await p.evaluate(MEASURE)
  ok(`measure ${vn} ${theme}`, m.docOverflow <= 0 && m.clipped.length === 0 && m.rangeClipped.length === 0 && m.smallTargets === 0 && m.lowContrast === 0 && m.unnamed.length === 0 && m.minFont >= 12 && m.detailsCount === 0,
    `overflow ${m.docOverflow} clipped ${m.clipped.join(' | ')} rangeClip ${m.rangeClipped.join(' | ')} small ${m.smallTargets} ${m.smallSample.join(' | ')} low ${m.lowContrast} ${m.lowSample.join(' | ')} unnamed ${m.unnamed.join(' | ')} minFont ${m.minFont} details ${m.detailsCount}`)
  if (vn === '1440' || vn === '1280' || vn === '390') await p.screenshot({ path: `${OUT}/workbench-${vn}-${theme}.png` })
  await ctx.close()
}

{
  const { ctx, p } = await open(1440, 900)
  await p.goto(BASE); await ready(p)

  // Desktop 3-pane workbench check: left inbox rail + central workspace + right inspector + bottom status bar
  const inboxCount = await cards(p).count()
  const inspector = p.locator('aside[aria-label="Session inspector"]')
  const metricsStrip = p.locator('[data-testid="board-metrics-strip"]')
  ok('desktop 3-pane workbench opens with seeded sessions, active workspace, inspector, and metrics strip',
    inboxCount === 5 && await inspector.isVisible() && await metricsStrip.isVisible(),
    `sessions=${inboxCount}`)

  // Collapsible left & right rails
  await p.getByRole('button', { name: 'Toggle inbox rail' }).click(); await p.waitForTimeout(280)
  const leftCollapsed = (await p.locator('div[aria-label="Session lanes"]').count()) === 0
  await p.getByRole('button', { name: 'Toggle inbox rail' }).click(); await p.waitForTimeout(280)
  await p.getByRole('button', { name: 'Toggle inspector rail' }).click(); await p.waitForTimeout(280)
  const rightCollapsed = (await inspector.count()) === 0
  await p.getByRole('button', { name: 'Toggle inspector rail' }).click(); await p.waitForTimeout(280)
  ok('left inbox rail and right inspector rail toggle cleanly', leftCollapsed && rightCollapsed)

  // Live streaming tail on running session in inbox
  const slowCard = p.locator('article[aria-label^="slow: Migrate"]')
  const tailText0 = await slowCard.locator('[data-testid="live-tail"]').innerText().catch(() => '')
  await p.waitForTimeout(2500)
  const tailText1 = await slowCard.locator('[data-testid="live-tail"]').innerText().catch(() => '')
  ok('running session streams live transcript tail', tailText0 !== tailText1 && tailText1.length > 0, `${tailText0.slice(0, 18)} -> ${tailText1.slice(0, 18)}`)

  // Roving tabs across Transcript -> Diff -> Receipt -> Home
  await p.getByRole('button', { name: /Open Write the changelog entry/ }).click(); await p.waitForTimeout(350)
  const trTab = p.locator('main').getByRole('tab', { name: 'Transcript' })
  await trTab.focus()
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150)
  const onDiff = await p.locator('main').getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected') === 'true'
  const hasAddedLine = await p.locator('main .bg-diff-add-bg').count() >= 1
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150)
  const onReceipt = await p.locator('main').getByRole('tab', { name: 'Receipt' }).getAttribute('aria-selected') === 'true'
  await p.keyboard.press('Home'); await p.waitForTimeout(150)
  const onHome = await p.locator('main').getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected') === 'true'
  ok('arrow/Home roving tabs & syntax-tinted diff lines work', onDiff && hasAddedLine && onReceipt && onHome)

  // Expandable check output (zero <details>)
  await p.keyboard.press('r'); await p.waitForTimeout(200)
  await p.locator('main').getByRole('button', { name: 'Details of the check output' }).click(); await p.waitForTimeout(200)
  ok('Expandable check receipt output opens with zero <details>',
    (await p.locator('main').innerText()).includes('Hide details') && await p.locator('details').count() === 0)

  // Search filter with / shortcut
  await p.keyboard.press('/')
  await p.keyboard.type('billing'); await p.waitForTimeout(200)
  ok('/ focuses search and narrows inbox list', await cards(p).count() === 1)
  await p.getByRole('searchbox', { name: 'Search sessions' }).fill('zzz-nothing'); await p.waitForTimeout(200)
  ok('search miss shows empty status message', await p.locator('text=No session matches').count() === 1)
  await p.getByRole('searchbox', { name: 'Search sessions' }).fill(''); await p.waitForTimeout(200)

  // Needs-you Dismiss
  const needsCard = p.locator('article[aria-label^="Fix the sign-in"]')
  await needsCard.getByRole('button', { name: 'Dismiss' }).click()
  await p.waitForSelector('text=Dismissed. Its log stays on disk.', { timeout: 5000 }).then(() => ok('dismiss toast fires', true), () => ok('dismiss toast fires', false))
  await p.waitForTimeout(1000)
  ok('dismissed card leaves the inbox', await p.locator('article[aria-label^="Fix the sign-in"]').count() === 0)

  // Inbox popover + New session Dialog + Repo discovery (never defaults project to fixture)
  await p.getByRole('button', { name: /^Needs you/ }).first().click(); await p.waitForTimeout(250)
  ok('Needs you inbox popover opens', await p.locator('text=Go to Needs you').isVisible())
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)

  await p.getByRole('button', { name: /New session/ }).first().click(); await p.waitForTimeout(300)
  ok('New session dialog opens', await p.locator('[role=dialog]').count() >= 1)
  const repoPickerVisible = await p.locator('[aria-label="Discovered repositories"]').isVisible().catch(() => false)
  const initialProjectVal = await p.locator('#project').inputValue()
  ok('New session discovers git repos and never defaults project to fixture', repoPickerVisible && initialProjectVal !== 'fixture')
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  // Goal-to-DAG launchpad
  await p.locator('[data-testid="open-launchpad"]').click(); await p.waitForTimeout(250)
  await p.locator('#launchpad-goal').fill('Add input validation; write regression tests; then update docs')
  await p.locator('[data-testid="goal-launchpad"]').getByRole('button', { name: 'Plan DAG' }).click(); await p.waitForTimeout(400)
  const plannedVisible = await p.locator('[data-testid="planned-dag-preview"]').isVisible()
  ok('1-click Goal-to-DAG launchpad plans multi-step DAG preview', plannedVisible)

  // Owner ruling (#67): Light/Dark theme switch lives inside Settings ONLY, not on top bar
  const headerThemeBtns = await p.locator('header #themeBtn, header [aria-label="Light"], header [aria-label="Dark"]').count()
  ok('Light/Dark switch is absent from top bar (#67)', headerThemeBtns === 0)
  await p.getByRole('button', { name: 'Engines and settings' }).click(); await p.waitForTimeout(350)
  ok('Engines and settings drawer opens', await p.locator('#settings').isVisible())
  const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  const bgRgb = () => p.evaluate(() => {
    const cx = document.createElement('canvas').getContext('2d')
    cx.fillStyle = getComputedStyle(document.body).backgroundColor
    cx.fillRect(0, 0, 1, 1)
    return [...cx.getImageData(0, 0, 1, 1).data]
  })
  const lightBg = await bgRgb()
  await p.locator('#settings').getByRole('button', { name: 'Dark', exact: true }).click(); await p.waitForTimeout(250)
  const darkThemeAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  const darkBg = await bgRgb()
  await p.locator('#settings').getByRole('button', { name: 'Light', exact: true }).click(); await p.waitForTimeout(250)
  const lightThemeAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  ok('Light/Dark toggles cleanly inside Settings and darkens background',
    darkThemeAttr === 'dark' && lightThemeAttr === 'light' && lum(darkBg) < lum(lightBg),
    `dark=${darkThemeAttr}(${lum(darkBg).toFixed(0)}) light=${lightThemeAttr}(${lum(lightBg).toFixed(0)})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)
  await ctx.close()
}

// High-scale 55k transcript, Split diff, Multi-step Receipt, Auto-heal timeline, PR gate, DAG Graph, Settings Worktrees/Budget/Policy
{
  const { ctx, p } = await open(1440, 900, 'light', { acceptDownloads: true })
  let sseHits = 0
  await p.route('**/api/version', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'fleet', version: '0.12.0' }) }))
  await p.route('**/api/metrics', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      total: 5, first_pass_count: 1, auto_healed_count: 1, needs_you_count: 1,
      first_pass_rate_pct: 33.3, effective_pass_rate_pct: 66.7, median_check_ms: 820,
      active_slots: 2, max_parallel: 4, queued_count: 0, blocked_count: 0,
      per_repo_breakdown: [{ repo: '/tmp/fixture', project: 'fixture', total: 5, first_pass_count: 1, auto_healed_count: 1, needs_you_count: 1, median_check_ms: 820 }],
      budget: { max_session_mins: 30, daily_session_limit: 50, max_heal_attempts: 2, sessions_today: 5, remaining_today: 45, limit_reached: false, utilization_pct: 10.0 },
    }),
  }))
  await p.route('**/api/sessions/*/pr-preview', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      session_id: 's-done', title: 'Add verified export handler with unit tests',
      body: '## Summary\n\nVerified export handler.\n\n## Verification\n- [x] cargo clippy\n- [x] cargo test',
      base_branch: 'main', head_branch: 'fleet/s-done-export', commits_ahead: 1,
      diff_files: 2, diff_add: 42, diff_del: 4, gh_available: true, can_create: true, warnings: [],
    }),
  }))
  let prCreateConfirmed = false
  await p.route('**/api/sessions/*/pr', r => {
    const body = r.request().postDataJSON() || {}
    prCreateConfirmed = body.confirm === true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, dry_run: true, draft: Boolean(body.draft), url: 'https://github.com/example/fixture/pull/42', message: 'Created PR #42 cleanly.' }),
    })
  })
  let mockWorktrees = [
    { path: '/tmp/fixture', repo: '/tmp/fixture', branch: 'main', is_main: true, is_orphan: false, dirty: false, removable: false },
    { path: '/tmp/fixture/.worktrees/stale-orphan-99', repo: '/tmp/fixture', branch: 'fleet/stale-orphan-99', is_main: false, is_orphan: true, dirty: false, removable: true },
  ]
  await p.route('**/api/repos/worktrees*', r => {
    if (r.request().method() === 'DELETE') {
      const urlObj = new URL(r.request().url())
      const delPath = urlObj.searchParams.get('path') || (r.request().postDataJSON()?.path) || ''
      mockWorktrees = mockWorktrees.filter(w => w.path !== delPath)
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ removed: true, path: delPath, message: 'Removed orphan worktree.' }) })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ worktrees: mockWorktrees }) })
  })
  const mockTemplates = [
    {
      id: 'tpl-default-1', name: 'Feature + Unit Tests', description: 'Scoped feature with lint and unit tests',
      check_steps: [{ name: 'unit', cmd: 'cargo test', timeout_secs: 300 }], allowed_globs: ['src/**'], forbidden_globs: ['.env*'],
      auto_steer_budget: 2, tasks: [{ task: 'Implement scoped feature with tests', check: 'cargo test' }], builtin: true,
    },
  ]
  await p.route('**/api/templates', async r => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON()
      const created = { ...body, id: 'tpl-saved-1', builtin: false }
      mockTemplates.push(created)
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockTemplates) })
  })
  await p.route('**/api/templates/*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: true }) }))
  await p.route('**/api/events/stream', r => {
    sseHits++
    r.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-cache' }, body: 'event: queue_depth\ndata: {"type":"queue_depth","active":2}\n\n' })
  })
  await p.route('**/api/sessions/*/merge-check', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ clean: false, conflicting_files: ['src/reports.ts', 'tests/export.spec.ts'], commits_ahead: 2, commits_behind: 1 }),
  }))
  await p.route('**/api/sessions/*/patch', r => r.fulfill({
    status: 200, contentType: 'text/x-patch',
    body: 'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] verified worktree change\n---\ndiff --git a/output.txt b/output.txt\n--- /dev/null\n+++ b/output.txt\n@@ -0,0 +1 @@\n+verified\n',
  }))
  await p.route('**/api/policies/test', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      engine: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', check_cmd: 'cargo test',
      timeout_secs: 1800, max_parallel: 4, auto_retry_budget: 2, auto_steer_budget: 2,
      allowed_globs: ['src/**'], forbidden_globs: ['.env*'], matched_rule: 'policies.rn -> route_repo("fixture")', warnings: [],
    }),
  }))

  const bigLines = Array.from({ length: 55000 }, (_, i) => i === 42000 ? 'ERROR: panic at report_export.rs:88 assertion failed' : `[line ${i + 1}] compiling module shard_${i % 64}`)
  await p.route('**/api/sessions', async r => {
    if (r.request().method() !== 'GET') return r.continue()
    let res
    try { res = await r.fetch() } catch { return }
    const arr = await res.json()
    if (Array.isArray(arr) && arr.length > 0) {
      const doneIdx = arr.findIndex(x => x.bucket === 'done')
      if (doneIdx >= 0) {
        const upstreamId = arr.find((x, idx) => idx !== doneIdx)?.id || 's-base'
        arr[doneIdx] = {
          ...arr[doneIdx],
          transcript: bigLines, transcript_total: 55000, depends_on: [upstreamId],
          auto_healed: true, auto_steer_budget: 2,
          heal_attempts: [
            { attempt: 1, trigger_step: 'lint', exit_code: 1, stderr_tail: 'unused import in reports.rs', prompt_sent: 'Auto-heal attempt 1/2: remove unused import in reports.rs', started_ms: 1000, elapsed_ms: 340, healed: false },
            { attempt: 2, trigger_step: 'unit-tests', exit_code: 0, stderr_tail: 'assertion expected 6 got 5', prompt_sent: 'Auto-heal attempt 2/2: fix export counter off-by-one', started_ms: 1400, elapsed_ms: 480, healed: true },
          ],
          check_steps: [
            { name: 'lint', cmd: 'cargo clippy', status: 'passed', passed: true, exit_code: 0, elapsed_ms: 410, tail_line: '0 warnings', output: 'clippy clean' },
            { name: 'unit-tests', cmd: arr[doneIdx].check_cmd || 'cargo test', status: 'passed', passed: true, exit_code: 0, elapsed_ms: 820, tail_line: '6 passed in 0.82s', output: arr[doneIdx].check_output || 'ok' },
          ],
        }
      }
    }
    await r.fulfill({ response: res, body: JSON.stringify(arr) })
  })

  await p.goto(BASE); await ready(p); await p.waitForTimeout(700)
  ok('concurrency indicator renders active / max_parallel slots', await p.locator('[data-testid="concurrency-indicator"]').isVisible())
  ok('SSE stream connects on boot', sseHits >= 1, `sseHits=${sseHits}`)

  await p.getByRole('button', { name: /Open Add the export button|Open Write the changelog entry/ }).first().click()
  await p.waitForTimeout(400)
  const vt = p.locator('main [data-testid="virtualized-transcript"]')
  const mountedRows = await vt.locator('[data-line]').count()
  ok('55,000-line transcript stays virtualized (<150 DOM nodes)', mountedRows > 0 && mountedRows < 150, `mounted=${mountedRows}`)
  await vt.getByRole('button', { name: /Jump to first error/ }).click()
  await p.waitForTimeout(250)
  ok('Jump to first error scrolls 55k virtualized log directly to line 42001', await vt.locator('[data-line="42001"]').isVisible())

  await p.keyboard.press('d'); await p.waitForTimeout(350)
  const dv = p.locator('main [data-testid="rich-diff-viewer"]')
  const conflictBadgeText = await dv.locator('[data-testid="merge-check-badge"]').innerText()
  await dv.getByRole('button', { name: 'Split' }).click(); await p.waitForTimeout(200)
  const splitRendered = (await dv.locator('[data-testid="diff-split-grid"]').count()) >= 1
  const [dl] = await Promise.all([p.waitForEvent('download'), dv.getByRole('button', { name: '.patch' }).click()])
  ok('Diff view shows Pre-Merge Conflict badge, Side-by-Side split, and .patch download',
    conflictBadgeText.includes('2 conflicts') && splitRendered && dl.suggestedFilename().endsWith('.patch'))

  await p.keyboard.press('r'); await p.waitForTimeout(250)
  const stepRows = await p.locator('main ol[aria-label="Check pipeline steps"] > li').count()
  ok('Receipt view renders per-step timed timeline with durations', stepRows === 2 && (await p.locator('main [data-testid="receipt-timeline"]').innerText()).includes('410ms'))
  const healTimelineText = await p.locator('main [data-testid="auto-heal-timeline"]').innerText()
  ok('Auto-Heal badge & timeline show Healed on attempt 2/2 with attempts',
    healTimelineText.includes('Healed on attempt 2/2') && (await p.locator('main ol[aria-label="Auto-heal attempts"] > li').count()) === 2)

  const metricsText = await p.locator('[data-testid="board-metrics-strip"]').innerText()
  ok('Metrics strip renders First-pass %, Auto-healed, Median check, Active/Max slots, and Daily budget',
    metricsText.includes('33%') && metricsText.includes('Auto-healed') && metricsText.includes('820ms') && metricsText.includes('2 / 4') && metricsText.includes('5 / 50'))

  await p.locator('[data-testid="open-pr-preview"]').click(); await p.waitForTimeout(300)
  const prModal = p.locator('[data-testid="pr-preview-modal"]')
  const prTitleVal = await prModal.locator('#pr-preview-title').inputValue()
  const prDisabledBefore = await prModal.locator('[data-testid="pr-submit-btn"]').isDisabled()
  await prModal.locator('#pr-confirm-checkbox').check(); await p.waitForTimeout(100)
  const prEnabledAfter = await prModal.locator('[data-testid="pr-submit-btn"]').isEnabled()
  await prModal.locator('[data-testid="pr-submit-btn"]').click(); await p.waitForTimeout(250)
  const prStatusText = await prModal.locator('[data-testid="pr-create-status"]').innerText()
  ok('PR Preview modal loads Markdown, enforces confirmation gate, and submits confirm=true',
    prTitleVal.includes('export handler') && prDisabledBefore && prEnabledAfter && prCreateConfirmed && prStatusText.includes('PR #42'))
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  await p.locator('[data-testid="view-toggle-dag"]').click(); await p.waitForTimeout(250)
  const dagNodes = await p.locator('[data-testid="dag-node"]').count()
  const dagEdges = await p.locator('[data-testid="dag-edge"]').count()
  await p.locator('[data-testid="dag-node"]').first().click(); await p.waitForTimeout(250)
  const dagOpensInspector = await p.locator('aside[aria-label="Session inspector"]').isVisible()
  ok('DAG Graph view renders multi-wave nodes, directed SVG edges, and opens session on click',
    dagNodes >= 2 && dagEdges >= 1 && dagOpensInspector)
  await p.locator('[data-testid="view-toggle-board"]').click(); await p.waitForTimeout(200)

  const visibleBodyText = (await p.locator('body').innerText()).replace(/\/[^\s]*dsh-fleet[^\s]*/g, '/repo')
  const pageTitle = await p.title()
  const versionHref = (await p.locator('header a[href*="/releases/tag/"]').first().getAttribute('href')) || ''
  ok('Zero user-facing Rune jargon rendered (#155)', !/\brune\b/i.test(visibleBodyText))
  ok('Fleet v0.12.0 rebrand clean across title, board, and release URL',
    !/\bdsh[-_ ]?fleet\b|deepseek\s+harness|\bfleet-rs\b/i.test(`${pageTitle}\n${visibleBodyText}\n${versionHref}`) &&
      versionHref.includes('cayleb-james2008/fleet/releases/tag/v0.12.0'),
    `href=${versionHref}`)

  // Multi-select bulk controls
  await p.getByRole('button', { name: 'Select multiple sessions' }).click(); await p.waitForTimeout(200)
  await p.locator('[data-testid="bulk-action-bar"]').getByRole('button', { name: 'All' }).click(); await p.waitForTimeout(200)
  const bulkRegionText = await p.locator('[data-testid="bulk-action-bar"]').innerText()
  ok('Multi-select bulk controls select visible sessions and expose bulk actions',
    bulkRegionText.includes('selected') && bulkRegionText.includes('Merge'),
    bulkRegionText.replace(/\n+/g, ' '))
  await p.getByRole('button', { name: 'Select multiple sessions' }).click(); await p.waitForTimeout(150)

  // Ctrl+K palette -> Playbooks -> Batch Fan-Out -> Save playbook
  await p.keyboard.press('Control+k'); await p.waitForTimeout(250)
  const cmdkOpen = await p.locator('[cmdk-root]').isVisible()
  const cmdkHasPlaybook = (await p.locator('[cmdk-root]').innerText()).includes('Feature + Unit Tests')
  await p.locator('[cmdk-input]').fill('Dispatch Batch DAG'); await p.waitForTimeout(150)
  await p.keyboard.press('Enter'); await p.waitForTimeout(450)
  const batchOpen = await p.locator('#batch-task-0').isVisible()
  ok('Ctrl+K Command Palette lists Playbooks and opens Batch Fan-Out & depends_on composer',
    cmdkOpen && cmdkHasPlaybook && batchOpen,
    `cmdk=${cmdkOpen} tpl=${cmdkHasPlaybook} batch=${batchOpen}`)
  await p.getByRole('button', { name: 'Save as playbook' }).click(); await p.waitForTimeout(200)
  await p.locator('#playbook-name').fill('Custom Nightly Wave')
  await p.getByRole('button', { name: 'Save playbook', exact: true }).click(); await p.waitForTimeout(300)
  ok('Composer saves custom playbook via POST /api/templates', (await p.locator('section[aria-label="Playbooks"]').innerText()).includes('Custom Nightly Wave'))
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  // Settings Budget Guardrails, Worktrees Inspector, Policy Tester
  await p.getByRole('button', { name: 'Engines and settings' }).click(); await p.waitForTimeout(350)
  const budgetText = await p.locator('[data-testid="budget-guardrails"]').innerText()
  ok('Budget Guardrails renders daily cap utilization inside Settings',
    budgetText.includes('5 / 50') && budgetText.includes('30 min') && budgetText.includes('2 / run'))
  const wtBefore = await p.locator('[data-testid="worktree-row"]').count()
  await p.locator('[data-testid="worktree-prune-btn"]').first().click(); await p.waitForTimeout(150)
  await p.locator('[data-testid="worktree-confirm-prune"]').click(); await p.waitForTimeout(300)
  const wtAfter = await p.locator('[data-testid="worktree-row"]').count()
  ok('Worktrees Inspector lists repo checkouts and prunes orphan via DELETE', wtBefore === 2 && wtAfter === 1)
  await p.locator('#settings').getByRole('button', { name: 'Test policy' }).click(); await p.waitForTimeout(250)
  const ptText = await p.locator('[data-testid="policy-test-result"]').innerText()
  ok('Live Policy Tester evaluates POST /api/policies/test inside Settings',
    ptText.includes('opencode/deepseek-v4.1-flash-free') && ptText.includes('policies.rn'))
  await ctx.close()
}

// Update strip BANNER-FIX-BRIEF states
{
  const { ctx, p } = await open(1440, 900)
  await p.route('**/api/update', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ current: '0.8.0', latest: '0.9.1', available: true, can_apply: true, mode: 'notify', notes: 'Faster worktree diffs\nExtra detail line' }),
  }))
  await p.route('**/api/update/check', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ current: '0.8.0', latest: '0.9.1', available: true, can_apply: true, mode: 'notify', checked_at: Math.floor(Date.now() / 1000) }),
  }))
  await p.goto(BASE); await ready(p); await p.waitForTimeout(500)
  const strip = p.locator('section[aria-label="Fleet update"]')
  ok('update strip explains Update now behavior', (await strip.innerText()).includes('Update now downloads it, checks it, and replaces this app. Restart to start using it.'))
  await strip.getByRole('button', { name: 'Dismiss' }).click(); await p.waitForTimeout(250)
  ok('Dismiss focuses Show update button', await p.evaluate(() => document.activeElement?.id === 'show-update'))
  await p.getByRole('button', { name: 'Engines and settings' }).click(); await p.waitForTimeout(350)
  await p.locator('#settings').getByRole('button', { name: 'Check for updates' }).click()
  await p.locator('#settings').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
  await p.waitForTimeout(200)
  ok('manual Check for updates clears dismissal and closes settings sheet', await strip.isVisible() && !(await p.locator('#settings').isVisible()))
  await ctx.close()
}

// Mobile 390x844 Settings real tap + mobile panes
{
  const { ctx, p } = await open(390, 844)
  await p.goto(BASE); await ready(p)
  await p.getByRole('button', { name: /Open slow: Profile the search endpoint/ }).click(); await p.waitForTimeout(350)
  ok('phone: switches to Workspace pane for selected session', await p.locator('main h2').isVisible())
  ok('phone: bottom workbench nav visible', await p.locator('nav[aria-label="Workbench panes"]').isVisible())
  const bgLum = () => p.evaluate(() => {
    const cx = document.createElement('canvas').getContext('2d')
    cx.fillStyle = getComputedStyle(document.body).backgroundColor
    cx.fillRect(0, 0, 1, 1)
    const [r, g, bb] = cx.getImageData(0, 0, 1, 1).data
    return 0.2126 * r + 0.7152 * g + 0.0722 * bb
  })
  const l0 = await bgLum()
  await p.locator('#settings-open').tap(); await p.waitForTimeout(350)
  await p.locator('#settings').getByRole('button', { name: 'Dark', exact: true }).tap(); await p.waitForTimeout(300)
  const dAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  const l1 = await bgLum()
  await p.locator('#settings').getByRole('button', { name: 'Light', exact: true }).tap(); await p.waitForTimeout(300)
  const lAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  ok('phone 390x844: real tap on Settings toggles Dark/Light cleanly', dAttr === 'dark' && lAttr === 'light' && l1 < l0, `lum ${l0.toFixed(0)}->${l1.toFixed(0)}`)
  await ctx.close()
}

// Reduced motion
{
  const { ctx, p } = await open(1440, 900, 'light', { reducedMotion: 'reduce' })
  await p.goto(BASE); await ready(p); await p.waitForTimeout(1000)
  const moving = await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length)
  ok('reduced motion: no endless motion', moving === 0, String(moving))
  await ctx.close()
}

ok('no console errors', errs.length === 0, errs.slice(0, 5).join(' || '))
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ checks, errs }, null, 1))
report('gate', checks)
await b.close()
