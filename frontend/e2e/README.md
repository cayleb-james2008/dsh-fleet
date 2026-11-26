# Fleet UI checks

`npm run check:ui`, run from `frontend/`, builds the Antigravity sidecar bundle (`sidecars/fleet_pane/dist/index.html`) via Vite, starts `sidecars/fleet_pane/main.mjs` in standalone loopback mode against a seeded `<appData>/brain` fixture and temporary git worktree repo under `frontend/e2e/.out/`, and runs two Playwright verification suites:

- `gate.mjs`: control room gate covering 340px-380px sidebar and 1440px widths in light and dark mode, native `plan.json` / `view.json` triage, `POST /api/plan`, `POST /api/control`, channel tabs, `replyRefs` backlinks, worktree collision & action lifecycle, search, unreachable/empty/loading states, console errors, and reduced motion.
- `replay.mjs`: worst-case mock payloads fed through `page.route` overrides.

The check fails unless every check passes and each script matches its expected count in `e2e/check.mjs`.

Setup, once:

- `npm ci` (or `npm install`). Playwright is the frontend's `playwright-core` devDependency.
- Chromium for Testing at `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` (or set `E2E_CHROME` to another Chromium binary path).

Flags, after `--` (`npm run check:ui -- --skip-build`):

- `--skip-build` reuses the last `sidecars/fleet_pane/dist/index.html` build.
- `--lints` runs taste, impeccable, and Hallmark `sloplint` checks (report-only).

Screenshots, logs, and fixture data go to `e2e/.out/`, which git ignores. To start the standalone fixture manually, run `node e2e/fixture.mjs` or use `sidecars/fleet_pane/main.mjs --port <port> --app-data-dir <dir>`.
