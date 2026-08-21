import { describe, expect, it } from "@effect/vitest";
import { Ix } from "dfx";
import { InteractionToken } from "dfx-discord-utils/utils";
import { ConfigProvider, Effect, Schema } from "effect";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { ResponseReference } from "sheet-bot-api/references";
import {
  BotCapabilityStore,
  SheetWorkflowHttpClient,
  type ServicesDeliverStatusEnqueue,
} from "../services";
import { enqueueStatus, makeStatusResponseReferenceInput } from "./status";

describe("status command workflow input", () => {
  it("keeps the provider token in the bot-owned capability record", () => {
    const input = makeStatusResponseReferenceInput({
      applicationId: "application-1",
      clientId: "client-1",
      interactionId: "123456789012345678",
      interactionToken: "provider-token",
    });

    expect(input).toEqual({
      applicationId: "application-1",
      client: { platform: "discord", clientId: "client-1" },
      interactionToken: "provider-token",
      permittedOperations: ["respond"],
      expiresAt: 1449505662216,
    });
  });
});

describe("status command workflow enqueue", () => {
  it.effect("explains that the service status check is owner-only", () =>
    Effect.gen(function* () {
      const responseReference = Schema.decodeUnknownSync(ResponseReference)(
        "opaque-response-reference",
      );
      const capabilityStore = {
        issueResponseReference: () => Effect.succeed(responseReference),
      } as Pick<typeof BotCapabilityStore.Service, "issueResponseReference">;
      const workflowClient = {
        enqueueServicesDeliverStatus: () =>
          Effect.fail({
            _tag: "WorkflowInvocationUnauthorized" as const,
            message: "Workflow invocation is unauthorized",
          }),
      } as unknown as Pick<typeof SheetWorkflowHttpClient.Service, "enqueueServicesDeliverStatus">;
      const messages: Array<string | undefined> = [];
      const response = {
        editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
          messages.push(payload.content);
          return Effect.void;
        },
      } as Pick<CommandInteractionResponseContext, "editReply">;

      yield* enqueueStatus(response, workflowClient, capabilityStore).pipe(
        Effect.provideService(InteractionToken, {
          applicationId: "application-1",
          token: "interaction-token",
        }),
        Effect.provideService(Ix.Interaction, {
          id: "123456789012345678",
          application_id: "application-1",
          token: "interaction-token",
          user: { id: "discord-user-1" },
        } as never),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
        ),
      );

      expect(messages).toEqual(["Only the application owner can start the service status check."]);
    }),
  );

  it.effect("uses the capability store captured by the command layer", () =>
    Effect.gen(function* () {
      const responseReference = Schema.decodeUnknownSync(ResponseReference)(
        "opaque-response-reference",
      );
      const capabilityStore = {
        issueResponseReference: () => Effect.succeed(responseReference),
      } as Pick<typeof BotCapabilityStore.Service, "issueResponseReference">;
      const workflowClient = {
        enqueueServicesDeliverStatus: ((_, options) => {
          if (options?.invocationId === undefined) return Effect.die("invocation ID is required");
          return Effect.succeed({
            invocationId: options.invocationId,
            contractIdentity: "services.deliverStatus" as const,
            wireVersion: "1" as const,
          });
        }) satisfies ServicesDeliverStatusEnqueue,
      } as Pick<typeof SheetWorkflowHttpClient.Service, "enqueueServicesDeliverStatus">;
      const response = {
        editReply: () => Effect.void,
      } as Pick<CommandInteractionResponseContext, "editReply">;

      yield* enqueueStatus(response, workflowClient, capabilityStore).pipe(
        Effect.provideService(InteractionToken, {
          applicationId: "application-1",
          token: "interaction-token",
        }),
        Effect.provideService(Ix.Interaction, {
          id: "123456789012345678",
          application_id: "application-1",
          token: "interaction-token",
          user: { id: "discord-user-1" },
        } as never),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
        ),
      );
    }),
  );
});
