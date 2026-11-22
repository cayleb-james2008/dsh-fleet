// replay.mjs: Fleet's worst-case data checks via browser page.route mocks (1440 and 390).
import { BASE, OUT as E2E_OUT, launch, report } from './fixture.mjs'
import fs from 'node:fs'
const OUT = `${E2E_OUT}/replay`
fs.mkdirSync(OUT, { recursive: true })
const b = await launch()
const res = []
const ok = (n, p, d = '') => { res.push({ n, p: !!p, d }); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')) }
const LONG = 'x'.repeat(260)
const clipped = p => p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => {
  const r = e.getBoundingClientRect()
  if (!r.width || r.right <= innerWidth + 1) return false
  for (let q = e.parentElement; q; q = q.parentElement) {
    const o = getComputedStyle(q).overflowX
    if (o !== 'visible') return false
  }
  return true
}).length)

async function page(w, url, routes) {
  const ctx = await b.newContext({ viewport: { width: w, height: w < 768 ? 844 : 900 } })
  const p = await ctx.newPage(); p.errs = []
  p.on('pageerror', e => p.errs.push(e.message))
  for (const [pat, fn] of routes) await p.route(pat, fn)
  await p.goto(url); await p.waitForTimeout(2200)
  return { ctx, p }
}
const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) })
const patch = (fn) => async r => { const res = await r.fetch(); const j = await res.json(); r.fulfill({ response: res, body: JSON.stringify(fn(j)) }) }

for (const w of [1440, 390]) {
  {
    const { ctx, p } = await page(w, BASE, [['**/api/sessions', r => json(r, 'no', 500)]])
    const band = await p.locator('section[aria-label=Scan]').innerText()
    ok(`fleet ${w}: unreachable from the start says so; no zeros`,
      await p.locator('text=Fleet has not answered yet').count() === 1 && !/\b0\b/.test(band.replace(/Recent sessions/, '')))
    await ctx.close()
  }
  {
    const { ctx, p } = await page(w, BASE, [['**/api/sessions', patch(j => [null, ...j.map((s, i) => i ? s : { ...s, task: '', transcript: null, steer: null })])]])
    ok(`fleet ${w}: null entry, blank task, and null transcript do not blank the board`,
      !p.errs.length && await p.locator('div[aria-label="Session lanes"]').count() === 1 && await p.locator('text=Untitled session').count() >= 1,
      p.errs.join('|'))
    await ctx.close()
  }
  {
    const { ctx, p } = await page(w, BASE, [['**/api/sessions', patch(j => j.map(s => s.bucket === 'needs-you' ? { ...s, reason: 'Check failed: ' + LONG, project: 'p/' + LONG, branch: 'fleet/' + LONG } : s))]])
    ok(`fleet ${w}: long unbroken reason/project/branch stay inside their lane`, (await clipped(p)) === 0)
    await p.screenshot({ path: `${OUT}/fleet-long-${w}.png` })
    await ctx.close()
  }
}
await b.close()
report('replay', res)
