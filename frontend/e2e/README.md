# Fleet UI checks

`npm run check:ui`, run from `frontend/`, builds the frontend and the binary. It then starts Fleet on a free port with the fixture agent (`fixtures/agent.sh`) and a throwaway git repo, hands it five sessions (two pass, one fails its check, two stream for ten minutes), and runs two scripts, each on fresh sessions:

- `gate.mjs`: the control room gate, 31 checks. It measures the wall at 1440, 768, 390 and 320 px in light and dark. It then covers streaming panes, pin and close, receipts, search, retry and dismiss, inbox, new session, settings, the unreachable, empty and loading states, the phone drawer, console errors and reduced motion.
- `replay.mjs`: worst-case data fed in through `page.route` mocks, 6 checks.

Fleet runs each agent in its own process group, so each fixture agent writes its pid to `e2e/.out/run/agents/`. The check stops Fleet and every agent through those files, also when interrupted. The check fails unless every check passes and each script ran its full count.

Setup, once:

- `npm install`. `npm ci` fails on this branch because `package-lock.json` is out of sync with `package.json` (`react-is` is missing from the lock) in `frontend/`. Playwright is the frontend's own `playwright-core` devDependency.
- A Rust toolchain with this crate's dependencies already fetched (`cargo build --offline` must work).
- Chrome for Testing 151 at `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` (what `npx playwright@1.62.0 install chromium` puts there). To use another Chromium build, set `E2E_CHROME` to its path.

Flags, after `--` (`npm run check:ui -- --skip-build`):

- `--skip-build` reuses the last build.
- `--shots` adds screenshots at 1440 and 390, light and dark, on fresh data.
- `--lints` adds the taste, impeccable and Hallmark lints. They only report and never fail the check. The tools live outside this repo; `lints.sh` lists their default paths and the env vars that override them.

Screenshots, `result.json` files, logs and the run's data go to `e2e/.out/`, which git ignores. To bring the fixture up by hand, run `node e2e/fixture.mjs start` (it prints the URL); stop it with `node e2e/fixture.mjs stop`.
