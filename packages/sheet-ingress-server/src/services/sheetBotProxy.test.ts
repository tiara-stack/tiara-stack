import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SheetBotForwardingClient } from "./sheetBotForwardingClient";
import { forwardSheetBotPayload } from "./sheetBotProxy";

describe("sheet bot proxy handlers", () => {
  it("forwards createInteractionResponse with the raw payload body", async () => {
    const calls: Array<unknown> = [];
    const payload = {
      interactionId: "interaction-1",
      interactionToken: "token-1",
      payload: {
        type: 4,
        data: { content: "hello" },
      },
    };

    const handler = forwardSheetBotPayload("bot", "createInteractionResponse");
    const result = await Effect.runPromise(
      handler({ payload } as never).pipe(
        Effect.provideService(SheetBotForwardingClient, {
          bot: {
            createInteractionResponse: (args: unknown) => {
              calls.push(args);
              return Effect.succeed({ interaction: { id: "interaction-1", type: 2 } });
            },
          },
        } as never),
      ) as Effect.Effect<unknown, unknown, never>,
    );

    expect(calls).toEqual([payload]);
    expect(result).toEqual({ interaction: { id: "interaction-1", type: 2 } });
  });
});
