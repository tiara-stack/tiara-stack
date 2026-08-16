import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { maximumScreenshotPngByteLength, type ScreenshotRenderTarget } from "./schema";

export const screenshotBrowserBounds = Object.freeze({
  navigationTimeoutMillis: 30_000,
  cssTimeoutMillis: 10_000,
  tableTimeoutMillis: 10_000,
  captureTimeoutMillis: 30_000,
  cleanupTimeoutMillis: 5_000,
  maximumViewportWidth: 8_192,
  maximumViewportHeight: 8_192,
  maximumViewportArea: 32 * 1024 * 1024,
  maximumPngByteLength: maximumScreenshotPngByteLength,
});

const nativeTimeoutMillis = (effectTimeoutMillis: number) =>
  Math.max(effectTimeoutMillis - 1_000, 1);

export const googleFontCssUrl = (() => {
  const url = new URL("https://fonts.googleapis.com/css2");
  url.searchParams.append("family", "Lexend:wght@100..900");
  url.searchParams.append("family", "Pacifico");
  url.searchParams.set("display", "swap");
  return url.toString();
})();

export const rewriteGoogleFontCss = (css: string): string =>
  css.replace(/font-family: '([^']+)';/gu, "font-family: 'docs-$1';");

export class ScreenshotBrowserError extends Data.TaggedError("ScreenshotBrowserError")<{
  readonly operation:
    | "load-playwright"
    | "load-css"
    | "launch"
    | "create-context"
    | "navigate"
    | "apply-css"
    | "find-table"
    | "set-viewport"
    | "capture"
    | "cleanup";
  readonly cause: unknown;
}> {}

interface ScreenshotBrowserShape {
  readonly capture: (
    target: ScreenshotRenderTarget,
  ) => Effect.Effect<Uint8Array, ScreenshotBrowserError>;
}

export class ScreenshotBrowser extends Context.Service<ScreenshotBrowser, ScreenshotBrowserShape>()(
  "sheet-workflows/ScreenshotBrowser",
) {}

const browserError =
  (operation: ScreenshotBrowserError["operation"]) =>
  (cause: unknown): ScreenshotBrowserError =>
    new ScreenshotBrowserError({ operation, cause });

const timedPromise = <A>(
  operation: ScreenshotBrowserError["operation"],
  timeoutMillis: number,
  run: () => Promise<A>,
) =>
  Effect.tryPromise({ try: run, catch: browserError(operation) }).pipe(
    Effect.timeout(`${timeoutMillis} millis`),
    Effect.mapError((error) =>
      Predicate.isTagged("ScreenshotBrowserError")(error) ? error : browserError(operation)(error),
    ),
  );

const ignoreCleanupFailure = (resource: "browser" | "context", close: () => Promise<void>) =>
  timedPromise("cleanup", screenshotBrowserBounds.cleanupTimeoutMillis, close).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Failed to close screenshot ${resource}`, error.cause).pipe(
        Effect.annotateLogs({ browserOperation: error.operation, browserResource: resource }),
      ),
    ),
  );

const closeBrowser = (browser: Browser) => ignoreCleanupFailure("browser", () => browser.close());

const closeContext = (context: BrowserContext) =>
  ignoreCleanupFailure("context", () => context.close());

const validateBoundingBox = (
  box: {
    readonly width: number;
    readonly height: number;
  } | null,
) => {
  if (Predicate.isNull(box)) {
    return Effect.fail(browserError("find-table")(new Error("Table not found")));
  }
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);
  const valid =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= screenshotBrowserBounds.maximumViewportWidth &&
    height <= screenshotBrowserBounds.maximumViewportHeight &&
    width * height <= screenshotBrowserBounds.maximumViewportArea;
  return valid
    ? Effect.succeed({ width, height })
    : Effect.fail(
        browserError("set-viewport")(
          new Error(`Table viewport ${width}x${height} exceeds the screenshot bounds`),
        ),
      );
};

const captureTable = (page: Page, table: Locator, css: string) =>
  Effect.gen(function* () {
    yield* timedPromise("apply-css", screenshotBrowserBounds.tableTimeoutMillis, () =>
      page.addStyleTag({ content: css }),
    );
    yield* timedPromise("find-table", screenshotBrowserBounds.tableTimeoutMillis, () =>
      table.waitFor({
        state: "visible",
        timeout: nativeTimeoutMillis(screenshotBrowserBounds.tableTimeoutMillis),
      }),
    );
    const box = yield* timedPromise("find-table", screenshotBrowserBounds.tableTimeoutMillis, () =>
      table.boundingBox({
        timeout: nativeTimeoutMillis(screenshotBrowserBounds.tableTimeoutMillis),
      }),
    ).pipe(Effect.flatMap(validateBoundingBox));
    yield* timedPromise("set-viewport", screenshotBrowserBounds.tableTimeoutMillis, () =>
      page.setViewportSize(box),
    );
    const captured = yield* timedPromise(
      "capture",
      screenshotBrowserBounds.captureTimeoutMillis,
      () =>
        table.screenshot({
          type: "png",
          timeout: nativeTimeoutMillis(screenshotBrowserBounds.captureTimeoutMillis),
        }),
    );
    const bytes = new Uint8Array(captured);
    if (bytes.byteLength > screenshotBrowserBounds.maximumPngByteLength) {
      return yield* browserError("capture")(
        new Error(
          `Screenshot byte length ${bytes.byteLength} exceeds ${screenshotBrowserBounds.maximumPngByteLength}`,
        ),
      );
    }
    return bytes;
  });

const captureWithBrowser = (browser: Browser, target: ScreenshotRenderTarget, css: string) =>
  Effect.acquireUseRelease(
    timedPromise("create-context", screenshotBrowserBounds.tableTimeoutMillis, () =>
      browser.newContext({ permissions: ["local-fonts"] }),
    ),
    (context) =>
      Effect.gen(function* () {
        const page = yield* timedPromise(
          "create-context",
          screenshotBrowserBounds.tableTimeoutMillis,
          () => context.newPage(),
        );
        page.setDefaultTimeout(nativeTimeoutMillis(screenshotBrowserBounds.tableTimeoutMillis));
        yield* timedPromise("navigate", screenshotBrowserBounds.navigationTimeoutMillis, () =>
          page.goto(target.url, {
            timeout: nativeTimeoutMillis(screenshotBrowserBounds.navigationTimeoutMillis),
            waitUntil: "load",
          }),
        );
        return yield* captureTable(page, page.locator("table").first(), css);
      }),
    (context) => closeContext(context),
  );

const makeScreenshotBrowser = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const capture: ScreenshotBrowserShape["capture"] = (target) =>
    Effect.gen(function* () {
      const css = yield* httpClient.get(googleFontCssUrl).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.timeout(`${screenshotBrowserBounds.cssTimeoutMillis} millis`),
        Effect.mapError(browserError("load-css")),
        Effect.map(rewriteGoogleFontCss),
      );
      const playwright = yield* Effect.tryPromise({
        try: () => import("playwright"),
        catch: browserError("load-playwright"),
      });
      return yield* Effect.acquireUseRelease(
        timedPromise("launch", screenshotBrowserBounds.navigationTimeoutMillis, () =>
          playwright.chromium.launch({ headless: true }),
        ),
        (browser) => captureWithBrowser(browser, target, css),
        (browser) => closeBrowser(browser),
      );
    });
  return { capture };
});

export const screenshotBrowserLayer = Layer.effect(ScreenshotBrowser, makeScreenshotBrowser);
