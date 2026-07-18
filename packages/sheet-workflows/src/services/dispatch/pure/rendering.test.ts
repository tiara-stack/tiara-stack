import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { formatConversationConfigFields } from "sheet-message-content/rendering";

const runningFieldValue = (running: Option.Option<boolean>) =>
  formatConversationConfigFields({
    client: { platform: "discord", clientId: "discord-main" },
    workspaceId: "workspace-1",
    name: Option.none(),
    running,
    roleId: Option.none(),
    checkinConversationId: Option.none(),
  })[1]?.value;

describe("formatConversationConfigFields", () => {
  it("distinguishes unset, disabled, and enabled run destinations", () => {
    expect([
      runningFieldValue(Option.none()),
      runningFieldValue(Option.some(false)),
      runningFieldValue(Option.some(true)),
    ]).toEqual(["None!", "No", "Yes"]);
  });
});
