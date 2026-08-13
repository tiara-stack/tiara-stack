import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  type AcceptedWorkflowInvocation,
  type WorkflowInvocationStore,
} from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  BotDependencyUnavailable,
  BotResponseExpired,
  DeliveryKey,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  InteractiveDeclaredFailure,
  PreferencesDeliverStatus,
  PreferencesUpdateAndDeliver,
} from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeSheetApisClient, makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import {
  makeRecordingWorkflowAuthorization,
  workflowTestAccountId as accountId,
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { PreferencesSheetWorkflowContracts } from "./catalog";
import {
  isPreferencesSheetWorkflowName,
  makePreferencesDeliveryKey,
  materializePreferencesWorkflowFailure,
  PreferencesSheetWorkflowDefinitions,
  PreferencesSheetWorkflows,
} from "./definitions";
import {
  PreferencesWorkflowOperations,
  preferenceStatusHeadline,
  preferencesWorkflowOperationsLayer,
} from "./operations";
import { PreferencesSheetWorkflowRegistrations } from "./registry";
import { makeSelectedWorkflowTransportHandler } from "../selected";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");

const allowAuthorizationLayer = Layer.succeed(ReadOnlyWorkflowAuthorization, {
  authorize: () => Effect.void,
  authorizeSlotOpen: () => Effect.die("unused"),
  authorizeCheckinRespond: () => Effect.die("unused"),
  authorizeRoomOrdersNavigate: () => Effect.die("unused"),
  workspaceCapabilities: () => Effect.die("unused"),
});

const makeOperations = (
  preferences: TrustedSheetPersistence["Service"]["preferences"],
  bot: SheetBotHttpClient,
) => {
  const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
  return Effect.gen(function* () {
    return yield* PreferencesWorkflowOperations;
  }).pipe(
    Effect.provide(preferencesWorkflowOperationsLayer),
    Effect.provide(
      Layer.succeed(TrustedSheetPersistence, {
        ...base,
        preferences,
      }),
    ),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ sheetBotClientId: "discord-main" })),
    ),
  );
};

const makeBot = (
  respond: (request: {
    readonly payload: {
      readonly responseReference: typeof ResponseReference.Type;
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly message: unknown;
    };
  }) => Effect.Effect<unknown, unknown>,
): SheetBotHttpClient =>
  ({
    delivery: { respond },
  }) as unknown as SheetBotHttpClient;

describe("preferences write-and-delivery Workflow Definition slice", () => {
  it("registers exactly the two pinned definitions", () => {
    expect(PreferencesSheetWorkflowContracts).toEqual([
      PreferencesDeliverStatus,
      PreferencesUpdateAndDeliver,
    ]);
    expect(
      PreferencesSheetWorkflowDefinitions.map(({ contract, workflow }) => ({
        contract: workflowContractKey(contract),
        workflow: workflow.name,
      })),
    ).toEqual(
      PreferencesSheetWorkflowContracts.map((contract) => ({
        contract: workflowContractKey(contract),
        workflow: workflowContractKey(contract),
      })),
    );
    expect(
      PreferencesSheetWorkflowDefinitions.reduce((count, { actions }) => count + actions.length, 0),
    ).toBe(5);
    expect(
      PreferencesSheetWorkflowRegistrations.every(
        ({ definitionVersion }) => definitionVersion === "1",
      ),
    ).toBe(true);
    expect(
      PreferencesSheetWorkflowDefinitions.every(
        ({ contract }) => contract.declaredFailure === InteractiveDeclaredFailure,
      ),
    ).toBe(true);
    expect(isPreferencesSheetWorkflowName(PreferencesSheetWorkflows[0]!.name)).toBe(true);
    expect(isPreferencesSheetWorkflowName("legacy.workflow")).toBe(false);
  });

  it.effect("uses stable action identities and deterministic Delivery Keys across replay", () =>
    Effect.gen(function* () {
      const statusPayload = {
        invocationId,
        principal,
        input: { responseReference, kind: "checkin" as const },
      };
      const updatePayload = {
        invocationId,
        principal,
        input: {
          responseReference,
          platform: "discord",
          checkinDmEnabled: true,
          defaultClientId: "discord-main",
        },
      };
      const statusExecution = yield* PreferencesSheetWorkflows[0]!.executionId(statusPayload);
      const statusReplay = yield* PreferencesSheetWorkflows[0]!.executionId(statusPayload);
      const updateExecution = yield* PreferencesSheetWorkflows[1]!.executionId(updatePayload);
      expect(statusReplay).toBe(statusExecution);
      expect(updateExecution).not.toBe(statusExecution);
      expect(makePreferencesDeliveryKey(PreferencesDeliverStatus, invocationId)).toBe(
        makePreferencesDeliveryKey(PreferencesDeliverStatus, invocationId),
      );
      expect(makePreferencesDeliveryKey(PreferencesUpdateAndDeliver, invocationId)).not.toBe(
        makePreferencesDeliveryKey(PreferencesDeliverStatus, invocationId),
      );
    }),
  );

  it.effect("composes self authorization with the Effective Principal and owner isolation", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const authorization = makeRecordingWorkflowAuthorization(calls);
      yield* PreferencesSheetWorkflowRegistrations[0]!
        .authorize(context, { responseReference, kind: "monitor" })
        .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
      expect(calls).toEqual([
        {
          contract: PreferencesDeliverStatus,
          principal,
          input: { responseReference, kind: "monitor" },
        },
      ]);

      const enqueueCalls: Array<AcceptedWorkflowInvocation> = [];
      let stored: AcceptedWorkflowInvocation | undefined;
      const store: WorkflowInvocationStore = {
        enqueue: (invocation) => {
          enqueueCalls.push(invocation);
          stored ??= invocation;
          return Effect.succeed(invocation.fingerprint);
        },
        get: (ownerKey, workflowName, requestedId) =>
          Effect.succeed(
            stored &&
              stored.ownerKey === ownerKey &&
              stored.workflowName === workflowName &&
              stored.fingerprint.invocationId === requestedId
              ? {
                  runId: requestedId,
                  status: "pending" as const,
                  result: null,
                  error: null,
                  completedAt: null,
                  createdAt: 0,
                  updatedAt: 0,
                }
              : undefined,
          ),
        list: () => Effect.succeed([]),
      };
      const handler = yield* makeSelectedWorkflowTransportHandler(store);
      const request = {
        invocationId,
        input: { responseReference, kind: "checkin" as const },
      };
      const first = yield* handler.enqueue(PreferencesDeliverStatus, context, request);
      const replay = yield* handler.enqueue(PreferencesDeliverStatus, context, request);
      expect(replay).toEqual(first);
      expect(enqueueCalls).toHaveLength(2);
      expect(enqueueCalls[1]?.fingerprint).toEqual(enqueueCalls[0]?.fingerprint);
      expect(stored?.principal).toEqual(principal);
      const foreignContext = { ...context, ownerKey: "user:other" };
      const ownerMismatch = yield* Effect.exit(
        PreferencesSheetWorkflowRegistrations[0]!.authorizeObservation(foreignContext),
      );
      const ownerMismatchFailure = Exit.isFailure(ownerMismatch)
        ? Cause.findErrorOption(ownerMismatch.cause)
        : Option.none();
      expect(Option.getOrThrow(ownerMismatchFailure)).toMatchObject({
        _tag: "WorkflowInvocationUnauthorized",
        message: "Workflow owner does not match the effective principal",
      });
      const foreign = yield* Effect.exit(
        handler.get(PreferencesDeliverStatus, foreignContext, invocationId),
      );
      const foreignFailure = Exit.isFailure(foreign)
        ? Cause.findErrorOption(foreign.cause)
        : Option.none();
      expect(Option.getOrThrow(foreignFailure)).toMatchObject({
        _tag: "WorkflowObservationUnauthorized",
        message: "Workflow observation is unauthorized",
      });
    }).pipe(Effect.provide(allowAuthorizationLayer)),
  );

  it.effect("reads and mutates preferences only through trusted persistence", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      let row = Option.none<{
        readonly platform: string;
        readonly userId: string;
        readonly checkinDmEnabled: boolean;
        readonly monitorDmEnabled: boolean;
        readonly defaultClientId: string | null;
        readonly createdAt: number;
        readonly updatedAt: number;
        readonly deletedAt: number | null;
      }>();
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const preferences: TrustedSheetPersistence["Service"]["preferences"] = {
        ...base.preferences,
        getUserPlatformConfig: (args) => {
          calls.push({ method: "get", args });
          return Effect.succeed(row);
        },
        upsertUserPlatformConfig: (args) => {
          calls.push({ method: "upsert", args });
          row = Option.some({
            platform: args.platform,
            userId: args.userId,
            checkinDmEnabled: args.checkinDmEnabled ?? false,
            monitorDmEnabled: args.monitorDmEnabled ?? false,
            defaultClientId: args.defaultClientId ?? null,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          });
          return Effect.void;
        },
      };
      const operations = yield* makeOperations(
        preferences,
        makeBot(() => Effect.die("delivery is not part of this assertion")),
      );
      expect(yield* operations.load(principal, "discord", "policy")).toEqual({
        platform: "discord",
        checkinDmEnabled: false,
        monitorDmEnabled: false,
        defaultClientId: null,
      });
      expect(
        yield* operations.update(
          principal,
          {
            responseReference,
            platform: "discord",
            checkinDmEnabled: true,
            defaultClientId: "discord-main",
          },
          {
            platform: "discord",
            checkinDmEnabled: false,
            monitorDmEnabled: false,
            defaultClientId: null,
          },
          "policy",
        ),
      ).toEqual({
        platform: "discord",
        checkinDmEnabled: true,
        monitorDmEnabled: false,
        defaultClientId: "discord-main",
      });
      expect(calls).toEqual([
        { method: "get", args: { platform: "discord", userId: accountId } },
        {
          method: "upsert",
          args: {
            platform: "discord",
            userId: accountId,
            checkinDmEnabled: true,
            monitorDmEnabled: false,
            defaultClientId: "discord-main",
          },
        },
      ]);
    }),
  );

  it.effect("maps typed delivery receipts and retries ambiguity with the same Delivery Key", () =>
    Effect.gen(function* () {
      const calls: Array<typeof DeliveryKey.Type> = [];
      let attempt = 0;
      const bot = makeBot(({ payload }) => {
        calls.push(payload.deliveryKey);
        attempt += 1;
        return attempt === 1
          ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous provider outcome" }))
          : Effect.succeed({
              deliveryKey: payload.deliveryKey,
              operation: "respond" as const,
              target: {
                _tag: "Response" as const,
                responseReference: payload.responseReference,
              },
            });
      });
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const operations = yield* makeOperations(base.preferences, bot);
      const state = {
        platform: "discord",
        checkinDmEnabled: true,
        monitorDmEnabled: false,
        defaultClientId: "discord-main",
      };
      const deliveryKey = makePreferencesDeliveryKey(PreferencesDeliverStatus, invocationId);
      const first = yield* Effect.exit(
        operations.deliver(
          { responseReference },
          state,
          deliveryKey,
          preferenceStatusHeadline("checkin", state),
          "policy",
          { recoveryRequired: false },
        ),
      );
      expect(Exit.isFailure(first)).toBe(true);
      expect(
        yield* operations.deliver(
          { responseReference },
          state,
          deliveryKey,
          preferenceStatusHeadline("checkin", state),
          "policy",
          { recoveryRequired: false },
        ),
      ).toEqual({
        deliveryKey,
        operation: "respond",
        target: { _tag: "Response", responseReference },
      });
      expect(calls).toEqual([deliveryKey, deliveryKey]);
    }),
  );

  it.effect("materializes typed delivery and system failures without provider details", () =>
    Effect.gen(function* () {
      const bot = makeBot(() =>
        Effect.fail(new BotResponseExpired({ message: "provider token secret" })),
      );
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const operations = yield* makeOperations(base.preferences, bot);
      const error = yield* Effect.flip(
        operations.deliver(
          { responseReference },
          {
            platform: "discord",
            checkinDmEnabled: false,
            monitorDmEnabled: false,
            defaultClientId: null,
          },
          Schema.decodeUnknownSync(DeliveryKey)("delivery-1"),
          "Preferences loaded.",
          "policy",
          { recoveryRequired: true },
        ),
      );
      expect(error).toEqual({
        _tag: "DeliveryRejected",
        operation: "preferences.respond",
        message: "The response is no longer available",
        recoveryRequired: true,
      });

      const declared = {
        _tag: "InvalidRequest" as const,
        code: "UnsupportedNotificationClient",
        message: "Unsupported notification client",
      };
      expect(
        materializePreferencesWorkflowFailure(PreferencesSheetWorkflows[0]!, Cause.fail(declared)),
      ).toEqual({ _tag: "Declared", error: declared });
      expect(
        materializePreferencesWorkflowFailure(
          PreferencesSheetWorkflows[0]!,
          Cause.die("postgres://secret@internal/preferences"),
        ),
      ).toEqual({ _tag: "System", code: "UnexpectedFailure", retryable: false });
      expect(
        materializePreferencesWorkflowFailure(
          PreferencesSheetWorkflows[0]!,
          Cause.fail({
            _tag: "DeliveryRejected",
            operation: "preferences.respond",
            message: "invalid declared JSON",
            committedReference: undefined,
            recoveryRequired: false,
          }),
        ),
      ).toEqual({ _tag: "System", code: "UnexpectedFailure", retryable: false });
    }),
  );
});
