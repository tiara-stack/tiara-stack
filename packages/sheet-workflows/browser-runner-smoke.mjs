import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.TIA_BROWSER_SMOKE_PLAYWRIGHT_MODULE ?? "playwright";
const cleanupTimeoutMillis = 5_000;

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

const runBoundedCleanup = (resource, cleanup) =>
  new Promise((resolveCleanup, rejectCleanup) => {
    let settled = false;
    const finish = (failed, error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) rejectCleanup(error);
      else resolveCleanup(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          true,
          new Error(`Browser smoke ${resource} cleanup exceeded ${cleanupTimeoutMillis} ms`),
        ),
      cleanupTimeoutMillis,
    );
    Promise.resolve()
      .then(cleanup)
      .then(
        (value) => finish(false, undefined, value),
        (error) => finish(true, error ?? new Error(`Browser smoke ${resource} cleanup failed`)),
      );
  });

const childIsLive = (child) => child.exitCode === null && child.signalCode === null;

const requestChildStop = async (child, cleanupErrors) => {
  if (!childIsLive(child)) return;
  try {
    const signalRequested = child.kill("SIGTERM");
    if (!signalRequested && childIsLive(child))
      cleanupErrors.push(new Error("Browser smoke server child did not accept SIGTERM"));
  } catch (error) {
    cleanupErrors.push(error);
  }
};

const attemptCleanup = async (resource, cleanup, cleanupErrors) => {
  try {
    await runBoundedCleanup(resource, cleanup);
    return undefined;
  } catch (error) {
    cleanupErrors.push(error);
    return error;
  }
};

const renderControlledFixture = async (context, fixtureUrl) => {
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
};

const acquireSmokeBrowserAndRender = async (chromium, server, resources) => {
  resources.child = server.process();
  resources.browser = await chromium.connect(server.wsEndpoint());
  resources.context = await resources.browser.newContext();
  const fixtureUrl = new URL("./browser-runner-smoke.html", import.meta.url);
  await renderControlledFixture(resources.context, fixtureUrl);
};

const closeAcquiredBrowserResources = async (resources, cleanupErrors) => {
  if (resources.context !== undefined)
    await attemptCleanup("context.close", () => resources.context.close(), cleanupErrors);
  if (resources.browser !== undefined)
    await attemptCleanup("browser.close", () => resources.browser.close(), cleanupErrors);
};

const waitForChildCessation = async (child, cleanupErrors) => {
  try {
    await waitForChildExit(child, cleanupTimeoutMillis);
    return;
  } catch (error) {
    cleanupErrors.push(error);
  }
  await requestChildStop(child, cleanupErrors);
  if (!childIsLive(child)) return;
  try {
    await waitForChildExit(child, cleanupTimeoutMillis);
  } catch (error) {
    cleanupErrors.push(error);
  }
};

const cleanupSmokeResources = async (server, resources) => {
  const cleanupErrors = [];
  await closeAcquiredBrowserResources(resources, cleanupErrors);
  const serverCloseError = await attemptCleanup(
    "server.close",
    () => server.close(),
    cleanupErrors,
  );
  if (resources.child === undefined) return cleanupErrors;
  if (serverCloseError !== undefined) await requestChildStop(resources.child, cleanupErrors);
  await waitForChildCessation(resources.child, cleanupErrors);
  return cleanupErrors;
};

const throwSmokeFailures = (smokeError, cleanupErrors) => {
  const failures = smokeError === undefined ? cleanupErrors : [smokeError, ...cleanupErrors];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Browser smoke failed or cleanup was incomplete");
};

const runSmokeWithChromium = async (chromium) => {
  const server = await chromium.launchServer({ headless: true });
  const resources = {};
  let smokeError;
  try {
    await acquireSmokeBrowserAndRender(chromium, server, resources);
  } catch (error) {
    smokeError = error ?? new Error("Browser smoke failed without an error");
  }
  throwSmokeFailures(smokeError, await cleanupSmokeResources(server, resources));
};

const runSmoke = async () => {
  const { chromium } = await import(playwrightModule);
  await runSmokeWithChromium(chromium);
};

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await runSmoke();
