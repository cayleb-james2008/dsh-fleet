// gate.mjs: Fleet v0.3.0 Mission Control Board E2E gate.
// Verifies 1440/768/390/320 in light & dark, Scan Strip, Hero Verified Receipt, Three-Lane Board,
// Split-Pane Session Inspector, roving tabs, syntax-tinted diff, Cult UI Expandable (zero <details>),
// Update strip focus & non-loopback rules, and prefers-reduced-motion.
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
  const detailsCount = document.querySelectorAll('details').length
  return {
    clipped,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    interactive: inter.length,
    smallTargets: small.length,
    smallSample: small.slice(0, 20),
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

for (const theme of ['light', 'dark']) for (const [vn, w, h] of [['1440', 1440, 900], ['768', 768, 1024], ['390', 390, 844], ['320', 320, 640]]) {
  const { ctx, p } = await open(w, h, theme)
  await p.goto(BASE); await ready(p); await p.waitForTimeout(800)
  const m = await p.evaluate(MEASURE)
  ok(`measure ${vn} ${theme}`, m.docOverflow <= 0 && m.clipped.length === 0 && m.smallTargets === 0 && m.lowContrast === 0 && m.unnamed.length === 0 && m.minFont >= 12 && m.detailsCount === 0,
    `overflow ${m.docOverflow} clipped ${m.clipped.join(' | ')} small ${m.smallTargets} ${m.smallSample.join(' | ')} low ${m.lowContrast} ${m.lowSample.join(' | ')} unnamed ${m.unnamed.join(' | ')} minFont ${m.minFont} details ${m.detailsCount}`)
  if (vn === '1440' || vn === '390') await p.screenshot({ path: `${OUT}/board-${vn}-${theme}.png` })
  await ctx.close()
}

{
  const { ctx, p } = await open(1440, 900)
  await p.goto(BASE); await ready(p)

  // Hero Verified Receipt & Three-Lane Board
  const heroText = await p.locator('section[aria-label="Latest verified receipt"]').innerText()
  ok('hero verified receipt shows check command and diff stats', heroText.includes('verified by:') && /\+\d+/.test(heroText))
  ok('three lanes rendered with Needs you · Working · Done',
    await p.locator('#lane-needs-h').isVisible() && await p.locator('#lane-working-h').isVisible() && await p.locator('#lane-done-h').isVisible())
  ok('five seeded session cards across lanes', await cards(p).count() === 5)

  // Live streaming tail on running session
  const last = () => p.locator('article[aria-label^="slow: Migrate"] ol li').last().innerText()
  const l0 = await last(); await p.waitForTimeout(2500); const l1 = await last()
  ok('running session card streams its transcript tail', l0 !== l1, `${l0.slice(0, 18)} -> ${l1.slice(0, 18)}`)

  // Split-Pane Session Inspector + focus management + roving tabs + syntax-tinted diff
  await p.getByRole('button', { name: /Open Write the changelog entry/ }).click(); await p.waitForTimeout(500)
  const inspector = p.locator('aside[aria-label="Session inspector"]')
  ok('opening session shows split-pane inspector and focuses heading',
    await inspector.isVisible() && await p.evaluate(() => document.activeElement?.tagName === 'H2'))

  // Roving arrow keys across Transcript -> Diff -> Receipt -> Home -> End
  const trTab = inspector.getByRole('tab', { name: 'Transcript' })
  await trTab.focus()
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150)
  const onDiff = await inspector.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected') === 'true'
  const hasAddedLine = await inspector.locator('.bg-diff-add-bg').count() >= 1
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150)
  const onReceipt = await inspector.getByRole('tab', { name: 'Receipt' }).getAttribute('aria-selected') === 'true'
  await p.keyboard.press('Home'); await p.waitForTimeout(150)
  const onHome = await inspector.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected') === 'true'
  ok('arrow/Home roving tabs & syntax-tinted diff lines work', onDiff && hasAddedLine && onReceipt && onHome, `diff=${onDiff} addLine=${hasAddedLine} rc=${onReceipt} home=${onHome}`)

  // Cult UI Expandable check output (zero native <details>)
  await inspector.getByRole('button', { name: 'Details of the check output' }).click(); await p.waitForTimeout(250)
  ok('Cult UI Expandable reveals check output with zero <details>',
    (await inspector.innerText()).includes('Hide details') && await p.locator('details').count() === 0)
  await p.screenshot({ path: `${OUT}/inspector-1440.png` })

  // Close returns focus to card opener
  await inspector.getByRole('button', { name: 'Close this session' }).click(); await p.waitForTimeout(300)
  ok('closing inspector returns focus to card opener',
    await inspector.count() === 0 && (await p.evaluate(() => document.activeElement?.getAttribute('aria-label') || '')).includes('Open Write the changelog entry'))

  // Search filter with / shortcut
  await p.keyboard.press('/')
  await p.keyboard.type('billing'); await p.waitForTimeout(250)
  ok('/ focuses search and narrows board', await cards(p).count() === 1)
  await p.getByRole('searchbox').first().fill('zzz-nothing'); await p.waitForTimeout(250)
  ok('search miss shows empty status message', await p.locator('text=No session matches').count() === 1)
  await p.getByRole('searchbox').first().fill(''); await p.waitForTimeout(250)

  // Needs-you Retry & Dismiss
  const needsCard = p.locator('article[aria-label^="Fix the sign-in"]')
  await needsCard.getByRole('button', { name: 'Dismiss' }).click()
  await p.waitForSelector('text=Dismissed. Its log stays on disk.', { timeout: 5000 }).then(() => ok('dismiss toast fires', true), () => ok('dismiss toast fires', false))
  await p.waitForTimeout(1200)
  ok('dismissed card leaves the Needs you lane', await p.locator('article[aria-label^="Fix the sign-in"]').count() === 0)

  // Inbox popover, New session MorphingDialog, Engines & settings Vaul sheet
  await p.getByRole('button', { name: /^Needs you/ }).first().click(); await p.waitForTimeout(300)
  ok('Needs you inbox popover opens', await p.locator('text=Go to Needs you').isVisible())
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  const newTrigger = p.getByRole('button', { name: /New session/ }).first()
  await newTrigger.click(); await p.waitForTimeout(400)
  ok('New session MorphingDialog opens', await p.locator('[role=dialog]').count() >= 1)
  const repoPickerVisible = await p.locator('[aria-label="Discovered repositories"]').isVisible().catch(() => false)
  const initialProjectVal = await p.locator('#project').inputValue()
  ok('New session discovers git repos and never defaults project to fixture', repoPickerVisible && initialProjectVal !== 'fixture', `picker=${repoPickerVisible} project=${initialProjectVal}`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(350)
  ok('New session dialog returns focus on Escape', (await p.evaluate(() => document.activeElement?.textContent || '')).includes('New session'))

  // Owner ruling (#67): Light/Dark theme switch lives inside Settings ONLY, not on top bar
  const headerThemeBtns = await p.locator('header #themeBtn, header [aria-label="Light"], header [aria-label="Dark"]').count()
  ok('Light/Dark switch is absent from top bar', headerThemeBtns === 0, `headerThemeBtns=${headerThemeBtns}`)
  await p.getByRole('button', { name: 'Engines and settings' }).click(); await p.waitForTimeout(400)
  ok('Engines and settings sheet opens', await p.locator('#settings').isVisible())
  const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  const bgRgb = () => p.evaluate(() => {
    const cx = document.createElement('canvas').getContext('2d')
    cx.fillStyle = getComputedStyle(document.body).backgroundColor
    cx.fillRect(0, 0, 1, 1)
    return [...cx.getImageData(0, 0, 1, 1).data]
  })
  const lightBg = await bgRgb()
  await p.locator('#settings').getByRole('button', { name: 'Dark', exact: true }).click(); await p.waitForTimeout(300)
  const darkThemeAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  const darkBg = await bgRgb()
  await p.locator('#settings').getByRole('button', { name: 'Light', exact: true }).click(); await p.waitForTimeout(300)
  const lightThemeAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  ok('Light/Dark toggles cleanly inside Settings and darkens background',
    darkThemeAttr === 'dark' && lightThemeAttr === 'light' && lum(darkBg) < lum(lightBg),
    `dark=${darkThemeAttr}(${lum(darkBg).toFixed(0)}) light=${lightThemeAttr}(${lum(lightBg).toFixed(0)})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(350)
  await ctx.close()
}

// v0.5.0 War Room E2E: Cmd+K palette, keyboard nav (j/k/t/d/r/n), filter & multi-select bulk bar,
// 55,000-line virtualized transcript + Jump to first error, Unified/Split diff + Pre-Merge Conflict badge
// + Merge Strategy + .patch download, Per-Step Timed Receipt Timeline, Live Policy Tester, and SSE live stream.
{
  const { ctx, p } = await open(1440, 900, 'light', { acceptDownloads: true })
  let sseHits = 0
  // v0.8.0 Fleet Rebrand + DAG Graph, PR Preview & Create PR, Worktrees Inspector, Budget Guardrails, Auto-Heal, Playbooks
  await p.route('**/api/version', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'fleet', version: '0.8.0' }) }))
  await p.route('**/api/metrics', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      total: 5,
      first_pass_count: 1,
      auto_healed_count: 1,
      needs_you_count: 1,
      first_pass_rate_pct: 33.3,
      effective_pass_rate_pct: 66.7,
      median_check_ms: 820,
      active_slots: 2,
      max_slots: 4,
      queued_count: 0,
      blocked_count: 0,
      per_repo_breakdown: [{ repo: '/tmp/fixture', project: 'fixture', total: 5, first_pass_count: 1, auto_healed_count: 1, needs_you_count: 1, median_check_ms: 820 }],
      budget: {
        max_session_mins: 30,
        daily_session_limit: 50,
        max_heal_attempts: 2,
        sessions_today: 5,
        remaining_today: 45,
        daily_limit_reached: false,
        usage_pct: 10.0,
      },
    }),
  }))
  await p.route('**/api/sessions/*/pr-preview', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      session_id: 's-done',
      title: 'Add verified export handler with unit tests',
      body: '## Summary\n\nVerified export handler.\n\n## Verification\n- [x] cargo clippy\n- [x] cargo test',
      base_branch: 'main',
      head_branch: 'fleet/s-done-export',
      commits_ahead: 1,
      diff_stat: { files_changed: 2, insertions: 42, deletions: 4, files: [] },
      gh_available: true,
      ready_to_create: true,
      warnings: [],
    }),
  }))
  let prCreateConfirmed = false
  await p.route('**/api/sessions/*/pr', r => {
    const b = r.request().postDataJSON() || {}
    prCreateConfirmed = b.confirm === true
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        created: true,
        dry_run: true,
        draft: Boolean(b.draft),
        url: 'https://github.com/example/fixture/pull/42',
        message: 'Created PR #42 cleanly.',
      }),
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
      id: 'tpl-default-1',
      name: 'Feature + Unit Tests',
      description: 'Scoped feature with lint and unit tests',
      check_steps: [{ name: 'unit', cmd: 'cargo test', timeout_secs: 300 }],
      allowed_globs: ['src/**'],
      forbidden_globs: ['.env*'],
      auto_steer_budget: 2,
      tasks: [{ task: 'Implement scoped feature with tests', check: 'cargo test' }],
      builtin: true,
    },
  ]
  await p.route('**/api/templates', async r => {
    if (r.request().method() === 'POST') {
      const b = r.request().postDataJSON()
      const created = { ...b, id: 'tpl-saved-1', builtin: false }
      mockTemplates.push(created)
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockTemplates) })
  })
  await p.route('**/api/templates/*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: true }) }))
  await p.route('**/api/events/stream', r => {
    sseHits++
    r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: 'event: queue_depth\ndata: {"type":"queue_depth","active":2}\n\n',
    })
  })
  await p.route('**/api/sessions/*/merge-check', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ clean: false, conflicting_files: ['src/reports.ts', 'tests/export.spec.ts'], commits_ahead: 2, commits_behind: 1 }),
  }))
  await p.route('**/api/sessions/*/patch', r => r.fulfill({
    status: 200,
    contentType: 'text/x-patch',
    body: 'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] verified worktree change\n---\ndiff --git a/output.txt b/output.txt\n--- /dev/null\n+++ b/output.txt\n@@ -0,0 +1 @@\n+verified\n',
  }))
  await p.route('**/api/policies/test', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      engine: 'opencode',
      model: 'opencode/deepseek-v4.1-flash-free',
      check_cmd: 'cargo test',
      timeout_secs: 1800,
      max_parallel: 4,
      auto_retry_budget: 2,
      auto_steer_budget: 2,
      allowed_globs: ['src/**'],
      forbidden_globs: ['.env*'],
      matched_rule: 'policies.rn -> route_repo("fixture")',
      warnings: [],
    }),
  }))

  // Inject a 55,000-line transcript + multi-step receipt on the first verified session to test virtualization
  const bigLines = Array.from({ length: 55000 }, (_, i) => i === 42000 ? 'ERROR: panic at report_export.rs:88 assertion failed' : `[line ${i + 1}] compiling module shard_${i % 64}`)
  await p.route('**/api/sessions', async r => {
    if (r.request().method() !== 'GET') return r.continue()
    const res = await r.fetch()
    const arr = await res.json()
    if (Array.isArray(arr) && arr.length > 0) {
      const doneIdx = arr.findIndex(x => x.bucket === 'done')
      if (doneIdx >= 0) {
        const upstreamId = arr.find((x, idx) => idx !== doneIdx)?.id || 's-base'
        arr[doneIdx] = {
          ...arr[doneIdx],
          transcript: bigLines,
          transcript_total: 55000,
          depends_on: [upstreamId],
          auto_healed: true,
          auto_steer_budget: 2,
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
  ok('v0.5.0 concurrency indicator renders active / max_parallel slots', await p.locator('[data-testid="concurrency-indicator"]').isVisible())
  ok('v0.5.0 SSE stream connects when server advertises 0.5.0', sseHits >= 1, `sseHits=${sseHits}`)

  // Keyboard power navigation: j opens session, d switches Diff, r switches Receipt, t switches Transcript
  await p.keyboard.press('j'); await p.waitForTimeout(300)
  const inspector = p.locator('aside[aria-label="Session inspector"]')
  ok('keyboard j navigates into session inspector', await inspector.isVisible())

  // Open the 55,000-line session directly and prove virtualization + Jump to first error
  await p.getByRole('button', { name: /Open Add the export button|Open Write the changelog entry/ }).first().click()
  await p.waitForTimeout(400)
  const vt = inspector.locator('[data-testid="virtualized-transcript"]')
  const mountedRows = await vt.locator('[data-line]').count()
  ok('55,000-line transcript stays virtualized (<150 DOM nodes)', mountedRows > 0 && mountedRows < 150, `mounted=${mountedRows}`)
  await vt.getByRole('button', { name: /Jump to first error/ }).click()
  await p.waitForTimeout(250)
  const jumpedErrVisible = await vt.locator('[data-line="42001"]').isVisible()
  ok('Jump to first error scrolls 55k virtualized log directly to line 42001', jumpedErrVisible)

  // Diff tab: Unified + Side-by-Side Split + Pre-Merge Conflict badge + Merge Strategy + Download .patch
  await p.keyboard.press('d'); await p.waitForTimeout(350)
  const dv = inspector.locator('[data-testid="rich-diff-viewer"]')
  const conflictBadgeText = await dv.locator('[data-testid="merge-check-badge"]').innerText()
  await dv.getByRole('button', { name: 'Split' }).click(); await p.waitForTimeout(200)
  const splitRendered = (await dv.locator('[data-testid="diff-split-grid"]').count()) >= 1
  const [dl] = await Promise.all([p.waitForEvent('download'), dv.getByRole('button', { name: '.patch' }).click()])
  ok('Diff tab shows Pre-Merge Conflict badge, Side-by-Side split, and .patch download',
    conflictBadgeText.includes('2 conflicts') && splitRendered && dl.suggestedFilename().endsWith('.patch'),
    `badge=${conflictBadgeText} split=${splitRendered} file=${dl.suggestedFilename()}`)

  // Receipt tab: Per-Step Timed Receipt Timeline + Auto-Heal Attempt Timeline
  await p.keyboard.press('r'); await p.waitForTimeout(250)
  const stepRows = await inspector.locator('ol[aria-label="Check pipeline steps"] > li').count()
  ok('Receipt tab renders per-step timed timeline with durations', stepRows === 2 && (await inspector.locator('[data-testid="receipt-timeline"]').innerText()).includes('410ms'), `steps=${stepRows}`)
  const healTimelineText = await inspector.locator('[data-testid="auto-heal-timeline"]').innerText()
  ok('Auto-Heal badge & timeline show Healed on attempt 2/2 with attempts',
    healTimelineText.includes('Healed on attempt 2/2') && (await inspector.locator('ol[aria-label="Auto-heal attempts"] > li').count()) === 2)

  // Board Metrics Strip telemetry + Daily budget chip
  const metricsText = await p.locator('[data-testid="board-metrics-strip"]').innerText()
  ok('Board Metrics Strip renders First-pass %, Auto-healed, Median check, Active/Max slots, and Daily budget',
    metricsText.includes('33%') && metricsText.includes('Auto-healed') && metricsText.includes('820ms') && metricsText.includes('2 / 4') && metricsText.includes('5 / 50'))

  // PR Preview & Confirmation-Gated Create PR modal from Inspector
  await inspector.locator('[data-testid="open-pr-preview"]').click(); await p.waitForTimeout(300)
  const prModal = p.locator('[data-testid="pr-preview-modal"]')
  const prTitleVal = await prModal.locator('#pr-preview-title').inputValue()
  const prDisabledBeforeConfirm = await prModal.locator('[data-testid="pr-submit-btn"]').isDisabled()
  await prModal.locator('#pr-confirm-checkbox').check(); await p.waitForTimeout(100)
  const prEnabledAfterConfirm = await prModal.locator('[data-testid="pr-submit-btn"]').isEnabled()
  await prModal.locator('[data-testid="pr-submit-btn"]').click(); await p.waitForTimeout(250)
  const prStatusText = await prModal.locator('[data-testid="pr-create-status"]').innerText()
  ok('PR Preview modal loads Markdown, enforces confirmation gate, and submits confirm=true',
    prTitleVal.includes('export handler') && prDisabledBeforeConfirm && prEnabledAfterConfirm && prCreateConfirmed && prStatusText.includes('PR #42'),
    `disabledBefore=${prDisabledBeforeConfirm} confirmed=${prCreateConfirmed}`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  // Board / DAG Graph toggle renders multi-wave dependency graph + SVG edges + click node -> Inspector
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  await p.locator('[data-testid="view-toggle-dag"]').click(); await p.waitForTimeout(250)
  const dagNodes = await p.locator('[data-testid="dag-node"]').count()
  const dagEdges = await p.locator('[data-testid="dag-edge"]').count()
  await p.locator('[data-testid="dag-node"]').first().click(); await p.waitForTimeout(250)
  const dagOpensInspector = await p.locator('aside[aria-label="Session inspector"]').isVisible()
  ok('DAG Graph view renders multi-wave nodes, directed SVG edges, and opens Inspector on click',
    dagNodes >= 2 && dagEdges >= 1 && dagOpensInspector,
    `nodes=${dagNodes} edges=${dagEdges}`)
  await p.locator('[data-testid="view-toggle-board"]').click(); await p.waitForTimeout(200)

  // Zero user-facing "Rune" jargon and zero legacy DSH-Fleet / DeepSeek Harness branding check
  const visibleBodyText = await p.locator('body').innerText()
  const pageTitle = await p.title()
  const versionHref = (await p.locator('header a[href*="/releases/tag/"]').first().getAttribute('href')) || ''
  ok('Zero user-facing Rune jargon rendered on board or inspector', !/\brune\b/i.test(visibleBodyText))
  ok('Fleet rebrand clean: zero DSH-Fleet, DeepSeek Harness, or fleet-rs strings on board/title/release URL',
    !/\bdsh[-_ ]?fleet\b|deepseek\s+harness|\bfleet-rs\b/i.test(`${pageTitle}\n${visibleBodyText}\n${versionHref}`) &&
      versionHref.includes('cayleb-james2008/fleet/releases/tag/v0.8.0'),
    `href=${versionHref}`)

  // Multi-select bulk bar + status filter
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)
  await p.getByRole('button', { name: 'Multi-select' }).click(); await p.waitForTimeout(200)
  await p.getByRole('button', { name: /Select visible/ }).click(); await p.waitForTimeout(200)
  const bulkRegionText = await p.locator('[aria-label="Bulk selection controls"]').innerText()
  ok('Multi-select bulk controls select visible sessions and expose Retry/Dismiss/Merge',
    bulkRegionText.includes('Bulk Retry') && bulkRegionText.includes('Bulk Dismiss') && bulkRegionText.includes('Bulk Merge'))
  await p.getByRole('button', { name: /Selecting/ }).click(); await p.waitForTimeout(150)

  // Cmd+K Global Command Palette -> Playbooks + Batch Fan-Out Composer + Save as playbook
  await p.keyboard.press('Control+k'); await p.waitForTimeout(250)
  const cmdkOpen = await p.locator('[cmdk-root]').isVisible()
  const cmdkHasPlaybook = (await p.locator('[cmdk-root]').innerText()).includes('Feature + Unit Tests')
  await p.locator('[cmdk-input]').fill('Batch fan-out'); await p.waitForTimeout(150)
  await p.keyboard.press('Enter'); await p.waitForTimeout(450)
  const batchOpen = await p.locator('#batch-task-0').isVisible()
  ok('Ctrl+K Command Palette lists Playbooks and opens Batch Fan-Out & depends_on composer', cmdkOpen && cmdkHasPlaybook && batchOpen, `cmdk=${cmdkOpen} tpl=${cmdkHasPlaybook} batch=${batchOpen}`)
  await p.getByRole('button', { name: 'Save as playbook' }).click(); await p.waitForTimeout(200)
  await p.locator('#playbook-name').fill('Custom Nightly Wave')
  await p.getByRole('button', { name: 'Save playbook', exact: true }).click(); await p.waitForTimeout(300)
  ok('Composer saves custom playbook via POST /api/templates', (await p.locator('section[aria-label="Playbooks"]').innerText()).includes('Custom Nightly Wave'))
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  // Live Policy Tester, Budget Guardrails, and Worktrees Inspector inside #settings Vaul drawer
  await p.getByRole('button', { name: 'Engines and settings' }).click(); await p.waitForTimeout(350)
  const budgetText = await p.locator('[data-testid="budget-guardrails"]').innerText()
  ok('Budget Guardrails renders daily cap utilization and session limits inside Settings',
    budgetText.includes('5 / 50') && budgetText.includes('30 min') && budgetText.includes('2 / run'))

  const wtBefore = await p.locator('[data-testid="worktree-row"]').count()
  await p.locator('[data-testid="worktree-prune-btn"]').first().click(); await p.waitForTimeout(150)
  await p.locator('[data-testid="worktree-confirm-prune"]').click(); await p.waitForTimeout(300)
  const wtAfter = await p.locator('[data-testid="worktree-row"]').count()
  ok('Worktrees Inspector lists repo checkouts and prunes individual non-main orphan via DELETE',
    wtBefore === 2 && wtAfter === 1,
    `before=${wtBefore} after=${wtAfter}`)

  await p.locator('#settings').getByRole('button', { name: 'Test policy' }).click(); await p.waitForTimeout(250)
  const ptText = await p.locator('[data-testid="policy-test-result"]').innerText()
  ok('Live Policy Tester evaluates POST /api/policies/test inside Settings',
    ptText.includes('opencode/deepseek-v4.1-flash-free') && ptText.includes('policies.rn'))
  await ctx.close()
}

// Update strip BANNER-FIX-BRIEF states (Dismiss -> Show update focus, manual Check un-dismisses, explanation text)
{
  const { ctx, p } = await open(1440, 900)
  await p.route('**/api/update', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ current: '0.4.0', latest: '0.5.0', available: true, can_apply: true, mode: 'notify', notes: 'Faster worktree diffs\nExtra detail line' }),
  }))
  await p.route('**/api/update/check', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ current: '0.4.0', latest: '0.5.0', available: true, can_apply: true, mode: 'notify', checked_at: Math.floor(Date.now() / 1000) }),
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

{
  const { ctx, p } = await open(1440, 900)
  p.__allow = /500/
  await p.goto(BASE); await ready(p)
  await p.route('**/api/sessions', r => r.fulfill({ status: 500, body: 'no' }))
  await p.waitForSelector('text=Cannot reach Fleet', { timeout: 6000 }).catch(() => {})
  ok('unreachable keeps the last list and says so', await p.locator('text=Cannot reach Fleet').count() === 1 && await cards(p).count() >= 1)
  await ctx.close()
}

{
  const { ctx, p } = await open(1440, 900)
  await p.route('**/api/sessions', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await p.route('**/api/inbox', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await p.goto(BASE); await p.waitForTimeout(1200)
  ok('empty board explains all three lanes and hero state',
    await p.locator('text=No verified receipt yet').count() === 1 &&
    await p.locator('text=No agent is running right now.').count() === 1)
  await p.screenshot({ path: `${OUT}/empty-1440.png` })
  await ctx.close()
}

{
  const { ctx, p } = await open(1440, 900)
  await p.route('**/api/sessions', async r => { await new Promise(s => setTimeout(s, 2500)); r.continue() })
  await p.goto(BASE); await p.waitForTimeout(500)
  ok('loading skeleton renders across three lanes', await p.locator('[aria-label="Board loading"]').count() === 1)
  await ctx.close()
}

{
  const { ctx, p } = await open(390, 844)
  await p.goto(BASE); await ready(p)
  await p.getByRole('button', { name: /Open slow: Profile the search endpoint/ }).click(); await p.waitForTimeout(700)
  ok('phone: session inspector opens in Vaul bottom drawer', await p.locator('[role=dialog]').count() === 1)
  await p.screenshot({ path: `${OUT}/drawer-390.png` })
  await p.keyboard.press('Escape'); await p.waitForTimeout(600)
  ok('phone: bottom bar actions visible', await p.locator('nav[aria-label="Board actions"]').isVisible())
  // Real 390x844 mobile tap test on Settings -> Dark -> Light
  const bgLum = () => p.evaluate(() => {
    const cx = document.createElement('canvas').getContext('2d')
    cx.fillStyle = getComputedStyle(document.body).backgroundColor
    cx.fillRect(0, 0, 1, 1)
    const [r, g, bb] = cx.getImageData(0, 0, 1, 1).data
    return 0.2126 * r + 0.7152 * g + 0.0722 * bb
  })
  const l0 = await bgLum()
  await p.locator('#settings-open').tap(); await p.waitForTimeout(400)
  await p.locator('#settings').getByRole('button', { name: 'Dark', exact: true }).tap(); await p.waitForTimeout(300)
  const dAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  const l1 = await bgLum()
  await p.locator('#settings').getByRole('button', { name: 'Light', exact: true }).tap(); await p.waitForTimeout(300)
  const lAttr = await p.evaluate(() => document.documentElement.dataset.theme)
  ok('phone 390x844: real tap on Settings toggles Dark/Light cleanly', dAttr === 'dark' && lAttr === 'light' && l1 < l0, `lum ${l0.toFixed(0)}->${l1.toFixed(0)}`)
  await ctx.close()
}

{
  const { ctx, p } = await open(1440, 900, 'light', { reducedMotion: 'reduce' })
  await p.goto(BASE); await ready(p); await p.waitForTimeout(1200)
  const moving = await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length)
  ok('reduced motion: no endless motion', moving === 0, String(moving))
  await ctx.close()
}

ok('no console errors', errs.length === 0, errs.slice(0, 5).join(' || '))
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ checks, errs }, null, 1))
report('gate', checks)
await b.close()
