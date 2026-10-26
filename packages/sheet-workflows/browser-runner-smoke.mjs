import assert from "node:assert/strict";

const playwrightModule = process.env.TIA_BROWSER_SMOKE_PLAYWRIGHT_MODULE ?? "playwright";
const { chromium } = await import(playwrightModule);

const fixtureUrl = new URL("./browser-runner-smoke.html", import.meta.url);
const server = await chromium.launchServer({ headless: true });
const child = server.process();
const browser = await chromium.connect(server.wsEndpoint());
try {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(fixtureUrl.href, { waitUntil: "load" });
    assert.equal(
      await page.locator("[data-browser-smoke=ready]").textContent(),
      "Controlled browser fixture",
    );
    assert.equal(await page.locator("table tbody tr").count(), 1);
    const screenshot = await page.locator("table").screenshot({ type: "png" });
    assert.ok(screenshot.byteLength > 0, "Chromium must render the controlled fixture");
    const failedPage = await context.newPage();
    await assert.rejects(failedPage.goto("file:///missing-browser-runner-fixture.html"));
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
assert.notEqual(child.exitCode, null, "Chromium child must stop with its runner owner");
