import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WorkspaceConversationLockdownResult } from "./workspaceConversationLockdownResult";

describe("WorkspaceConversationLockdownResult", () => {
  it("round trips workspace and conversation identifiers", () => {
    const result = {
      workspaceId: "guild-1",
      conversationId: "channel-1",
    };
    expect(
      Schema.encodeSync(WorkspaceConversationLockdownResult)(
        Schema.decodeUnknownSync(WorkspaceConversationLockdownResult)(result),
      ),
    ).toEqual(result);
  });
});
