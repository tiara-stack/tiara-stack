import { describe, expect, it } from "vitest";
import { isSheetEditorPath } from "./routes";

describe("isSheetEditorPath", () => {
  it.each([
    "/dashboard/guilds/guild-1/settings/sheet",
    "/dashboard/guilds/guild-1/settings/sheet/",
    "/dashboard/guilds/guild-1/settings/checkin-messages",
    "/dashboard/guilds/guild-1/settings/checkin-messages/",
  ])("recognizes %s as an editor path", (pathname) => {
    expect(isSheetEditorPath(pathname)).toBe(true);
  });

  it.each([
    "/dashboard/guilds/guild-1/settings",
    "/dashboard/guilds/guild-1/settings/server",
    "/dashboard/guilds/guild-1/settings/channels",
  ])("does not compact %s", (pathname) => {
    expect(isSheetEditorPath(pathname)).toBe(false);
  });
});
