import { describe, expect, it } from "@effect/vitest";
import { SubCommandBuilder } from "dfx-discord-utils/utils";
import { Duration, Effect, Option, Predicate, Stream } from "effect";
import { makeSavedMessageSubCommandData, terminalRun } from "./checkinSavedMessage";

describe("saved check-in message command", () => {
  it("places the required hour option before optional options", () => {
    const data = makeSavedMessageSubCommandData(new SubCommandBuilder()).toJSON();

    expect(data.options?.map((option) => option.name)).toEqual([
      "hour",
      "channel_name",
      "server_id",
    ]);
    expect(
      data.options?.map((option) =>
        Predicate.hasProperty(option, "required") ? option.required === true : false,
      ),
    ).toEqual([true, false, false]);
  });

  it.effect("polls one-shot workflow snapshots until a terminal result", () =>
    Effect.gen(function* () {
      let observationCount = 0;
      const pending = { result: { _tag: "Pending", phase: "Queued" } } as const;
      const success = { result: { _tag: "Success", value: "loaded" } } as const;

      const observed = yield* terminalRun(
        () => {
          observationCount += 1;
          return Stream.succeed(Option.some(observationCount === 1 ? pending : success));
        },
        Duration.seconds(1),
        Duration.zero,
      );

      expect(observed).toEqual(success);
      expect(observationCount).toBe(2);
    }),
  );
});
