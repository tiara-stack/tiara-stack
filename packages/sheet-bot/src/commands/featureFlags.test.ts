import { describe, expect, it } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIInteraction } from "dfx/types";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { Effect, Schema } from "effect";
import {
  WorkflowTransportUnavailable,
  workflowInvocationIdFromString,
} from "sheet-workflow-http-client";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import type { SheetWorkflowHttpClientShape } from "../services";
import { enqueueFeatureFlag } from "./featureFlags";

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const invocationId = workflowInvocationIdFromString("123e4567-e89b-42d3-a456-426614174000");

const makeResponse = (messages: Array<string | undefined>) =>
  ({
    editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
      messages.push(payload.content);
      return Effect.void;
    },
  }) as Pick<CommandInteractionResponseContext, "editReply">;

const interaction = (userId: string): APIInteraction =>
  ({ user: { id: userId } }) as APIInteraction;

describe("feature flag command protected enqueue path", () => {
  it.effect("uses the protected client and preserves local queue reporting", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      const calls: Array<{
        readonly input: unknown;
        readonly clientSuppliedInvocationId: unknown;
      }> = [];
      const workflowClient: Pick<
        SheetWorkflowHttpClientShape,
        "enqueueWorkspacesFeatureFlagsSetAndDeliver"
      > = {
        enqueueWorkspacesFeatureFlagsSetAndDeliver: (input, options) => {
          calls.push({ input, clientSuppliedInvocationId: options?.invocationId });
          return Effect.succeed({
            invocationId,
            contractIdentity: "workspaces.featureFlags.setAndDeliver",
            wireVersion: "1",
          });
        },
      };

      yield* enqueueFeatureFlag(makeResponse(messages), workflowClient, {
        workspaceId,
        flagName: "team-submission-confirmations",
        enabled: true,
      }).pipe(Effect.provideService(Ix.Interaction, interaction("discord-user-1")));

      expect(calls).toEqual([
        {
          input: {
            workspaceId,
            flagName: "team-submission-confirmations",
            enabled: true,
          },
          clientSuppliedInvocationId: undefined,
        },
      ]);
      expect(messages).toEqual([
        "Feature flag enable request queued. TiaraBot will announce the change in the target server when a sendable channel is available.",
      ]);
    }),
  );

  it.effect("keeps an ambiguous protected enqueue outcome pending", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      const workflowClient: Pick<
        SheetWorkflowHttpClientShape,
        "enqueueWorkspacesFeatureFlagsSetAndDeliver"
      > = {
        enqueueWorkspacesFeatureFlagsSetAndDeliver: () =>
          Effect.fail(
            new WorkflowTransportUnavailable({
              operation: "Enqueue",
              retryable: true,
              message: "the enqueue outcome is ambiguous",
            }),
          ),
      };

      yield* enqueueFeatureFlag(makeResponse(messages), workflowClient, {
        workspaceId,
        flagName: "team-submission-confirmations",
        enabled: false,
      }).pipe(Effect.provideService(Ix.Interaction, interaction("discord-user-1")));

      expect(messages).toEqual([
        "The feature-flag update is still processing. I'll update the target server when it finishes.",
      ]);
    }),
  );
});
