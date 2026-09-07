import { describe, expect, it } from "vitest";
import { SubCommandBuilder } from "dfx-discord-utils/utils";
import { Predicate } from "effect";
import { makeSavedMessageSubCommandData } from "./checkinSavedMessage";

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
});
