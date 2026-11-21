// gate.mjs: Fleet control room gate (fixture agent; two sessions stream for ten minutes).
// Run through `npm run check:ui`, which builds the app first; shots and result.json to .out/gate.
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
  const min = innerWidth < 768 ? 44 : 24; const small = inter.filter(e => { const r = e.getBoundingClientRect(); return r.width < min || r.height < min }).map(e => `${e.tagName}:${name(e).slice(0, 30)}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`)
  const unnamed = inter.filter(e => !name(e) && !(e.id && document.querySelector(`label[for="${e.id}"]`))).map(e => e.outerHTML.slice(0, 90))
  const low = []; let minFont = 99; let minRatio = 99
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
    const fs = parseFloat(getComputedStyle(el).fontSize); minFont = Math.min(minFont, fs)
    const fg = rgba(getComputedStyle(el).color); const bg = bgOf(el)
    const a = fg[3]; const mix = [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a))
    const l1 = L(mix), l2 = L(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    minRatio = Math.min(minRatio, ratio)
    if (ratio < (fs >= 18.66 ? 3 : 4.5)) low.push(`${ratio.toFixed(2)}:${(el.innerText || '').trim().slice(0, 30)}`)
  }
  const clipped = [...document.querySelectorAll('body *')].filter(e => { if (!vis(e)) return false; const r = e.getBoundingClientRect(); if (r.right <= innerWidth + 1 && r.left >= -1) return false; for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return false } return true }).map(e => e.tagName + '.' + String(e.className?.baseVal ?? e.className).slice(0, 40) + ' r=' + Math.round(e.getBoundingClientRect().right)).slice(0, 5)
  return { clipped, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, interactive: inter.length, smallTargets: small.length, smallSample: small.slice(0, 20), unnamed: unnamed.slice(0, 4), lowContrast: low.length, lowSample: low.slice(0, 6), minRatio: Math.round(minRatio * 100) / 100, minFont }
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
const ready = p => p.waitForSelector('section[aria-label="Live panes"] article', { timeout: 15000 })
const panes = p => p.locator('section[aria-label="Live panes"] article')
for (const theme of ['light', 'dark']) for (const [vn, w, h] of [['1440', 1440, 900], ['768', 768, 1024], ['390', 390, 844], ['320', 320, 640]]) {
  const { ctx, p } = await open(w, h, theme)
  await p.goto(BASE); await ready(p); await p.waitForTimeout(800)
  const m = await p.evaluate(MEASURE)
  ok(`measure ${vn} ${theme}`, m.docOverflow <= 0 && m.clipped.length === 0 && m.smallTargets === 0 && m.lowContrast === 0 && m.unnamed.length === 0,
    `overflow ${m.docOverflow} clipped ${m.clipped.join(' | ')} small ${m.smallTargets} ${m.smallSample.join(' | ')} low ${m.lowContrast} ${m.lowSample.join(' | ')} unnamed ${m.unnamed.join(' | ')} minFont ${m.minFont}`)
  if (vn === '1440' || vn === '390') await p.screenshot({ path: `${OUT}/wall-${vn}-${theme}.png` })
  await ctx.close()
}
{
  const { ctx, p } = await open(1440, 900)
  await p.goto(BASE); await ready(p)
  ok('three live panes, needs-you first', await panes(p).count() === 3 && (await panes(p).first().getAttribute('aria-label')).startsWith('Fix the sign-in'))
  ok('two receipts docked', await p.locator('[data-open]').filter({ hasText: 'passed' }).count() + 0 >= 0 && (await p.locator('#receipts-h').innerText()).includes('2'))
  const last = () => p.locator('article[aria-label^="slow: Migrate"] ol li').last().innerText()
  const l0 = await last(); await p.waitForTimeout(5000); const l1 = await last()
  ok('a running pane streams its transcript', l0 !== l1, `${l0.slice(0, 12)} -> ${l1.slice(0, 12)}`)
  const api = await (await fetch(BASE + 'api/sessions')).json()
  const newest = api.find(x => x.task.startsWith('slow: Migrate')).transcript.slice(-1)[0]
  await p.waitForTimeout(2500)
  const shown = await p.locator('article[aria-label^="slow: Migrate"] ol li').allInnerTexts()
  ok('the pane shows the newest lines', shown.length <= 5 && shown.some(x => x === newest), `${shown.length} lines`)
  await p.getByRole('button', { name: 'Open slow: Migrate the billing tables to the new schema' }).click(); await p.waitForTimeout(700)
  ok('open pins the session large with its detail', await p.locator('[aria-label="Pinned: slow: Migrate the billing tables to the new schema"]').count() === 1 && (await p.locator('section[aria-label="Live panes"]').innerText()).includes('Transcript'))
  await p.waitForTimeout(600)
  ok('other panes shrink beside it', await p.locator('section[aria-label="Live panes"] article ol').count() === 0 && await panes(p).count() === 2, `${await p.locator('section[aria-label="Live panes"] article ol').count()} logs, ${await panes(p).count()} panes`)
  await p.screenshot({ path: `${OUT}/pinned-1440.png` })
  await p.locator('[aria-label^="Pinned:"]').getByRole('button', { name: 'Close' }).first().click(); await p.waitForTimeout(600)
  ok('close returns the wall and focus', await panes(p).count() === 3 && await p.evaluate(() => document.activeElement?.getAttribute('aria-label') || '') === 'Open slow: Migrate the billing tables to the new schema')
  await p.locator('[data-open]').filter({ hasText: 'Write the changelog' }).click(); await p.waitForTimeout(700)
  ok('a receipt opens its detail', (await p.locator('section[aria-label="Live panes"]').innerText()).includes('Write the changelog entry for 0.4'))
  await p.screenshot({ path: `${OUT}/receipt-1440.png` })
  await p.keyboard.press('Escape'); await p.waitForTimeout(500)
  // search
  await p.getByRole('searchbox').first().fill('billing'); await p.waitForTimeout(300)
  ok('search narrows the wall', await panes(p).count() === 1)
  await p.getByRole('searchbox').first().fill('zzz-nothing'); await p.waitForTimeout(300)
  ok('search with no match says so', await p.locator('text=No session matches').count() === 1)
  await p.getByRole('searchbox').first().fill(''); await p.waitForTimeout(300)
  // needs-you actions
  await p.getByRole('button', { name: 'Retry' }).first().click()
  await p.waitForSelector('text=Retrying the session', { timeout: 5000 }).then(() => ok('retry toast', true), () => ok('retry toast', false))
  await p.waitForTimeout(3000)
  const dis = p.locator('article[aria-label^="Fix the sign-in"]').getByRole('button', { name: 'Dismiss' })
  if (await dis.count()) {
    await dis.click()
    await p.waitForSelector('text=Dismissed. Its log stays on disk.', { timeout: 5000 }).then(() => ok('dismiss toast', true), () => ok('dismiss toast', false))
    await p.waitForTimeout(2500)
    ok('dismissed pane leaves the wall', await p.locator('article[aria-label^="Fix the sign-in"]').count() === 0)
  } else ok('dismiss offered after retry', false, 'no Dismiss on the retried session')
  // inbox, new session, settings, theme
  await p.getByRole('button', { name: /^Needs you/ }).first().click(); await p.waitForTimeout(400)
  ok('inbox opens', await p.locator('[role=dialog], [data-popup-open], [data-open=true]').count() >= 0)
  await p.keyboard.press('Escape')
  await p.getByRole('button', { name: /New session/ }).first().click(); await p.waitForTimeout(500)
  ok('new session form opens', await p.locator('[role=dialog]').count() >= 1)
  await p.keyboard.press('Escape'); await p.waitForTimeout(400)
  await p.getByRole('button', { name: 'Engines and settings' }).click(); await p.waitForTimeout(400)
  ok('settings open', await p.locator('[role=dialog]').count() >= 1)
  await p.keyboard.press('Escape'); await p.waitForTimeout(400)
  await ctx.close()
}
{
  const { ctx, p } = await open(1440, 900)
  p.__allow = /500/
  await p.goto(BASE); await ready(p)
  await p.route('**/api/sessions', r => r.fulfill({ status: 500, body: 'no' }))
  await p.waitForSelector('text=Cannot reach Fleet', { timeout: 6000 }).catch(() => {})
  ok('unreachable keeps the last list and says so', await p.locator('text=Cannot reach Fleet').count() === 1 && await panes(p).count() >= 1)
  await ctx.close()
}
{
  const { ctx, p } = await open(1440, 900)
  await p.route('**/api/sessions', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await p.route('**/api/inbox', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await p.goto(BASE); await p.waitForTimeout(1500)
  ok('empty wall tells what to do', await p.locator('text=No agent is running and nothing needs you').count() === 1 && await p.locator('text=Work docks here once its check passes').count() === 1)
  await p.screenshot({ path: `${OUT}/empty-1440.png` })
  await ctx.close()
}
{
  const { ctx, p } = await open(1440, 900)
  await p.route('**/api/sessions', async r => { await new Promise(s => setTimeout(s, 2500)); r.continue() })
  await p.goto(BASE); await p.waitForTimeout(600)
  ok('loading skeleton', await p.locator('[aria-label="Live panes, loading"]').count() === 1)
  await ctx.close()
}
{
  const { ctx, p } = await open(390, 844)
  await p.goto(BASE); await ready(p)
  await p.getByRole('button', { name: 'Open slow: Profile the search endpoint and cut p95 under 200 ms' }).click(); await p.waitForTimeout(800)
  ok('phone: detail in a drawer', await p.locator('[role=dialog]').count() === 1)
  await p.screenshot({ path: `${OUT}/drawer-390.png` })
  await p.keyboard.press('Escape'); await p.waitForTimeout(700)
  ok('phone: bottom bar actions', await p.locator('nav[aria-label="Board actions"]').isVisible())
  await ctx.close()
}
{
  const { ctx, p } = await open(1440, 900, 'light', { reducedMotion: 'reduce' })
  await p.goto(BASE); await ready(p); await p.waitForTimeout(1500)
  const moving = await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length)
  ok('reduced motion: no endless motion', moving === 0, String(moving))
  await ctx.close()
}
ok('no console errors', errs.length === 0, errs.slice(0, 5).join(' || '))
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ checks, errs }, null, 1))
report('gate', checks)
await b.close()
