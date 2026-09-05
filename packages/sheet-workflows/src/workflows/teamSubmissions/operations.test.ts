import { expect, layer } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Option, Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { type SheetBotHttpClient, messageRefFrom, type MessageRef } from "sheet-bot-api";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  MessageTeamSubmission,
  ParsedTeamEntry,
  type TeamSubmissionConfigurationBinding,
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
  TeamSubmissionProviderError,
  TeamSubmissionWriteError,
  type TeamSubmissionProviderShape,
} from "./provider";
import { teamSubmissionsWorkflowOperationsLayer } from "./operations";
import { TeamSubmissionsWorkflowOperations } from "./service";

const invocationId = Schema.decodeUnknownSync(InvocationId)("018f47f5-c16a-7c42-89f3-26a9088f0d31");
const client = { platform: "discord" as const, clientId: "sheet-bot" };
const sheetBotClientConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: client.clientId }),
);
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
const overwrittenEntry = Schema.decodeUnknownSync(ParsedTeamEntry)({
  stableKey: "fullFill:150%2F701",
  playerName: "Other",
  teamName: "150/701",
  teamType: "fullFill",
  notes: [],
  teamConfigName: null,
  oshi: { candidate: null, value: null, status: "notConfigured" },
});
const overwrittenMapping = Schema.decodeUnknownSync(TeamSubmissionRowMapping)({
  stableKey: overwrittenEntry.stableKey,
  playerNameRange: "'Teams'!A3",
  teamNameRange: "'Teams'!B3",
  oshiRange: null,
  rowIndex: 3,
});
const pendingMapping = Schema.decodeUnknownSync(TeamSubmissionRowMapping)({
  stableKey: durableEntry.stableKey,
  playerNameRange: "'Teams'!A:A",
  teamNameRange: "'Teams'!B:B",
  oshiRange: null,
  rowIndex: 0,
});
const rangesConfig = Schema.decodeUnknownSync(RangesConfig)({
  _tag: "RangesConfig",
  userIds: "",
  userSheetNames: "",
  userNotes: null,
  monitorIds: null,
  monitorNames: null,
  oshis: null,
});
const makeTeamConfig = (
  name: string,
  teamNameRange: string | null,
  tags: ReadonlyArray<string> = ["full fill"],
) =>
  Schema.decodeUnknownSync(TeamConfig)({
    _tag: "TeamConfig",
    name,
    sheet: "Teams",
    playerNameRange: "'Teams'!A:A",
    teamNameRange,
    isvConfig: null,
    tagsConfig: { _tag: "TeamTagsConstantsConfig", tags },
    oshiRange: null,
  });

const makeAutoTeamConfig = (oshiRange: string | null = null) =>
  Schema.decodeUnknownSync(TeamConfig)({
    _tag: "TeamConfig",
    name: "Auto",
    sheet: "Teams",
    playerNameRange: "'Teams'!A:A",
    teamNameRange: "auto",
    isvConfig: { _tag: "TeamIsvCombinedConfig", isvRange: "'Teams'!D:D" },
    tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
    oshiRange,
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
  readonly sheetConfigurationBinding?: TeamSubmissionConfigurationBinding | null;
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
  sheetConfigurationBinding:
    options.sheetConfigurationBinding === undefined
      ? { revisionId: null, configuration: null }
      : options.sheetConfigurationBinding,
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
  readonly appendResult?: string;
  readonly initialSubmission?: MessageTeamSubmissionRow;
  readonly provider?: Partial<TeamSubmissionProviderShape>;
  readonly readValues?: (range: string) => ReadonlyArray<ReadonlyArray<string>>;
};

const makeHarness = (options: HarnessOptions = {}) => {
  let submission = options.initialSubmission;
  const persistedStatuses: Array<MessageTeamSubmissionRow["status"]> = [];
  const deliveryOperations: Array<string> = [];
  const deliveryMessages: Array<unknown> = [];
  const sheetWrites: Array<
    ReadonlyArray<{
      readonly range: string;
      readonly values: ReadonlyArray<ReadonlyArray<string>>;
    }>
  > = [];
  const sheetAppends: Array<{ readonly range: string }> = [];
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
          sheetConfigurationBinding:
            args.sheetConfigurationBinding === undefined
              ? (submission?.sheetConfigurationBinding ?? null)
              : args.sheetConfigurationBinding,
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
        sheetWrites.push(updates.map(({ range, values }) => ({ range, values })));
      }),
    append: (_spreadsheetId, range) =>
      Effect.sync(() => {
        sheetAppends.push({ range });
        return options.appendResult ?? "'Teams'!A2:B2";
      }),
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
      editMessage: ({
        payload,
      }: {
        readonly payload: { readonly deliveryKey: string; readonly content?: unknown };
      }) =>
        Effect.sync(() => {
          deliveryOperations.push("editMessage");
          deliveryMessages.push(payload.content);
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
  );
  return {
    operations,
    persistedStatuses,
    deliveryOperations,
    deliveryMessages,
    sheetWrites,
    sheetAppends,
    submission: () => submission,
  };
};

const rejectStagedSubmission = (initialSubmission?: MessageTeamSubmissionRow) =>
  Effect.gen(function* () {
    const harness = makeHarness(initialSubmission === undefined ? {} : { initialSubmission });
    const operations = yield* harness.operations;
    yield* operations.process({
      invocationId,
      principal: servicePrincipal,
      input: processInput,
    });
    const rejected = yield* operations.decide({
      invocationId,
      principal: userPrincipal,
      input: { ...decideInput, decision: "reject" as const },
    });

    expect(rejected.status).toBe("rejected");
    expect(harness.persistedStatuses).toEqual(["pending", "rejected"]);
    expect(harness.sheetWrites).toEqual([]);
    expect(harness.sheetAppends).toEqual([]);
    return harness;
  });

layer(sheetBotClientConfigLayer)("team-submission workflow operations", (it) => {
  it.effect("stages a submission without writing to the sheet", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.status).toBe("pending");
      expect(result.parsedTeamCount).toBe(1);
      expect(harness.persistedStatuses).toEqual(["pending"]);
      expect(harness.submission()?.version).toBe(1);
      expect(harness.sheetWrites).toEqual([]);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.deliveryOperations).toEqual([
        "sendMessage",
        "setMessageReaction",
        "editMessage",
        "editMessage",
      ]);
    }),
  );

  it.effect("writes roster values for an auto config", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.succeed({
              rangesConfig,
              teamConfigs: [
                makeTeamConfig("Missing", null, ["full fill", "150/700"]),
                makeAutoTeamConfig(),
                makeTeamConfig("Explicit", "'Teams'!B:B"),
              ],
            }),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.parsedTeamCount).toBe(1);
      expect(result.skippedTeamCount).toBe(0);
      expect(harness.submission()).toMatchObject({
        parsedSubmission: [{ teamConfigName: "Auto" }],
      });

      const confirmed = yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: { ...decideInput, decision: "confirm" as const },
      });

      expect(confirmed.status).toBe("confirmed");
      expect(harness.sheetWrites).toEqual([
        [
          { range: "'Teams'!A2", values: [["Player"]] },
          { range: "'Teams'!D2", values: [["150/700"]] },
        ],
      ]);
      expect(harness.submission()).toMatchObject({
        rowMappings: [{ rowIndex: 2, isvRanges: ["'Teams'!D2"] }],
      });
    }),
  );

  it.effect("canonicalizes ISV ranges when upgrading an existing row mapping", () =>
    Effect.gen(function* () {
      const legacyRowMapping = Schema.decodeUnknownSync(TeamSubmissionRowMapping)({
        stableKey: durableEntry.stableKey,
        playerNameRange: "'Teams'!A68",
        teamNameRange: null,
        oshiRange: null,
        rowIndex: 68,
      });
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "pending",
          parsedSubmission: [durableEntry],
          rowMappings: [legacyRowMapping],
        }),
        provider: {
          loadConfiguration: () =>
            Effect.succeed({ rangesConfig, teamConfigs: [makeAutoTeamConfig()] }),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.parsedTeamCount).toBe(1);
      expect(harness.submission()).toMatchObject({
        status: "pending",
        rowMappings: [{ rowIndex: 68, isvRanges: ["'Teams'!D68"] }],
      });
    }),
  );

  it.effect("clears an omitted talent value for split roster mappings", () =>
    Effect.gen(function* () {
      const splitTeamConfig = Schema.decodeUnknownSync(TeamConfig)({
        _tag: "TeamConfig",
        name: "Auto",
        sheet: "Teams",
        playerNameRange: "'Teams'!A:A",
        teamNameRange: "auto",
        isvConfig: {
          _tag: "TeamIsvSplitConfig",
          leadRange: "'Teams'!D:D",
          backlineRange: "'Teams'!E:E",
          talentRange: "'Teams'!F:F",
        },
        tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
        oshiRange: null,
      });
      const harness = makeHarness({
        provider: {
          loadConfiguration: () => Effect.succeed({ rangesConfig, teamConfigs: [splitTeamConfig] }),
        },
      });
      const operations = yield* harness.operations;
      yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: { ...decideInput, decision: "confirm" as const },
      });

      expect(harness.sheetWrites).toEqual([
        [
          { range: "'Teams'!A2", values: [["Player"]] },
          { range: "'Teams'!D2", values: [["150"]] },
          { range: "'Teams'!E2", values: [["700"]] },
          { range: "'Teams'!F2", values: [[""]] },
        ],
      ]);
    }),
  );

  it.effect("writes configured split roster ranges when extra values are submitted", () =>
    Effect.gen(function* () {
      const splitTeamConfig = Schema.decodeUnknownSync(TeamConfig)({
        _tag: "TeamConfig",
        name: "Auto",
        sheet: "Teams",
        playerNameRange: "'Teams'!A:A",
        teamNameRange: "auto",
        isvConfig: {
          _tag: "TeamIsvSplitConfig",
          leadRange: "'Teams'!D:D",
          backlineRange: "'Teams'!E:E",
          talentRange: "'Teams'!F:F",
        },
        tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
        oshiRange: null,
      });
      const harness = makeHarness({
        provider: {
          loadConfiguration: () => Effect.succeed({ rangesConfig, teamConfigs: [splitTeamConfig] }),
        },
      });
      const operations = yield* harness.operations;
      yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: { ...processInput, content: "full fill: 150/700/324/999" },
      });

      yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: { ...decideInput, decision: "confirm" as const },
      });

      expect(harness.sheetWrites).toEqual([
        [
          { range: "'Teams'!A2", values: [["Player"]] },
          { range: "'Teams'!D2", values: [["150"]] },
          { range: "'Teams'!E2", values: [["700"]] },
          { range: "'Teams'!F2", values: [["324"]] },
        ],
      ]);
    }),
  );

  it.effect("skips duplicate split roster ranges before planning a write", () =>
    Effect.gen(function* () {
      const duplicateSplitTeamConfig = Schema.decodeUnknownSync(TeamConfig)({
        _tag: "TeamConfig",
        name: "Auto",
        sheet: "Teams",
        playerNameRange: "'Teams'!A:A",
        teamNameRange: "auto",
        isvConfig: {
          _tag: "TeamIsvSplitConfig",
          leadRange: "'Teams'!D:D",
          backlineRange: "'Teams'!D:D",
          talentRange: "'Teams'!D:D",
        },
        tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
        oshiRange: null,
      });
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.succeed({ rangesConfig, teamConfigs: [duplicateSplitTeamConfig] }),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.parsedTeamCount).toBe(0);
      expect(result.skippedTeamCount).toBe(1);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.sheetWrites).toEqual([]);
    }),
  );

  it.effect("skips cross-field roster range collisions before planning a write", () =>
    Effect.gen(function* () {
      const collidingTeamConfig = Schema.decodeUnknownSync(TeamConfig)({
        _tag: "TeamConfig",
        name: "Auto",
        sheet: "Teams",
        playerNameRange: "Teams!d:d",
        teamNameRange: "auto",
        isvConfig: {
          _tag: "TeamIsvSplitConfig",
          leadRange: "'Teams'!D:D",
          backlineRange: "'Teams'!E:E",
          talentRange: "'Teams'!F:F",
        },
        tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
        oshiRange: null,
      });
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.succeed({ rangesConfig, teamConfigs: [collidingTeamConfig] }),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.parsedTeamCount).toBe(0);
      expect(result.skippedTeamCount).toBe(1);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.sheetWrites).toEqual([]);
    }),
  );

  it.effect("accepts equivalent formatted roster mappings in pending plans", () =>
    Effect.gen(function* () {
      const equivalentMapping = Schema.decodeUnknownSync(TeamSubmissionRowMapping)({
        stableKey: durableEntry.stableKey,
        playerNameRange: "'Teams'!A68",
        teamNameRange: null,
        isvRanges: ["Teams!d68"],
        oshiRange: "'Teams'!B68",
        rowIndex: 68,
      });
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "pending",
          parsedSubmission: [durableEntry],
          rowMappings: [equivalentMapping],
        }),
        provider: {
          loadConfiguration: () =>
            Effect.succeed({
              rangesConfig,
              teamConfigs: [makeAutoTeamConfig("'Teams'!B:B")],
            }),
        },
      });
      const operations = yield* harness.operations;
      const confirmed = yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: { ...decideInput, decision: "confirm" as const },
      });

      expect(confirmed.status).toBe("confirmed");
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.sheetWrites).toEqual([
        [
          { range: "'Teams'!A68", values: [["Player"]] },
          { range: "Teams!d68", values: [["150/700"]] },
          { range: "'Teams'!B68", values: [[""]] },
        ],
      ]);
    }),
  );

  it.effect("rejects legacy pending mappings when ISV ranges are configured", () =>
    Effect.gen(function* () {
      const legacyMapping = Schema.decodeUnknownSync(TeamSubmissionRowMapping)({
        stableKey: durableEntry.stableKey,
        playerNameRange: "'Teams'!A:A",
        teamNameRange: null,
        oshiRange: null,
        rowIndex: 0,
      });
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "pending",
          parsedSubmission: [durableEntry],
          rowMappings: [legacyMapping],
        }),
        provider: {
          loadConfiguration: () =>
            Effect.succeed({ rangesConfig, teamConfigs: [makeAutoTeamConfig()] }),
        },
      });
      const operations = yield* harness.operations;
      const failed = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        expect(Option.getOrThrow(Cause.findErrorOption(failed.cause))).toMatchObject({
          _tag: "BusinessRuleRejected",
          code: "PendingPlanInvalid",
        });
      }
      expect(harness.submission()?.status).toBe("pending");
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.sheetWrites).toEqual([]);
    }),
  );

  it.effect("rejects role-swapped pending mappings", () =>
    Effect.gen(function* () {
      const swappedMapping = Schema.decodeUnknownSync(TeamSubmissionRowMapping)({
        stableKey: durableEntry.stableKey,
        playerNameRange: "'Teams'!B68",
        teamNameRange: null,
        isvRanges: ["'Teams'!D68"],
        oshiRange: "'Teams'!A68",
        rowIndex: 68,
      });
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "pending",
          parsedSubmission: [durableEntry],
          rowMappings: [swappedMapping],
        }),
        provider: {
          loadConfiguration: () =>
            Effect.succeed({
              rangesConfig,
              teamConfigs: [makeAutoTeamConfig("'Teams'!B:B")],
            }),
        },
      });
      const operations = yield* harness.operations;
      const failed = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        expect(Option.getOrThrow(Cause.findErrorOption(failed.cause))).toMatchObject({
          _tag: "BusinessRuleRejected",
          code: "PendingPlanInvalid",
        });
      }
      expect(harness.submission()?.status).toBe("pending");
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.sheetWrites).toEqual([]);
    }),
  );

  it.effect("bounds an auto append by populated player rows", () =>
    Effect.gen(function* () {
      const existingPlayerRows = Array.from({ length: 67 }, () => ["existing"]);
      const harness = makeHarness({
        readValues: (range) => (range === "'Teams'!A:A" ? existingPlayerRows : []),
        appendResult: "'Teams'!A68",
        provider: {
          loadConfiguration: () =>
            Effect.succeed({
              rangesConfig,
              teamConfigs: [makeAutoTeamConfig("'Teams'!B:B")],
            }),
        },
      });
      const operations = yield* harness.operations;
      yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: { ...decideInput, decision: "confirm" as const },
      });

      expect(harness.sheetAppends).toEqual([{ range: "'Teams'!A1:A67" }]);
      expect(harness.sheetWrites).toEqual([
        [
          { range: "'Teams'!A68", values: [["Player"]] },
          { range: "'Teams'!D68", values: [["150/700"]] },
          { range: "'Teams'!B68", values: [[""]] },
        ],
      ]);
    }),
  );

  it.effect("matches untagged full-fill and encore configs by their semantic names", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.succeed({
              rangesConfig,
              teamConfigs: [
                makeTeamConfig("Full Fill", "auto", []),
                makeTeamConfig("Heal", "auto", ["heal"]),
                makeTeamConfig("Encore", "auto", []),
                makeTeamConfig("Runner", "auto", ["tierer_hint"]),
              ],
            }),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: { ...processInput, content: ["150/645", "150/580"].join("\n") },
      });

      expect(result.parsedTeamCount).toBe(2);
      expect(result.skippedTeamCount).toBe(0);
      expect(harness.submission()).toMatchObject({
        parsedSubmission: [{ teamConfigName: "Full Fill" }, { teamConfigName: "Encore" }],
      });
    }),
  );

  it.effect("skips when the only writable config does not match", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.succeed({
              rangesConfig,
              teamConfigs: [
                makeTeamConfig("Missing", null),
                makeTeamConfig("Unmatched", "auto", ["heal"]),
              ],
            }),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.parsedTeamCount).toBe(0);
      expect(result.skippedTeamCount).toBe(1);
      expect(harness.submission()).toMatchObject({
        parsedSubmission: [],
        rowMappings: [],
      });
    }),
  );

  it.effect("does not require a team-name range for an auto config", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.succeed({
              rangesConfig,
              teamConfigs: [
                Schema.decodeUnknownSync(TeamConfig)({
                  _tag: "TeamConfig",
                  name: "Auto",
                  sheet: "Teams",
                  playerNameRange: "'Teams'!A:A",
                  teamNameRange: "auto",
                  isvConfig: null,
                  tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
                  oshiRange: null,
                }),
              ],
            }),
        },
      });
      const operations = yield* harness.operations;
      const result = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });

      expect(result.parsedTeamCount).toBe(1);
      expect(result.skippedTeamCount).toBe(0);
      expect(harness.submission()).toMatchObject({
        rowMappings: [{ playerNameRange: "'Teams'!A:A", teamNameRange: null }],
      });
    }),
  );

  it.effect("reports configuration preparation failures after delivering progress", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.fail(
              new TeamSubmissionProviderError({
                operation: "read",
                cause: "configuration unavailable",
              }),
            ),
        },
      });
      const operations = yield* harness.operations;
      const failed = yield* Effect.exit(
        operations.process({
          invocationId,
          principal: servicePrincipal,
          input: processInput,
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(harness.deliveryOperations).toEqual([
        "sendMessage",
        "setMessageReaction",
        "editMessage",
      ]);
      expect(harness.deliveryMessages[harness.deliveryMessages.length - 1]).toMatchObject({
        embeds: [{ title: "Could not prepare teams" }],
      });
      expect(harness.persistedStatuses).toEqual([]);
      expect(harness.sheetWrites).toEqual([]);
      expect(harness.sheetAppends).toEqual([]);
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
      expect(harness.persistedStatuses).toEqual(["pending"]);
      expect(harness.sheetWrites).toEqual([]);
    }),
  );

  it.effect("writes only after confirming a staged submission", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const operations = yield* harness.operations;
      const staged = yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });
      expect(staged.status).toBe("pending");
      expect(harness.sheetWrites).toEqual([]);
      expect(harness.sheetAppends).toEqual([]);

      const confirmed = yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: { ...decideInput, decision: "confirm" as const },
      });
      expect(confirmed.status).toBe("confirmed");
      expect(harness.sheetAppends).toHaveLength(1);
      expect(harness.sheetWrites.length).toBeGreaterThan(0);
      expect(harness.persistedStatuses[0]).toBe("pending");
      expect(harness.persistedStatuses[harness.persistedStatuses.length - 1]).toBe("confirmed");
    }),
  );

  it.effect("does not redirect a pending plan when its team mapping changes", () =>
    Effect.gen(function* () {
      const makeTeamConfig = (playerNameRange: string, teamNameRange: string) =>
        Schema.decodeUnknownSync(TeamConfig)({
          _tag: "TeamConfig",
          name: "Teams",
          sheet: "Teams",
          playerNameRange,
          teamNameRange,
          isvConfig: null,
          tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
          oshiRange: null,
        });
      let loadCount = 0;
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.sync(() => ({
              rangesConfig,
              teamConfigs: [
                loadCount++ === 0
                  ? makeTeamConfig("'Teams'!A:A", "'Teams'!B:B")
                  : makeTeamConfig("'Other'!A:A", "'Other'!B:B"),
              ],
            })),
        },
      });
      const operations = yield* harness.operations;
      yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });
      expect(loadCount).toBe(1);
      const failed = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(loadCount).toBe(2);
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        expect(Option.getOrThrow(Cause.findErrorOption(failed.cause))).toMatchObject({
          _tag: "BusinessRuleRejected",
          code: "PendingPlanInvalid",
        });
      }
      expect(harness.submission()).toMatchObject({
        status: "pending",
        rowMappings: [pendingMapping],
      });
      expect(harness.sheetWrites).toEqual([]);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.deliveryMessages[harness.deliveryMessages.length - 1]).toMatchObject({
        embeds: [{ title: "Could not prepare teams" }],
      });
    }),
  );

  it.effect("keeps a pending submission when confirmation cannot load configuration", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "pending",
          parsedSubmission: [durableEntry],
          rowMappings: [pendingMapping],
        }),
        provider: {
          loadConfiguration: () =>
            Effect.fail(
              new TeamSubmissionProviderError({
                operation: "read",
                cause: "configuration unavailable",
              }),
            ),
        },
      });
      const operations = yield* harness.operations;
      const failed = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(harness.submission()?.status).toBe("pending");
      expect(harness.sheetWrites).toEqual([]);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.deliveryMessages[harness.deliveryMessages.length - 1]).toMatchObject({
        embeds: [{ title: "Could not prepare teams" }],
      });
    }),
  );

  it.effect("uses the pre-write failure path for invalid team ranges", () =>
    Effect.gen(function* () {
      const invalidTeamConfig = Schema.decodeUnknownSync(TeamConfig)({
        _tag: "TeamConfig",
        name: "Teams",
        sheet: "Teams",
        playerNameRange: "'Players'!A:A",
        teamNameRange: "'Teams'!B:B",
        isvConfig: null,
        tagsConfig: { _tag: "TeamTagsConstantsConfig", tags: ["full fill"] },
        oshiRange: null,
      });
      const harness = makeHarness({
        provider: {
          loadConfiguration: () =>
            Effect.succeed({ rangesConfig, teamConfigs: [invalidTeamConfig] }),
        },
      });
      const operations = yield* harness.operations;
      yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });
      const failed = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        expect(Option.getOrThrow(Cause.findErrorOption(failed.cause))).toMatchObject({
          _tag: "InvalidRequest",
          code: "InvalidTeamConfig",
        });
      }
      expect(harness.submission()?.status).toBe("pending");
      expect(harness.sheetWrites).toEqual([]);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.deliveryMessages[harness.deliveryMessages.length - 1]).toMatchObject({
        embeds: [{ title: "Could not prepare teams" }],
      });
    }),
  );

  it.effect("keeps an applying recovery record when the confirmed append fails", () =>
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
      yield* operations.process({
        invocationId,
        principal: servicePrincipal,
        input: processInput,
      });
      const exit = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(harness.submission()).toMatchObject({
        status: "applying",
        rowMappings: [{ rowIndex: 0 }],
        rollbackSnapshot: [{ range: pendingAppendRollbackRange, values: [] }],
      });
      expect(harness.sheetWrites).toEqual([]);
    }),
  );

  it.effect("keeps a pending submission when the player row read fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "pending",
          parsedSubmission: [durableEntry],
          rowMappings: [pendingMapping],
        }),
        provider: {
          read: (_spreadsheetId, ranges) =>
            ranges.includes("'Teams'!A:A")
              ? Effect.fail(
                  new TeamSubmissionProviderError({
                    operation: "read",
                    cause: "player range unavailable",
                  }),
                )
              : Effect.succeed(ranges.map((range) => ({ range, values: [] }))),
        },
      });
      const operations = yield* harness.operations;
      const failed = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(harness.submission()?.status).toBe("pending");
      expect(harness.persistedStatuses).toEqual([]);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.sheetWrites).toEqual([]);

      const rejected = yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: decideInput,
      });
      expect(rejected.status).toBe("rejected");
      expect(harness.persistedStatuses).toEqual(["rejected"]);
      expect(harness.sheetAppends).toEqual([]);
      expect(harness.sheetWrites).toEqual([]);
    }),
  );

  it.effect("merges missing recovery entries before resuming an applying submission", () =>
    Effect.gen(function* () {
      const writes: Array<
        ReadonlyArray<{
          readonly range: string;
          readonly values: ReadonlyArray<ReadonlyArray<string>>;
        }>
      > = [];
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "applying",
          parsedSubmission: [durableEntry, overwrittenEntry],
          rowMappings: [durableMapping, overwrittenMapping],
          rollbackSnapshot: [
            { stableKey: durableEntry.stableKey, range: "'Teams'!A2", values: [["old-player"]] },
          ],
        }),
        readValues: (range) => {
          if (range === "'Teams'!A:B") {
            return [[], ["Player", "150/700"], ["Other", "150/701"]];
          }
          if (range === "'Teams'!A2") return [["old-player"]];
          if (range === "'Teams'!B2") return [["old-team"]];
          if (range === "'Teams'!A3") return [["older-player"]];
          if (range === "'Teams'!B3") return [["older-team"]];
          return [];
        },
        provider: {
          write: (_sheetId, updates) =>
            Effect.sync(() => writes.push(updates)).pipe(
              Effect.flatMap(() =>
                writes.length === 1
                  ? Effect.fail(
                      new TeamSubmissionWriteError({
                        operation: "write",
                        ambiguous: false,
                        cause: "sheet unavailable",
                      }),
                    )
                  : Effect.void,
              ),
            ),
        },
      });
      const operations = yield* harness.operations;
      const failed = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: { ...decideInput, decision: "confirm" as const },
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(harness.submission()?.status).toBe("applying");
      expect(harness.submission()?.rollbackSnapshot).toEqual(
        expect.arrayContaining([
          {
            stableKey: overwrittenEntry.stableKey,
            range: "'Teams'!A3",
            values: [["older-player"]],
          },
          { stableKey: overwrittenEntry.stableKey, range: "'Teams'!B3", values: [["older-team"]] },
        ]),
      );

      const rejected = yield* operations.decide({
        invocationId,
        principal: userPrincipal,
        input: decideInput,
      });
      expect(rejected.status).toBe("rejected");
      expect(writes[1]).toEqual(
        expect.arrayContaining([
          { range: "'Teams'!A3", values: [["older-player"]] },
          { range: "'Teams'!B3", values: [["older-team"]] },
        ]),
      );
    }),
  );

  it.effect("rejects a staged submission without writing or rolling back", () =>
    rejectStagedSubmission(),
  );

  it.effect("rejects a staged edit without rolling back an older applied submission", () =>
    rejectStagedSubmission(
      makeSubmission({
        parsedSubmission: [durableEntry],
        rowMappings: [durableMapping],
        rollbackSnapshot: [
          { stableKey: durableEntry.stableKey, range: "'Teams'!A2", values: [["old"]] },
        ],
      }),
    ),
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

  it.effect("retains rollback recovery for an old in-progress submission without a binding", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        initialSubmission: makeSubmission({
          status: "applying",
          parsedSubmission: [durableEntry],
          rowMappings: [durableMapping],
          sheetConfigurationBinding: null,
        }),
      });
      const operations = yield* harness.operations;
      const exit = yield* Effect.exit(
        operations.decide({
          invocationId,
          principal: userPrincipal,
          input: decideInput,
        }),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.status).toBe("rollbackFailed");
      expect(harness.persistedStatuses).toEqual(["rollbackFailed"]);
      expect(harness.submission()?.sheetConfigurationBinding).toBeNull();
      expect(harness.sheetWrites).toEqual([]);
    }),
  );
});
