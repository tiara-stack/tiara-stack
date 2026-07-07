import { Array, Effect, HashMap, Layer, Option, Context, pipe } from "effect";
import { HttpClient } from "effect/unstable/http";
import { chromium } from "playwright";
import { SheetService } from "./sheet";
import { joinURL, withQuery } from "ufo";
import { Struct as StructUtils } from "typhoon-core/utils";
import { makeUnknownError } from "typhoon-core/error";
import { GoogleSheets } from "./google/sheets";
import { NodeHttpClient } from "@effect/platform-node";

export class ScreenshotService extends Context.Service<ScreenshotService>()("ScreenshotService", {
  make: Effect.gen(function* () {
    const googleSheets = yield* GoogleSheets;
    const sheetService = yield* SheetService;
    const httpClient = yield* HttpClient.HttpClient;

    return {
      getScreenshot: Effect.fn("ScreenshotService.getScreenshot")(function* (
        sheetId: string,
        channel: string,
        day: number,
      ) {
        const [sheetGids, scheduleConfigs] = yield* Effect.all(
          [googleSheets.getSheetGids(sheetId), sheetService.getScheduleConfig(sheetId)],
          { concurrency: "unbounded" },
        );
        const filteredConfig = pipe(
          scheduleConfigs,
          Array.map(StructUtils.GetSomeFields.getSomeFields(["channel", "day", "screenshotRange"])),
          Array.getSomes,
          Array.filter((a) => a.channel === channel && a.day === day),
          Array.head,
        );
        const sheetGid = pipe(
          filteredConfig,
          Option.flatMap((a) => a.sheet),
          Option.flatMap((a) => HashMap.get(sheetGids, a)),
          Option.flatten,
        );

        if (Option.isNone(filteredConfig)) {
          return yield* Effect.fail(
            makeUnknownError(
              "Could not generate screenshot URL",
              new Error("Missing schedule config"),
            ),
          );
        }
        if (Option.isNone(sheetGid)) {
          return yield* Effect.fail(
            makeUnknownError("Could not generate screenshot URL", new Error("Missing sheet GID")),
          );
        }

        const url = withQuery(
          joinURL("https://docs.google.com/spreadsheets/d", `/${sheetId}`, `/htmlembed`),
          {
            single: true,
            gid: sheetGid.value,
            range: filteredConfig.value.screenshotRange,
            widget: false,
            chrome: false,
            headers: false,
          },
        );
        yield* Effect.log(`Screenshot URL: ${url}`);
        const cssResponse = yield* httpClient
          .get(
            withQuery("https://fonts.googleapis.com/css2", {
              family: ["Lexend:wght@100..900", "Pacifico"],
              display: "swap",
            }),
          )
          .pipe(Effect.mapError((error) => makeUnknownError("Error getting CSS", error)));
        const cssText = yield* cssResponse.text.pipe(
          Effect.mapError((error) => makeUnknownError("Error getting CSS", error)),
        );
        const css = cssText.replace(/font-family: '([^']+)';/g, `font-family: 'docs-$1';`);

        return yield* pipe(
          Effect.tryPromise({
            try: async () => {
              const browser = await chromium.launch();
              const context = await browser.newContext({
                permissions: ["local-fonts"],
              });
              const page = await context.newPage();
              await page.goto(url);
              await page.addStyleTag({ content: css });
              const boundingBox = await page.locator("table").boundingBox();
              if (!boundingBox) {
                throw new Error("Table not found");
              }
              await page.setViewportSize({
                width: boundingBox.width,
                height: boundingBox.height,
              });
              const buffer = await page.locator("table").screenshot({ type: "png" });
              await browser.close();
              return new Uint8Array(buffer);
            },
            catch: (error) => makeUnknownError("Error getting screenshot", error),
          }),
          Effect.withSpan("ScreenshotService.getScreenshot"),
        );
      }),
    };
  }),
}) {
  static layer = Layer.effect(ScreenshotService, this.make).pipe(
    Layer.provide([GoogleSheets.layer, SheetService.layer, NodeHttpClient.layerFetch]),
  );
}
