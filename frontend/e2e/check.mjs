// check.mjs — `npm run check:ui [-- --skip-build --shots --lints]` from frontend/.
// Builds the frontend and the binary, starts Fleet on a free port with the fixture agent and five seeded sessions,
// runs the control room gate and the worst-case replay (each on fresh data), then stops Fleet and every agent it
// started. Fails unless every check passes and each script ran its full count. Output: frontend/e2e/.out/.
import { build, start, seed, stop, results, BASE, E2E, OUT } from './fixture.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
const EXPECT = { gate: 31, replay: 6 }
const args = new Set(process.argv.slice(2))
await stop() // anything an interrupted run left behind
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop().finally(() => process.exit(130)))
fs.rmSync(OUT, { recursive: true, force: true })
let crashed = null
try {
  if (!args.has('--skip-build')) build()
  // the gate seeds its own sessions; the others get fresh ones and the same 8 s to settle
  const seeded = async () => { const url = await start({ fresh: true }); await seed(); await new Promise(r => setTimeout(r, 8000)); return url }
  for (const step of ['gate', 'replay', ...(args.has('--shots') ? ['shots'] : [])]) {
    console.log(`\n== ${step} on ${step === 'gate' ? await start({ fresh: true }) : await seeded()}`)
    await import(`./${step}.mjs`)
  }
  if (args.has('--lints')) {
    console.log(`\n== lints (report only) on ${await seeded()}`)
    execFileSync('bash', [`${E2E}/lints.sh`, BASE, `${OUT}/lints`], { stdio: 'inherit' })
  }
} catch (e) { crashed = e } finally { await stop() }
if (crashed) { console.error('\ncheck:ui stopped:', crashed); process.exit(1) }
let bad = 0
console.log('\n== check:ui')
for (const [name, want] of Object.entries(EXPECT)) {
  const r = results.find(x => x.name === name)
  const fine = r && r.pass === r.total && r.total === want
  if (!fine) bad++
  console.log(`${fine ? 'ok  ' : 'FAIL'} ${name} ${r ? `${r.pass}/${r.total}` : 'did not run'}${r && r.total !== want ? ` (expected ${want} checks)` : ''}`)
}
process.exit(bad ? 1 : 0)
