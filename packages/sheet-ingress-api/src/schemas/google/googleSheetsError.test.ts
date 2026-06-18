import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { GoogleSheetsError } from "./googleSheetsError";

describe("GoogleSheetsError", () => {
  it("encodes string causes as JSON-safe error details", () => {
    const encoded = Schema.encodeSync(GoogleSheetsError)(
      new GoogleSheetsError({
        message: "Unable to parse range: 'Day 9'!J3:N23",
        cause: "Error: Unable to parse range: 'Day 9'!J3:N23",
      }),
    );

    expect(encoded).toEqual({
      _tag: "GoogleSheetsError",
      message: "Unable to parse range: 'Day 9'!J3:N23",
      cause: "Error: Unable to parse range: 'Day 9'!J3:N23",
    });
  });

  it("rejects raw Error causes before HTTP encoding", () => {
    expect(() =>
      Schema.encodeSync(GoogleSheetsError)(
        new GoogleSheetsError({
          message: "Unable to parse range: 'Day 9'!J3:N23",
          cause: new Error("Unable to parse range: 'Day 9'!J3:N23") as never,
        }),
      ),
    ).toThrow();
  });
});
