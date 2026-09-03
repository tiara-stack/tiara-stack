import { describe, expect, it } from "@effect/vitest";
import { canSendMessages } from "./channelPermissions";

describe("Discord channel permissions", () => {
  const workspaceId = "guild-1";
  const memberId = "bot-1";
  const roles = new Map([
    [workspaceId, { permissions: "3072" }],
    ["role-1", { permissions: "0" }],
  ]);
  const member = { roles: ["role-1"] };

  it("rejects a channel that denies SEND_MESSAGES to everyone", () => {
    expect(
      canSendMessages(
        {
          permission_overwrites: [{ id: workspaceId, type: 0, allow: "0", deny: "2048" }],
        },
        workspaceId,
        memberId,
        member,
        roles,
      ),
    ).toBe(false);
  });

  it("allows a member overwrite to restore SEND_MESSAGES", () => {
    expect(
      canSendMessages(
        {
          permission_overwrites: [
            { id: workspaceId, type: 0, allow: "0", deny: "2048" },
            { id: memberId, type: 1, allow: "2048", deny: "0" },
          ],
        },
        workspaceId,
        memberId,
        member,
        roles,
      ),
    ).toBe(true);
  });

  it("treats a missing permission context as not sendable", () => {
    expect(
      canSendMessages({ permission_overwrites: [] }, workspaceId, memberId, member, new Map()),
    ).toBe(false);
  });
});
