import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ResponseReference } from "sheet-bot-api/references";
import {
  makeTeamSubmissionDecideInput,
  makeTeamSubmissionResponseReferenceInput,
  teamSubmissionButtonSourceDetails,
} from "./teamSubmission";

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

describe("team submission decision workflow input", () => {
  it("maps the source and confirmation messages and keeps the interaction token opaque", () => {
    const responseReference = Schema.decodeUnknownSync(ResponseReference)(
      "opaque-response-reference",
    );
    const input = makeTeamSubmissionDecideInput({
      clientId: "discord-main",
      source: {
        workspaceId: "guild-1",
        conversationId: "source-channel-1",
        messageId: "source-message-1",
      },
      confirmation: {
        workspaceId: "guild-1",
        conversationId: "confirmation-channel-1",
        messageId: "confirmation-message-1",
      },
      decision: "confirm",
      responseReference,
    });

    expect(input).toEqual({
      responseReference,
      sourceMessage: {
        conversation: {
          workspace: {
            client: { platform: "discord", clientId: "discord-main" },
            workspaceId: "guild-1",
          },
          conversationId: "source-channel-1",
        },
        messageId: "source-message-1",
      },
      confirmationMessage: {
        conversation: {
          workspace: {
            client: { platform: "discord", clientId: "discord-main" },
            workspaceId: "guild-1",
          },
          conversationId: "confirmation-channel-1",
        },
        messageId: "confirmation-message-1",
      },
      decision: "confirm",
    });
    expect(JSON.stringify(input)).not.toContain("interaction-secret");
  });

  it("issues a Discord response capability scoped to one workspace", () => {
    const input = makeTeamSubmissionResponseReferenceInput({
      applicationId: "application-1",
      clientId: "discord-main",
      interactionId: "175928847299117063",
      interactionToken: "interaction-secret",
      workspaceId: "guild-1",
    });

    expect(input).toMatchObject({
      applicationId: "application-1",
      client: { platform: "discord", clientId: "discord-main" },
      interactionToken: "interaction-secret",
      permittedOperations: ["respond"],
      workspaceId: "guild-1",
    });
    expect(input.expiresAt).toBeGreaterThan(0);
  });
});
