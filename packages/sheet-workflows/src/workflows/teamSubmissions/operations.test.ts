import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Option, Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { type SheetBotHttpClient, messageRefFrom, type MessageRef } from "sheet-bot-api";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  MessageTeamSubmission,
  ParsedTeamEntry,
  TeamSubmissionRowMapping,
  TeamSubmissionRollbackSnapshot,
  RangesConfig,
  TeamConfig,
  TEAM_SUBMISSION_FEATURE_FLAG,
} from "./values";
import { TeamSubmissionsDecide, TeamSubmissionsProcess } from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { makeRecordingWorkflowAuthorization } from "../shared/testHelpers";
import { pendingAppendRollbackRange } from "./pure";
import {
  TeamSubmissionProvider,
  TeamSubmissionWriteError,
  type TeamSubmissionProviderShape,
} from "./provider";
import { teamSubmissionsWorkflowOperationsLayer } from "./operations";
import { TeamSubmissionsWorkflowOperations } from "./service";

const invocationId = Schema.decodeUnknownSync(InvocationId)("018f47f5-c16a-7c42-89f3-26a9088f0d31");
const client = { platform: "discord" as const, clientId: "sheet-bot" };
const sheetBotClientConfigLayer = (clientId: string) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: clientId }));
const sourceMessage = messageRefFrom(client, "workspace-1", "conversation-1", "source-message-1");
const confirmationMessage = messageRefFrom(
  client,
  "workspace-1",
  "conversation-1",
  "confirmation-message-1",
);
const servicePrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "service",
  serviceId: "sheet-bot.gateway",
  oauthClientId: "sheet-bot-client",
});
const userPrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "user",
  userId: "author-1",
  discordAccount: { accountId: "author-1" },
});

const durableEntry = Schema.decodeUnknownSync(ParsedTeamEntry)({
  stableKey: "fullFill:150%2F700",
  playerName: "Player",
  teamName: "150/700",
  teamType: "fullFill",
  notes: [],
  teamConfigName: null,
  oshi: { candidate: null, value: null, status: "notConfigured" },
});
const durableMapping = Schema.decodeUnknownSync(TeamSubmissionRowMapping)({
  stableKey: durableEntry.stableKey,
  playerNameRange: "'Teams'!A2",
  teamNameRange: "'Teams'!B2",
  oshiRange: null,
  rowIndex: 2,
});

const processInput = Schema.decodeUnknownSync(TeamSubmissionsProcess.input)({
  sourceMessage,
  authorId: "author-1",
  authorDisplayName: "Player",
  content: "full fill: 150/700",
});
const decideInput = Schema.decodeUnknownSync(TeamSubmissionsDecide.input)({
  responseReference: "response-1",
  sourceMessage,
  confirmationMessage,
  decision: "reject",
});

type MessageTeamSubmissionRow = Option.Option.Value<
  Effect.Success<
    ReturnType<TrustedSheetPersistenceShape["teamSubmissionState"]["getMessageTeamSubmission"]>
  >
>;

const makeSubmission = (options: {
  readonly status?: (typeof MessageTeamSubmission.Type)["status"];
  readonly parsedSubmission?: ReadonlyArray<typeof ParsedTeamEntry.Type>;
  readonly rowMappings?: ReadonlyArray<typeof TeamSubmissionRowMapping.Type>;
  readonly rollbackSnapshot?: ReadonlyArray<(typeof TeamSubmissionRollbackSnapshot.Type)[number]>;
}): MessageTeamSubmissionRow => ({
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "source-message-1",
  clientPlatform: "discord",
  clientId: "sheet-bot",
  discordGuildId: "workspace-1",
  discordChannelId: "conversation-1",
  discordAuthorId: "author-1",
  sheetId: "sheet-1",
  confirmationMessageId: "confirmation-message-1",
  parsedSubmission: options.parsedSubmission ?? [],
  rowMappings: options.rowMappings ?? [],
  rollbackSnapshot: options.rollbackSnapshot ?? null,
  version: 1,
  status: options.status ?? "registered",
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
});

type HarnessOptions = {
  readonly initialSubmission?: MessageTeamSubmissionRow;
  readonly provider?: Partial<TeamSubmissionProviderShape>;
  readonly readValues?: (range: string) => ReadonlyArray<ReadonlyArray<string>>;
};

const makeHarness = (options: HarnessOptions = {}) => {
  let submission = options.initialSubmission;
  const persistedStatuses: Array<MessageTeamSubmissionRow["status"]> = [];
  const deliveryOperations: Array<string> = [];
  const sheetWrites: Array<ReadonlyArray<{ readonly range: string }>> = [];
  const basePersistence = makeTrustedSheetPersistenceMock();
  const now = 0;
  const workspaceConfig = {
    workspaceId: "workspace-1",
    sheetId: "sheet-1",
    autoCheckin: null,
    monitorConversationId: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const featureFlag = {
    workspaceId: "workspace-1",
    flagName: TEAM_SUBMISSION_FEATURE_FLAG,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const channel = {
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    destinationTeamConfigName: null,
    writeMode: "upsert" as const,
    removedRowStrategy: "blank" as const,
    requireValidOshi: false,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const rangesConfig = Schema.decodeUnknownSync(RangesConfig)({
    _tag: "RangesConfig",
    userIds: "",
    userSheetNames: "",
    userNotes: null,
    monitorIds: null,
    monitorNames: null,
    oshis: null,
  });
  const teamConfig = Schema.decodeUnknownSync(TeamConfig)({
    _tag: "TeamConfig",
    name: "Teams",
    sheet: "Teams",
    playerNameRange: "'Teams'!A:A",
    teamNameRange: "'Teams'!B:B",
    isvConfig: null,
    tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
    oshiRange: null,
  });
  const upsertMessageTeamSubmission: TrustedSheetPersistenceShape["teamSubmissionState"]["upsertMessageTeamSubmission"] =
    (args) =>
      Effect.sync(() => {
        persistedStatuses.push(args.status);
        const nextVersion = (submission?.version ?? 0) + 1;
        const rollbackSnapshot =
          args.rollbackSnapshot === null || args.rollbackSnapshot === undefined
            ? null
            : Schema.decodeUnknownSync(TeamSubmissionRollbackSnapshot)(args.rollbackSnapshot);
        submission = {
          ...args,
          confirmationMessageId: args.confirmationMessageId ?? null,
          rollbackSnapshot,
          version: nextVersion,
          createdAt: typeof submission?.createdAt === "number" ? submission.createdAt : now,
          updatedAt: now,
          deletedAt: null,
        };
      });
  const persistence: TrustedSheetPersistenceShape = {
    ...basePersistence,
    workspaces: {
      ...basePersistence.workspaces,
      getWorkspaceFeatureFlags: () => Effect.succeed([featureFlag]),
      getWorkspaceConfigByWorkspaceId: () => Effect.succeed(Option.some(workspaceConfig)),
      getTeamSubmissionChannelByConversationId: () => Effect.succeed(Option.some(channel)),
    },
    teamSubmissionState: {
      ...basePersistence.teamSubmissionState,
      getMessageTeamSubmission: () => Effect.succeed(Option.fromNullishOr(submission)),
      upsertMessageTeamSubmission,
      setMessageTeamSubmissionConfirmation: ({ confirmationMessageId }) =>
        Effect.sync(() => {
          if (submission !== undefined) {
            submission = {
              ...submission,
              confirmationMessageId,
            };
          }
        }),
    },
  };
  const provider: TeamSubmissionProviderShape = {
    loadConfiguration: () => Effect.succeed({ rangesConfig, teamConfigs: [teamConfig] }),
    read: (_spreadsheetId, ranges) =>
      Effect.succeed(
        ranges.map((range) => ({
          range,
          values: options.readValues?.(range) ?? [],
        })),
      ),
    write: (_spreadsheetId, updates) =>
      Effect.sync(() => {
        sheetWrites.push(updates.map(({ range }) => ({ range })));
      }),
    append: () => Effect.succeed("'Teams'!A2:B2"),
    ...options.provider,
  };
  const progressMessage = messageRefFrom(client, "workspace-1", "conversation-1", "progress-1");
  const makeMessageReceipt = (
    deliveryKey: string,
    operation: "sendMessage" | "editMessage" | "deleteMessage" | "setMessageReaction",
    message: MessageRef,
  ) => ({
    deliveryKey,
    operation,
    target: { _tag: "Message" as const, message },
  });
  const bot = {
    delivery: {
      sendMessage: ({ payload }: { readonly payload: { readonly deliveryKey: string } }) =>
        Effect.sync(() => {
          deliveryOperations.push("sendMessage");
          return makeMessageReceipt(payload.deliveryKey, "sendMessage", progressMessage);
        }),
      editMessage: ({ payload }: { readonly payload: { readonly deliveryKey: string } }) =>
        Effect.sync(() => {
          deliveryOperations.push("editMessage");
          return makeMessageReceipt(payload.deliveryKey, "editMessage", confirmationMessage);
        }),
      deleteMessage: ({ payload }: { readonly payload: { readonly deliveryKey: string } }) =>
        Effect.sync(() => {
          deliveryOperations.push("deleteMessage");
          return makeMessageReceipt(payload.deliveryKey, "deleteMessage", confirmationMessage);
        }),
      setMessageReaction: ({ payload }: { readonly payload: { readonly deliveryKey: string } }) =>
        Effect.sync(() => {
          deliveryOperations.push("setMessageReaction");
          return makeMessageReceipt(payload.deliveryKey, "setMessageReaction", sourceMessage);
        }),
      respond: ({ payload }: { readonly payload: { readonly deliveryKey: string } }) =>
        Effect.sync(() => {
          deliveryOperations.push("respond");
          return {
            deliveryKey: payload.deliveryKey,
            operation: "respond" as const,
            target: { _tag: "Response" as const, responseReference: "response-1" },
          };
        }),
    },
  } as unknown as SheetBotHttpClient;
  const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
    ...makeRecordingWorkflowAuthorization([]),
    workspaceCapabilities: () =>
      Effect.succeed({
        member: true,
        monitor: false,
        manage: false,
        participant: false,
        appOwner: false,
      }),
  };
  const operations = TeamSubmissionsWorkflowOperations.pipe(
    Effect.provide(teamSubmissionsWorkflowOperationsLayer),
    Effect.provideService(TrustedSheetPersistence, persistence),
    Effect.provideService(TeamSubmissionProvider, provider),
    Effect.provideService(SheetBotDeliveryClient, { get: () => bot }),
    Effect.provideService(ReadOnlyWorkflowAuthorization, authorization),
    Effect.provide(sheetBotClientConfigLayer(client.clientId)),
  );
  return {
    operations,
    persistedStatuses,
    deliveryOperations,
    sheetWrites,
    submission: () => submission,
  };
};

describe("team-submission workflow operations", () => {
  it.effect(
    "processes a submission with optimistic persistence before and after the sheet write",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const operations = yield* harness.operations;
        const result = yield* operations.process({
          invocationId,
          principal: servicePrincipal,
          input: processInput,
        });

        expect(result.status).toBe("registered");
        expect(result.parsedTeamCount).toBe(1);
        expect(harness.persistedStatuses).toEqual([
          "applying",
          "applying",
          "applying",
          "registered",
        ]);
        expect(harness.submission()?.version).toBe(4);
        expect(harness.deliveryOperations).toEqual([
          "sendMessage",
          "setMessageReaction",
          "editMessage",
          "editMessage",
        ]);
      }),
  );

  it.effect("reuses an existing durable mapping instead of appending a duplicate", () =>
    Effect.gen(function* () {
      let appends = 0;
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          parsedSubmission: [durableEntry],
          rowMappings: [durableMapping],
        }),
        readValues: () => [["different", "different"]],
        provider: {
          append: () => Effect.sync(() => (appends += 1)).pipe(Effect.as("'Teams'!A2:B2")),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.parsedTeamCount).toBe(1);
      expect(appends).toBe(0);
      expect(harness.persistedStatuses).toEqual(["applying", "updated"]);
    }),
  );

  it.effect("retains an applying recovery record when an append fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        provider: {
          append: () =>
            Effect.fail(
              new TeamSubmissionWriteError({
                operation: "append",
                ambiguous: false,
                cause: "append unavailable",
              }),
            ),
        },
      });
      const operations = yield* harness.operations;
      const exit = yield* Effect.exit(
        operations.process({
          invocationId,
          principal: servicePrincipal,
          input: processInput,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(harness.submission()).toMatchObject({
        status: "applying",
        rowMappings: [{ rowIndex: 0 }],
        rollbackSnapshot: [{ range: pendingAppendRollbackRange, values: [] }],
      });
    }),
  );

  it.effect("confirms and replays a decision without persisting a second transition", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        initialSubmission: makeSubmission({ status: "registered" }),
      });
      const operations = yield* harness.operations;
      const execution = {
        invocationId,
        principal: userPrincipal,
        input: { ...decideInput, decision: "confirm" as const },
      };

      const first = yield* operations.decide(execution);
      const replay = yield* operations.decide(execution);

      expect(first.status).toBe("confirmed");
      expect(replay.status).toBe("confirmed");
      expect(harness.persistedStatuses).toEqual(["confirmed"]);
      expect(
        harness.deliveryOperations.filter((operation) => operation === "deleteMessage"),
      ).toHaveLength(2);
    }),
  );

  it.effect("moves rejection through reverting, rollbackFailed, and rejected states", () =>
    Effect.gen(function* () {
      const snapshot = Schema.decodeUnknownSync(TeamSubmissionRollbackSnapshot)([
        { stableKey: durableEntry.stableKey, range: "'Teams'!A2", values: [["old"]] },
      ]);
      const failing = makeHarness({
        initialSubmission: makeSubmission({
          status: "applying",
          parsedSubmission: [durableEntry],
          rowMappings: [durableMapping],
          rollbackSnapshot: snapshot,
        }),
        provider: {
          write: () =>
            Effect.fail(
              new TeamSubmissionWriteError({
                operation: "write",
                ambiguous: false,
                cause: "sheet unavailable",
              }),
            ),
        },
      });
      const failingOperations = yield* failing.operations;
      const failed = yield* failingOperations.decide({
        invocationId,
        principal: userPrincipal,
        input: decideInput,
      });
      expect(failed.status).toBe("rollbackFailed");
      expect(failing.persistedStatuses).toEqual(["reverting", "rollbackFailed"]);

      const noSnapshot = makeHarness({
        initialSubmission: makeSubmission({
          status: "applying",
          parsedSubmission: [durableEntry],
          rowMappings: [durableMapping],
        }),
      });
      const noSnapshotOperations = yield* noSnapshot.operations;
      const noSnapshotResult = yield* noSnapshotOperations.decide({
        invocationId,
        principal: userPrincipal,
        input: decideInput,
      });
      expect(noSnapshotResult.status).toBe("rollbackFailed");
      expect(noSnapshot.persistedStatuses).toEqual(["rollbackFailed"]);
      expect(noSnapshot.submission()?.rollbackSnapshot).toBeNull();

      const emptyWithSnapshot = makeHarness({
        initialSubmission: makeSubmission({
          status: "empty",
          rollbackSnapshot: snapshot,
        }),
      });
      const emptyWithSnapshotOperations = yield* emptyWithSnapshot.operations;
      const emptyWithSnapshotResult = yield* emptyWithSnapshotOperations.decide({
        invocationId,
        principal: userPrincipal,
        input: decideInput,
      });
      expect(emptyWithSnapshotResult.status).toBe("rejected");
      expect(emptyWithSnapshot.persistedStatuses).toEqual(["reverting", "rejected"]);

      const succeeding = makeHarness({
        initialSubmission: makeSubmission({
          parsedSubmission: [durableEntry],
          rowMappings: [durableMapping],
          rollbackSnapshot: snapshot,
        }),
      });
      const succeedingOperations = yield* succeeding.operations;
      const rejected = yield* succeedingOperations.decide({
        invocationId,
        principal: userPrincipal,
        input: decideInput,
      });
      expect(rejected.status).toBe("rejected");
      expect(succeeding.persistedStatuses).toEqual(["reverting", "rejected"]);
    }),
  );
});
