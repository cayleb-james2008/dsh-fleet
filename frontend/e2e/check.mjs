// check.mjs — `npm run check:ui [-- --skip-build --lints]` from frontend/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { BASE, E2E, OUT, build, results, start, stop } from "./fixture.mjs";

const EXPECT = { gate: 61, replay: 8 };
const args = new Set(process.argv.slice(2));

await stop();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => stop().finally(() => process.exit(130)));
}
fs.rmSync(OUT, { recursive: true, force: true });

let crashed = null;
try {
  if (!args.has("--skip-build")) build();
  for (const step of ["gate", "replay"]) {
    const url = await start({ fresh: true });
    console.log(`\n== ${step} on ${url}`);
    await import(`./${step}.mjs`);
  }
  if (args.has("--lints")) {
    const url = await start({ fresh: true });
    console.log(`\n== lints (report only) on ${url}`);
    execFileSync("bash", [`${E2E}/lints.sh`, url, `${OUT}/lints`], { stdio: "inherit" });
  }
} catch (err) {
  crashed = err;
} finally {
  await stop();
}

if (crashed) {
  console.error("\ncheck:ui stopped:", crashed);
  process.exit(1);
}

let bad = 0;
console.log("\n== check:ui");
for (const [name, want] of Object.entries(EXPECT)) {
  const r = results.find((x) => x.name === name);
  const fine = r && r.pass === r.total && r.total === want;
  if (!fine) bad++;
  console.log(
    `${fine ? "ok  " : "FAIL"} ${name} ${r ? `${r.pass}/${r.total}` : "did not run"}${r && r.total !== want ? ` (expected ${want})` : ""}`,
  );
}
process.exit(bad ? 1 : 0);
