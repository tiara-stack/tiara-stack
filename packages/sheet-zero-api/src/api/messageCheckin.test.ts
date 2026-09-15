import { describe, expect, it } from "@effect/vitest";
import { defaultSuccessSchemas } from "./successSchemas";
import { makeMessageCheckinGroup } from "./messageCheckin";

const messageCheckinGroup = makeMessageCheckinGroup(defaultSuccessSchemas);
const persistMessageCheckin = messageCheckinGroup.endpoints.persistMessageCheckin;
if (
  persistMessageCheckin?.kind !== "mutator" ||
  persistMessageCheckin.name !== "persistMessageCheckin"
) {
  throw new Error("Expected the persistMessageCheckin mutator endpoint");
}
const removeMessageCheckin = messageCheckinGroup.endpoints.removeMessageCheckin;
if (
  removeMessageCheckin?.kind !== "mutator" ||
  removeMessageCheckin.name !== "removeMessageCheckin"
) {
  throw new Error("Expected the removeMessageCheckin mutator endpoint");
}

const input = {
  clientPlatform: "discord",
  clientId: "discord-main",
  messageId: "message-1",
  data: {
    initialMessage: [{ type: "text" as const, text: "check in" }],
    hour: 195,
    runningConversationId: "running-1",
    roleId: null,
    workspaceId: "workspace-1",
    conversationId: "checkin-1",
    createdByUserId: null,
  },
  memberIds: ["member-1", "member-2", "member-3"],
} satisfies typeof persistMessageCheckin.request.Type;

const key = {
  clientPlatform: input.clientPlatform,
  clientId: input.clientId,
  messageId: input.messageId,
} satisfies typeof removeMessageCheckin.request.Type;

const makeExclusiveTransaction = (runResult?: unknown) => {
  let active = false;
  const operation = async () => {
    if (active) throw new Error("transaction operations overlapped");
    active = true;
    await Promise.resolve();
    active = false;
  };

  return {
    run: async () => {
      await operation();
      return runResult;
    },
    mutate: {
      messageCheckin: { upsert: operation, update: operation },
      messageCheckinMember: { upsert: operation, update: operation },
    },
  } as unknown as Parameters<typeof persistMessageCheckin.mutator>[0]["tx"];
};

describe("message check-in mutators", () => {
  it("does not overlap operations on one transaction while persisting members", async () => {
    await expect(
      persistMessageCheckin.mutator({
        args: input,
        ctx: undefined,
        tx: makeExclusiveTransaction(),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not overlap operations on one transaction while removing members", async () => {
    await expect(
      removeMessageCheckin.mutator({
        args: key,
        ctx: undefined,
        tx: makeExclusiveTransaction([
          {
            clientPlatform: key.clientPlatform,
            clientId: key.clientId,
            messageId: key.messageId,
            memberId: "member-1",
          },
        ]),
      }),
    ).resolves.toBeUndefined();
  });
});
