// cases.mjs: ultra-design kit/replay.mjs worst-case suite for DSH-Fleet v0.3.0.
// Run: PLAYWRIGHT=/home/cayleb/Work/scratch/goal-20261118/_fe/base/node_modules/playwright-core/index.mjs \
//      CHROME_PATH=/home/cayleb/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
//      node /home/cayleb/.agents/skills/ultra-design/kit/replay.mjs <url> cases.mjs
export default ({ LONG, patch, malformed, down, has, json }) => [
  {
    name: 'malformed /api/sessions shows unreachable alert and never fake zero counters',
    routes: [['**/api/sessions', malformed]],
    check: async (p) => {
      if (!(await has(p, 'Fleet has not answered yet'))) return 'missing unreachable explanation'
      const scan = await p.locator('section[aria-label="Scan"]').innerText()
      if (/\b0\b/.test(scan.replace(/Recent sessions[\s\S]*/, ''))) return 'scan strip showed fake 0 before data loaded: ' + scan
      return true
    },
  },
  {
    name: 'unreachable /api/sessions shows unreachable alert and never fake zero counters',
    routes: [['**/api/sessions', down]],
    check: async (p) => {
      if (!(await has(p, 'Fleet has not answered yet'))) return 'missing unreachable explanation'
      const scan = await p.locator('section[aria-label="Scan"]').innerText()
      if (/\b0\b/.test(scan.replace(/Recent sessions[\s\S]*/, ''))) return 'scan strip showed fake 0 before data loaded: ' + scan
      return true
    },
  },
  {
    name: 'object-shaped /api/sessions error reply does not crash or show zeros',
    routes: [['**/api/sessions', (r) => json(r, { error: 'sessions unavailable' })]],
    check: async (p) => (await has(p, 'Fleet has not answered yet')) || 'missing unreachable explanation',
  },
  {
    name: 'null entries, blank task, archived session, and null transcript/diff/steer render cleanly',
    routes: [[
      '**/api/sessions',
      patch((j) => [
        null,
        { id: 'arch-1', task: 'Archived task', bucket: 'archived', status: 'archived', transcript: null },
        ...j.map((s, i) =>
          i === 0
            ? { ...s, task: '', project: null, transcript: null, diff: null, steer: null, next_queue: null, merge_error: 'bad' }
            : s,
        ),
      ]),
    ]],
    check: async (p) => {
      if (!(await has(p, 'Untitled session'))) return 'blank task fallback missing'
      if (await has(p, 'Archived task')) return 'archived session leaked onto board'
      return true
    },
  },
  {
    name: 'long unbroken task, reason, project, branch, and check command stay inside their boxes',
    shot: true,
    routes: [[
      '**/api/sessions',
      patch((j) =>
        j.map((s, i) =>
          i === 0
            ? {
                ...s,
                task: 'Fix_' + LONG,
                project: 'proj_' + LONG,
                branch: 'fleet/' + LONG,
                reason: 'Stopped_at_' + LONG,
                check_cmd: 'cargo_test_' + LONG,
              }
            : s,
        ),
      ),
    ]],
    check: async (p) => (await p.locator('div[aria-label="Session lanes"]').count()) === 1 || 'lanes missing',
  },
  {
    name: 'null and numeric agent entries in /api/policy do not break the board',
    routes: [[
      '**/api/policy',
      patch((pol) => ({ ...pol, agents: [null, { name: null, found: true }, { name: 42, found: false }, ...(pol.agents || [])] })),
    ]],
    check: async (p) => (await p.locator('header h1').innerText()) === 'Fleet' || 'header missing',
  },
]
