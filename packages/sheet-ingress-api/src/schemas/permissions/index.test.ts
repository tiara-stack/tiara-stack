import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Permission } from "./index";

describe("Permission", () => {
  it("decodes base and server-derived permission values", () => {
    expect(Schema.decodeUnknownSync(Permission)("service")).toBe("service");
    expect(Schema.decodeUnknownSync(Permission)("account:discord:discord-user-1")).toBe(
      "account:discord:discord-user-1",
    );
    expect(Schema.decodeUnknownSync(Permission)("monitor_guild:guild-1")).toBe(
      "monitor_guild:guild-1",
    );
  });
});
