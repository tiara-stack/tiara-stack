import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { readConfigurationAttachment } from "./sheet";

describe("Sheet Configuration attachment transport", () => {
  it.effect("drains a rejected redirect response before failing", () =>
    Effect.gen(function* () {
      let response: Response | undefined;
      const requestClient = HttpClient.make((request) => {
        response = new Response("redirect body", { status: 302 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const exit = yield* Effect.exit(
        readConfigurationAttachment(requestClient, {
          filename: "sheet-configuration.json",
          size: 15,
          url: "https://cdn.discordapp.com/attachments/1/sheet-configuration.json",
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "SheetCommandError",
        message: "The attached configuration file could not be downloaded.",
      });
      expect(response?.bodyUsed).toBe(true);
    }),
  );
});
