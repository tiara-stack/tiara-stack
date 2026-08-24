import { describe, expect, layer } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIChatInputApplicationCommandInteraction } from "dfx/types";
import { InteractionToken } from "dfx-discord-utils/utils";
import {
  ApplicationCommandType,
  ChannelType,
  InteractionType,
  Locale,
} from "discord-api-types/v10";
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { BotDependencyUnavailable, BotResponseExpired } from "sheet-bot-api/errors";
import { ResponseReference } from "sheet-bot-api/references";
import { WorkflowTransportUnavailable } from "sheet-workflow-http-client";
import type { BotCapabilityStoreShape } from "../services";
import { enqueueSheetWorkflow, type EnqueueSheetWorkflowOptions } from "./sheetWorkflowMigration";

const replacementDecision = { executionPath: "replacement" as const };
const responseReference = Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference");

const migrationTestLayer = Layer.mergeAll(
  Layer.succeed(InteractionToken, {
    applicationId: "application-1",
    token: "interaction-token",
  }),
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
);

const interaction: APIChatInputApplicationCommandInteraction = {
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "migration-test",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "migration-user",
    discriminator: "0001",
    global_name: "migration-user",
    avatar: null,
  },
  channel_id: "channel-1",
  channel: { id: "channel-1", type: ChannelType.GuildText },
  token: "interaction-token",
  version: 1,
  app_permissions: "0",
  locale: Locale.EnglishUS,
  entitlements: [],
  authorizing_integration_owners: {},
  attachment_size_limit: 8_000_000,
  guild: { id: "workspace-1", features: [], locale: Locale.EnglishUS },
};

const makeCapabilityStore = (onIssue: () => void = () => {}) =>
  ({
    issueResponseReference: () => {
      onIssue();
      return Effect.succeed(responseReference);
    },
  }) as Pick<BotCapabilityStoreShape, "issueResponseReference">;

const makeFailingCapabilityStore = (error: BotDependencyUnavailable | BotResponseExpired) =>
  ({
    issueResponseReference: () => Effect.fail(error),
  }) as Pick<BotCapabilityStoreShape, "issueResponseReference">;

const makeResponse = (messages: Array<string | undefined>) =>
  ({
    editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
      messages.push(payload.content);
      return Effect.void;
    },
  }) as Pick<CommandInteractionResponseContext, "editReply">;

type TestInput = { readonly responseReference: typeof responseReference };
type TestOptions = EnqueueSheetWorkflowOptions<TestInput, Error, unknown, never>;

const runMigration = (
  options: Omit<TestOptions, "response">,
  messages: Array<string | undefined> = [],
  response: Pick<CommandInteractionResponseContext, "editReply"> = makeResponse(messages),
) =>
  enqueueSheetWorkflow({ ...options, response }).pipe(
    Effect.provideService(Ix.Interaction, interaction),
  );

describe("sheet workflow migration runner", () => {
  layer(migrationTestLayer)("with Discord command dependencies", (it) => {
    it.effect("uses one invocation for the gate and replacement enqueue", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;
        let referencesIssued = 0;
        let gateInvocationId: unknown;
        let enqueueInvocationId: unknown;
        let enqueuedInput: TestInput | undefined;

        yield* runMigration({
          operation: "the migration test",
          contractIdentity: "test.operation",
          contractWireVersion: "1",
          workspaceId: "workspace-1",
          capabilityStore: makeCapabilityStore(() => {
            referencesIssued += 1;
          }),
          evaluateGate: (input) => {
            gateInvocationId = input.invocationId;
            return Effect.succeed(replacementDecision);
          },
          makeInput: (reference) => ({ responseReference: reference }),
          enqueue: (input, options) => {
            enqueuedInput = input;
            enqueueInvocationId = options.invocationId;
            return Effect.succeed({});
          },
          dispatchLegacy: Effect.sync(() => {
            legacyDispatches += 1;
          }),
          rejectedMessage: "rejected",
          unauthorizedMessage: "unauthorized",
          pendingMessage: "pending",
        });

        expect(enqueuedInput).toEqual({ responseReference });
        expect(enqueueInvocationId).toBeDefined();
        expect(enqueueInvocationId).toBe(gateInvocationId);
        expect(referencesIssued).toBe(1);
        expect(legacyDispatches).toBe(0);
      }),
    );

    it.effect("uses legacy once when gate evaluation is unavailable", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;
        let replacementEnqueues = 0;
        let referencesIssued = 0;

        yield* runMigration({
          operation: "the migration test",
          contractIdentity: "test.operation",
          contractWireVersion: "1",
          capabilityStore: makeCapabilityStore(() => {
            referencesIssued += 1;
          }),
          evaluateGate: () => Effect.fail(new Error("gate unavailable")),
          makeInput: (reference) => ({ responseReference: reference }),
          enqueue: () => {
            replacementEnqueues += 1;
            return Effect.succeed({});
          },
          dispatchLegacy: Effect.sync(() => {
            legacyDispatches += 1;
          }),
          rejectedMessage: "rejected",
          unauthorizedMessage: "unauthorized",
          pendingMessage: "pending",
        });

        expect(legacyDispatches).toBe(1);
        expect(replacementEnqueues).toBe(0);
        expect(referencesIssued).toBe(0);
      }),
    );

    it.effect("reports response-reference issuance failures without falling back", () =>
      Effect.gen(function* () {
        for (const error of [
          new BotDependencyUnavailable({ message: "capability store unavailable" }),
          new BotResponseExpired({ message: "response reference expired" }),
        ]) {
          let legacyDispatches = 0;
          let replacementEnqueues = 0;
          const messages: Array<string | undefined> = [];

          const exit = yield* Effect.exit(
            runMigration(
              {
                operation: "the migration test",
                contractIdentity: "test.operation",
                contractWireVersion: "1",
                capabilityStore: makeFailingCapabilityStore(error),
                evaluateGate: () => Effect.succeed(replacementDecision),
                makeInput: (reference) => ({ responseReference: reference }),
                enqueue: () => {
                  replacementEnqueues += 1;
                  return Effect.succeed({});
                },
                dispatchLegacy: Effect.sync(() => {
                  legacyDispatches += 1;
                }),
                rejectedMessage: "rejected",
                unauthorizedMessage: "unauthorized",
                pendingMessage: "pending",
              },
              messages,
            ),
          );

          expect(Exit.isSuccess(exit)).toBe(true);
          expect(messages).toEqual(["rejected"]);
          expect(replacementEnqueues).toBe(0);
          expect(legacyDispatches).toBe(0);
        }
      }),
    );

    it.effect(
      "does not surface a response-reference failure when the terminal response cannot be delivered",
      () =>
        Effect.gen(function* () {
          let legacyDispatches = 0;
          const response = {
            editReply: () => Effect.fail(new Error("interaction token expired")),
          } as Pick<CommandInteractionResponseContext, "editReply">;

          const exit = yield* Effect.exit(
            runMigration(
              {
                operation: "the migration test",
                contractIdentity: "test.operation",
                contractWireVersion: "1",
                capabilityStore: makeFailingCapabilityStore(
                  new BotDependencyUnavailable({ message: "capability store unavailable" }),
                ),
                evaluateGate: () => Effect.succeed(replacementDecision),
                makeInput: (reference) => ({ responseReference: reference }),
                enqueue: () => Effect.succeed({}),
                dispatchLegacy: Effect.sync(() => {
                  legacyDispatches += 1;
                }),
                rejectedMessage: "rejected",
                unauthorizedMessage: "unauthorized",
                pendingMessage: "pending",
              },
              [],
              response,
            ),
          );

          expect(Exit.isSuccess(exit)).toBe(true);
          expect(legacyDispatches).toBe(0);
        }),
    );

    it.effect("does not fall back after replacement enqueue is rejected", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;
        const messages: Array<string | undefined> = [];

        const exit = yield* Effect.exit(
          runMigration(
            {
              operation: "the migration test",
              contractIdentity: "test.operation",
              contractWireVersion: "1",
              capabilityStore: makeCapabilityStore(),
              evaluateGate: () => Effect.succeed(replacementDecision),
              makeInput: (reference) => ({ responseReference: reference }),
              enqueue: () =>
                Effect.fail(
                  new WorkflowTransportUnavailable({
                    operation: "Enqueue",
                    retryable: false,
                    message: "enqueue outcome was ambiguous",
                  }),
                ),
              dispatchLegacy: Effect.sync(() => {
                legacyDispatches += 1;
              }),
              rejectedMessage: "rejected",
              unauthorizedMessage: "unauthorized",
              pendingMessage: "pending",
            },
            messages,
          ),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(messages).toEqual(["pending"]);
        expect(legacyDispatches).toBe(0);
      }),
    );
  });
});
