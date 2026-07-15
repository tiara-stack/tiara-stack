import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeClientDeliveryMock } from "./testHelpers";

it.effect("resolves spread delivery overrides through the bound client", () =>
  Effect.gen(function* () {
    const expected = { id: "message-1", conversation_id: "conversation-1" };
    const client = {
      ...makeClientDeliveryMock(),
      sendMessage: () => Effect.succeed(expected),
    };

    const delivered = yield* client.forClient(undefined).sendMessage("conversation-1", {});

    expect(delivered).toEqual(expected);
  }),
);
