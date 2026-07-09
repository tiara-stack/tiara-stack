import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { teamSubmissionButtonSourceDetails } from "./teamSubmission";

describe("teamSubmissionButtonSourceDetails", () => {
  it.effect("uses the message reference without requiring referenced_message", () =>
    Effect.gen(function* () {
      const details = yield* teamSubmissionButtonSourceDetails(
        {
          id: "confirmation-message-1",
          channel_id: "confirmation-channel-1",
          message_reference: {
            message_id: "source-message-1",
            channel_id: "source-channel-1",
            guild_id: "guild-1",
          },
        },
        "fallback-guild-1",
      );

      expect(details).toEqual({
        workspaceId: "guild-1",
        conversationId: "source-channel-1",
        messageId: "source-message-1",
      });
    }),
  );
});
