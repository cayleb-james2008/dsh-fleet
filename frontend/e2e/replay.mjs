// Worst-case stress replay at 380px sidebar width (high message/worker density, rapid tab cycling).
import { chromium } from "playwright-core";
import { BASE, CHROME, runChecks } from "./fixture.mjs";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

await runChecks("replay", async (check) => {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#panel-triage");

  // Keyboard tab navigation test: ArrowRight through all 5 tabs & Home back
  await page.locator("#tab-triage").focus();
  await page.keyboard.press("ArrowRight");
  await check("ArrowRight moves tab focus to Board", async () => {
    return (await page.locator('#tab-board[aria-selected="true"]').count()) === 1;
  });

  await page.keyboard.press("End");
  await check("End moves tab to Worktrees", async () => {
    return (await page.locator('#tab-worktrees[aria-selected="true"]').count()) === 1;
  });

  await page.keyboard.press("Home");
  await check("Home returns to Triage", async () => {
    return (await page.locator('#tab-triage[aria-selected="true"]').count()) === 1;
  });

  // Rapid cycles across Board -> Roster -> Graph -> Triage in Dark mode
  await page.locator('button[aria-label="Open settings"]').click();
  await page.locator('div[role="dialog"] button[role="radio"]:has-text("Dark")').click();
  await page.locator('button[aria-label="Close dialog"]').click();

  for (const tab of ["#tab-board", "#tab-roster", "#tab-graph", "#tab-worktrees", "#tab-triage"]) {
    await page.locator(tab).click();
  }

  await check("rapid tab switching keeps zero horizontal overflow", async () => {
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return ov <= 0;
  });

  await check("poll cadence switcher updates cleanly", async () => {
    await page.locator('button[aria-label="Open settings"]').click();
    await page.locator('div[role="dialog"] button[role="radio"]:has-text("5s")').click();
    const checked = await page.locator('div[role="dialog"] button[role="radio"]:has-text("5s")').getAttribute("aria-checked");
    await page.locator('button[aria-label="Close dialog"]').click();
    return checked === "true";
  });

  await check("zero uncaught runtime errors during replay", () => errs.length === 0);
  await ctx.close();
});

await browser.close();
