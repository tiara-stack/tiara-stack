import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.TIA_BROWSER_SMOKE_PLAYWRIGHT_MODULE ?? "playwright";

export const waitForChildExit = (child, timeoutMillis) =>
  new Promise((resolveExit, rejectExit) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) rejectExit(error);
      else resolveExit(result);
    };
    const onExit = (code, signal) => finish(undefined, { code, signal });
    const onError = (error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error(`Child process did not exit within ${timeoutMillis} ms`)),
      timeoutMillis,
    );

    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null)
      onExit(child.exitCode, child.signalCode);
  });

const runSmoke = async () => {
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
    try {
      await browser.close();
    } finally {
      try {
        await server.close();
      } finally {
        await waitForChildExit(child, 5_000);
      }
    }
  }
};

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await runSmoke();
