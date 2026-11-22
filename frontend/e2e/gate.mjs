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

  // Inbox popover, New session MorphingDialog, Engines & Rune policy Vaul sheet
  await p.getByRole('button', { name: /^Needs you/ }).first().click(); await p.waitForTimeout(300)
  ok('Needs you inbox popover opens', await p.locator('text=Go to Needs you').isVisible())
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  const newTrigger = p.getByRole('button', { name: /New session/ }).first()
  await newTrigger.click(); await p.waitForTimeout(400)
  ok('New session MorphingDialog opens', await p.locator('[role=dialog]').count() >= 1)
  await p.keyboard.press('Escape'); await p.waitForTimeout(350)
  ok('New session dialog returns focus on Escape', (await p.evaluate(() => document.activeElement?.textContent || '')).includes('New session'))

  await p.getByRole('button', { name: 'Engines and settings' }).click(); await p.waitForTimeout(400)
  ok('Engines and Rune policy sheet opens', await p.locator('#settings').isVisible())
  await p.keyboard.press('Escape'); await p.waitForTimeout(350)
  await ctx.close()
}

// Update strip BANNER-FIX-BRIEF states (Dismiss -> Show update focus, manual Check un-dismisses, explanation text)
{
  const { ctx, p } = await open(1440, 900)
  await p.route('**/api/update', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ current: '0.3.0', latest: '0.4.0', available: true, can_apply: true, mode: 'notify', notes: 'Faster worktree diffs\nExtra detail line' }),
  }))
  await p.route('**/api/update/check', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ current: '0.3.0', latest: '0.4.0', available: true, can_apply: true, mode: 'notify', checked_at: Math.floor(Date.now() / 1000) }),
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
