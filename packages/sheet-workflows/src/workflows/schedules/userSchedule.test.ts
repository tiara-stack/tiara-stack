import { describe, expect, it } from "@effect/vitest";
import type { sheets_v4 } from "@googleapis/sheets";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import {
  BotAdmissionDenied,
  BotDependencyUnavailable,
  BotRequestRejected,
  BotResourceNotFound,
  BotResponseExpired,
  DeliveryKey,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { InteractiveDeclaredFailure, SchedulesDeliverUserSchedule } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  makeSheetApisClient,
  makeTrustedSheetPersistenceMock,
  normalizePayloadText,
} from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import {
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import {
  executeUserScheduleLoadAction,
  executeUserScheduleRespondAction,
  makeUserScheduleDefinition,
  makeUserScheduleMessage,
  makeUserScheduleWorkflowBody,
  summarizeUserSchedule,
} from "./definition";
import {
  isScheduleSheetWorkflowName,
  materializeScheduleWorkflowFailure,
  ScheduleSheetWorkflows,
} from "./definitions";
import { makeScheduleDeliveryKey } from "./keys";
import { scheduleWorkflowOperationsLayer } from "./operations";
import {
  isRetryableUserScheduleReadFailure,
  makeUserScheduleProvider,
  UserScheduleProvider,
  UserScheduleProviderError,
} from "./provider";
import { ScheduleSheetWorkflowRegistrations } from "./registry";
import type { UserScheduleView } from "./schema";
import { ScheduleWorkflowOperations } from "./service";

const UserScheduleDefinition = makeUserScheduleDefinition();
const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const input = Schema.decodeUnknownSync(SchedulesDeliverUserSchedule.input)({
  workspaceId: "workspace-1",
  responseReference,
  day: 2,
  targetUserId: "account-target",
  targetUsername: "Target_User",
});
const eventStartEpochMs = Date.parse("2026-01-01T00:00:00.000Z");
const view: UserScheduleView = {
  eventStartEpochMs,
  players: [
    { accountId: "account-target", name: "Target" },
    { accountId: "account-other", name: "Other" },
  ],
  monitors: [{ accountId: "monitor-1", name: "Monitor" }],
  schedules: [
    {
      visible: true,
      hour: 3,
      break: false,
      fills: ["Target"],
      overfills: ["Target"],
      standbys: ["Other"],
      monitor: "Monitor",
    },
    {
      visible: true,
      hour: null,
      break: false,
      fills: ["Target"],
      overfills: ["Target"],
      standbys: ["Target"],
      monitor: null,
    },
    {
      visible: true,
      hour: 1,
      break: true,
      fills: ["Target"],
      overfills: ["Target"],
      standbys: ["Target"],
      monitor: null,
    },
    {
      visible: true,
      hour: 2,
      break: false,
      fills: ["Target"],
      overfills: ["Other"],
      standbys: ["Target"],
      monitor: null,
    },
    {
      visible: true,
      hour: 3,
      break: false,
      fills: ["Target"],
      overfills: ["Target"],
      standbys: ["Target"],
      monitor: null,
    },
  ],
};
const responseKey = makeScheduleDeliveryKey(SchedulesDeliverUserSchedule, invocationId, "respond");
const registration = Option.getOrThrow(
  Option.fromNullishOr(
    ScheduleSheetWorkflowRegistrations.find(
      ({ contract }) => contract.identity === SchedulesDeliverUserSchedule.identity,
    ),
  ),
);
const workflow = Option.getOrThrow(
  Option.fromNullishOr(
    ScheduleSheetWorkflows.find(
      ({ name }) => name === workflowContractKey(SchedulesDeliverUserSchedule),
    ),
  ),
);
const receipt = {
  deliveryKey: responseKey,
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};

const makeBot = (
  respond: (request: {
    readonly payload: {
      readonly responseReference: typeof ResponseReference.Type;
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly message: unknown;
    };
  }) => Effect.Effect<unknown, unknown>,
): SheetBotHttpClient => ({ delivery: { respond } }) as unknown as SheetBotHttpClient;

const basePersistence = () => makeTrustedSheetPersistenceMock(makeSheetApisClient({}));

const configuredWorkspaces = (
  workspaces: TrustedSheetPersistence["Service"]["workspaces"],
): TrustedSheetPersistence["Service"]["workspaces"] => ({
  ...workspaces,
  getWorkspaceConfigByWorkspaceId: () =>
    Effect.succeed(
      Option.some({
        workspaceId: "workspace-1",
        sheetId: "sheet-1",
        autoCheckin: null,
        monitorConversationId: null,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      }),
    ),
});

const makeOperations = (provider: UserScheduleProvider["Service"], bot: SheetBotHttpClient) =>
  Effect.gen(function* () {
    const persistence = basePersistence();
    return yield* ScheduleWorkflowOperations.pipe(
      Effect.provide(scheduleWorkflowOperationsLayer),
      Effect.provide(
        Layer.succeed(TrustedSheetPersistence, {
          ...persistence,
          workspaces: configuredWorkspaces(persistence.workspaces),
        }),
      ),
      Effect.provide(Layer.succeed(UserScheduleProvider, provider)),
      Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
    );
  });

describe("user-schedule delivery Workflow Definition slice", () => {
  it("registers the pinned definition with exactly the approved Durable Actions", () => {
    expect(UserScheduleDefinition.contract).toBe(SchedulesDeliverUserSchedule);
    expect(UserScheduleDefinition.workflow.name).toBe(
      workflowContractKey(SchedulesDeliverUserSchedule),
    );
    expect(UserScheduleDefinition.actions.map(({ workflow }) => workflow.name)).toEqual([
      "schedules.deliverUserSchedule.load-user-schedule",
      "schedules.deliverUserSchedule.respond",
    ]);
    expect(UserScheduleDefinition.contract.declaredFailure).toBe(InteractiveDeclaredFailure);
    expect(registration.definitionVersion).toBe("2");
    expect(SchedulesDeliverUserSchedule.authorizationPolicy).toMatchObject({
      version: "2",
      principalKinds: ["user"],
      requiredCapabilities: [],
      resource: "workspace",
      resourceField: "workspaceId",
      targetUserField: "targetUserId",
      userRule: "target-user-or-workspace-monitor-or-application-owner",
    });
  });

  it("matches the target user, filters missing hours, and sorts and deduplicates each range", () => {
    expect(summarizeUserSchedule(view, input.targetUserId)).toEqual({
      fillHours: [2, 3],
      overfillHours: [3],
      standbyHours: [2, 3],
      invisible: false,
    });
    expect(summarizeUserSchedule(view, "missing-account")).toEqual({
      fillHours: [],
      overfillHours: [],
      standbyHours: [],
      invisible: false,
    });
  });

  it("does not attribute schedules with an ambiguous player name", () => {
    const ambiguousView: UserScheduleView = {
      ...view,
      players: [...view.players, { accountId: "account-duplicate", name: "Target" }],
    };
    expect(summarizeUserSchedule(ambiguousView, input.targetUserId)).toEqual({
      fillHours: [],
      overfillHours: [],
      standbyHours: [],
      invisible: false,
    });
  });

  it("renders the exact legacy visible embed and web-schedule preview", () => {
    const summary = summarizeUserSchedule(view, input.targetUserId);
    expect(
      normalizePayloadText(makeUserScheduleMessage(input.day, input.targetUsername, summary)),
    ).toEqual({
      embeds: [
        {
          title: "Target\\_User's Schedule for Day 2",
          description: null,
          fields: [
            { name: "Fill", value: "2-3" },
            { name: "Overfill", value: "3" },
            { name: "Standby", value: "2-3" },
          ],
        },
        {
          description: "📅 Preview: View your schedule online at https://schedule.theerapakg.moe/",
          color: 0x5865f2,
        },
      ],
    });
  });

  it("renders the exact legacy invisible embed without leaking schedule hours", () => {
    const summary = summarizeUserSchedule(
      {
        ...view,
        schedules: view.schedules.map((schedule, index) =>
          index === 0 ? { ...schedule, visible: false } : schedule,
        ),
      },
      input.targetUserId,
    );
    expect(summary.invisible).toBe(true);
    expect(normalizePayloadText(makeUserScheduleMessage(input.day, "Target", summary))).toEqual({
      embeds: [
        {
          title: "Target's Schedule for Day 2",
          description: "It is kinda foggy around here... This schedule is not visible to you yet.",
          fields: [],
        },
        {
          description: "📅 Preview: View your schedule online at https://schedule.theerapakg.moe/",
          color: 0x5865f2,
        },
      ],
    });
  });

  it.effect("returns one response receipt as the sole Commit Point", () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = [];
      const body = makeUserScheduleWorkflowBody({
        load: () => Effect.succeed(view),
        respond: ({ message }) => {
          messages.push(message);
          return Effect.succeed(receipt);
        },
      });
      expect(yield* body({ invocationId, principal, input })).toEqual({
        workspaceId: "workspace-1",
        day: 2,
        targetUserId: "account-target",
        invisible: false,
        deliveryReceipts: [receipt],
      });
      expect(messages).toEqual([
        makeUserScheduleMessage(
          input.day,
          input.targetUsername,
          summarizeUserSchedule(view, input.targetUserId),
        ),
      ]);
    }),
  );

  it.effect("uses deterministic Action Keys and an operation-specific Delivery Key", () =>
    Effect.gen(function* () {
      const message = makeUserScheduleMessage(
        input.day,
        input.targetUsername,
        summarizeUserSchedule(view, input.targetUserId),
      );
      const payload = { invocationId, principal, input, message };
      const actionIds = yield* Effect.forEach(UserScheduleDefinition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const replayIds = yield* Effect.forEach(UserScheduleDefinition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      expect(replayIds).toEqual(actionIds);
      expect(new Set(actionIds).size).toBe(2);
      expect(responseKey).toBe(`schedules.deliverUserSchedule:2:${invocationId}:respond`);
    }),
  );

  it.effect("reauthorizes before provider reads and response delivery on replay", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let authorized = true;
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: () => {
          calls.push("authorize");
          return authorized
            ? Effect.void
            : Effect.fail(new WorkflowInvocationUnauthorized({ message: "membership revoked" }));
        },
        workspaceCapabilities: () => Effect.die("unused"),
      };
      const operations: ScheduleWorkflowOperations["Service"] = {
        loadUserSchedule: () => {
          calls.push("load-user-schedule");
          return Effect.succeed(view);
        },
        respond: () => {
          calls.push("respond");
          return Effect.succeed(receipt);
        },
      };
      const services = Layer.mergeAll(
        Layer.succeed(ReadOnlyWorkflowAuthorization, authorization),
        Layer.succeed(ScheduleWorkflowOperations, operations),
      );
      yield* executeUserScheduleLoadAction({ invocationId, principal, input }).pipe(
        Effect.provide(services),
      );
      yield* executeUserScheduleRespondAction({
        invocationId,
        principal,
        input,
        message: makeUserScheduleMessage(
          input.day,
          input.targetUsername,
          summarizeUserSchedule(view, input.targetUserId),
        ),
      }).pipe(Effect.provide(services));
      expect(calls).toEqual(["authorize", "load-user-schedule", "authorize", "respond"]);

      authorized = false;
      expect(
        yield* Effect.flip(
          executeUserScheduleLoadAction({ invocationId, principal, input }).pipe(
            Effect.provide(services),
          ),
        ),
      ).toEqual({
        _tag: "AuthorizationRevoked",
        policy: SchedulesDeliverUserSchedule.authorizationPolicy.policy,
      });
      expect(calls.at(-1)).toBe("authorize");
    }),
  );

  it.effect("enforces owner isolation for workspace-member invocations", () =>
    Effect.gen(function* () {
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: () => Effect.void,
        workspaceCapabilities: () => Effect.die("unused"),
      };
      yield* registration
        .authorize(context, input)
        .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
      const isolation = yield* Effect.exit(
        registration
          .authorizeObservation({ ...context, ownerKey: "user:other" })
          .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization)),
      );
      expect(Exit.isFailure(isolation)).toBe(true);
      if (Exit.isFailure(isolation)) {
        expect(Option.getOrThrow(Cause.findErrorOption(isolation.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
          message: "Workflow owner does not match the effective principal",
        });
      }
    }),
  );

  it.effect("resolves the trusted workspace sheet and materializes provider rejection", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const operations = yield* makeOperations(
        {
          load: (spreadsheetId, day) => {
            calls.push({ spreadsheetId, day });
            return Effect.fail(
              new UserScheduleProviderError({
                operation: "read-user-schedule",
                cause: "provider failure",
              }),
            );
          },
        },
        makeBot(() => Effect.die("unused")),
      );
      expect(yield* Effect.flip(operations.loadUserSchedule(input))).toEqual({
        _tag: "ExternalOperationRejected",
        operation: "schedules.deliverUserSchedule.loadUserSchedule",
        code: "ProviderRejected",
        message: "The schedule provider rejected the user schedule read",
      });
      expect(calls).toEqual([{ spreadsheetId: "sheet-1", day: 2 }]);
    }),
  );

  it.effect("reconciles ambiguous delivery with the same delivery key", () =>
    Effect.gen(function* () {
      const keys: Array<typeof DeliveryKey.Type> = [];
      let attempt = 0;
      const operations = yield* makeOperations(
        { load: () => Effect.succeed(view) },
        makeBot(({ payload }) => {
          keys.push(payload.deliveryKey);
          attempt += 1;
          return attempt === 1
            ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous outcome" }))
            : Effect.succeed(receipt);
        }),
      );
      const message = makeUserScheduleMessage(
        input.day,
        input.targetUsername,
        summarizeUserSchedule(view, input.targetUserId),
      );
      expect(
        yield* Effect.flip(
          operations.respond(
            input,
            message,
            responseKey,
            SchedulesDeliverUserSchedule.authorizationPolicy.policy,
          ),
        ),
      ).toMatchObject({
        _tag: "ScheduleWorkflowOperationsError",
        operation: "schedules.deliverUserSchedule.respond",
      });
      expect(
        yield* operations.respond(
          input,
          message,
          responseKey,
          SchedulesDeliverUserSchedule.authorizationPolicy.policy,
        ),
      ).toEqual(receipt);
      expect(keys).toEqual([responseKey, responseKey]);
    }),
  );

  it.effect("declares definitive pre-commit delivery failures", () =>
    Effect.gen(function* () {
      const message = makeUserScheduleMessage(
        input.day,
        input.targetUsername,
        summarizeUserSchedule(view, input.targetUserId),
      );
      const failures = [
        {
          error: new BotResponseExpired({ message: "expired secret" }),
          expected: {
            _tag: "DeliveryRejected",
            operation: "schedules.deliverUserSchedule.respond",
            message: "The response is no longer available",
            recoveryRequired: false,
          },
        },
        {
          error: new BotRequestRejected({ message: "rejected secret" }),
          expected: {
            _tag: "DeliveryRejected",
            operation: "schedules.deliverUserSchedule.respond",
            message: "The user schedule response was rejected",
            recoveryRequired: false,
          },
        },
        {
          error: new BotAdmissionDenied({ message: "membership revoked" }),
          expected: {
            _tag: "AuthorizationRevoked",
            policy: SchedulesDeliverUserSchedule.authorizationPolicy.policy,
          },
        },
        {
          error: new BotResourceNotFound({
            resource: "response",
            message: "response is unavailable",
          }),
          expected: { _tag: "ResourceNotFound", resource: "response" },
        },
      ] as const;
      yield* Effect.forEach(failures, ({ error, expected }) =>
        Effect.gen(function* () {
          const operations = yield* makeOperations(
            { load: () => Effect.succeed(view) },
            makeBot(() => Effect.fail(error)),
          );
          expect(
            yield* Effect.flip(
              operations.respond(
                input,
                message,
                responseKey,
                SchedulesDeliverUserSchedule.authorizationPolicy.policy,
              ),
            ),
          ).toEqual(expected);
        }),
      );
    }),
  );

  it.effect("reads event, day schedule, player, and monitor data runner-locally", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const responses = [
        [
          {
            values: [
              ["User IDs", "'Players'!A1:A2"],
              ["User Sheet Names", "'Players'!B1:B2"],
              ["Moni IDs", "'Monitors'!A1:A1"],
              ["Moni Names", "'Monitors'!B1:B1"],
            ],
          },
          { values: [["Start Time", "1767225600"]] },
          {
            values: [
              [
                "main",
                "2",
                "Runner's Schedule",
                "A1:A3",
                "C1:C3",
                "D1:D3",
                "none",
                "B1:F3",
                "G1:G3",
                "H1:H3",
                undefined,
                undefined,
                "I1",
              ],
            ],
          },
          { values: [["Target", "1-3"]] },
        ],
        [
          { values: [["3"], ["2"], []] },
          { values: [["Target"], ["Other"], ["Target"]] },
          { values: [["Target"], [], ["Target"]] },
          { values: [["Other"], ["Target"], ["Target"]] },
          { values: [[false], [false], [false]] },
          { values: [["Monitor"], ["Monitor"], ["Monitor"]] },
          { values: [[true]] },
          { values: [["account-target"], ["account-other"]] },
          { values: [["Target"], ["Other"]] },
          { values: [["monitor-1"]] },
          { values: [["Monitor"]] },
        ],
      ] as const;
      let request = 0;
      const client = {
        spreadsheets: {
          values: {
            batchGet: ({ ranges = [] }: { readonly ranges?: ReadonlyArray<string> }) => {
              calls.push([...ranges]);
              return Promise.resolve({ data: { valueRanges: responses[request++] ?? [] } });
            },
          },
        },
      } as unknown as sheets_v4.Sheets;
      const loaded = yield* makeUserScheduleProvider(client).load("sheet-1", 2);
      expect(loaded).toEqual({
        eventStartEpochMs,
        players: [
          { accountId: "account-target", name: "Target" },
          { accountId: "account-other", name: "Other" },
        ],
        monitors: [{ accountId: "monitor-1", name: "Monitor" }],
        schedules: [
          {
            visible: true,
            hour: 3,
            break: false,
            fills: ["Target"],
            overfills: ["Target"],
            standbys: ["Other"],
            monitor: "Monitor",
          },
          {
            visible: true,
            hour: 2,
            break: false,
            fills: ["Other"],
            overfills: [],
            standbys: ["Target"],
            monitor: "Monitor",
          },
          {
            visible: true,
            hour: null,
            break: false,
            fills: ["Target"],
            overfills: ["Target"],
            standbys: ["Target"],
            monitor: "Monitor",
          },
        ],
      });
      expect(calls).toEqual([
        [
          "'Thee''s Sheet Settings'!B8:C",
          "'Thee''s Sheet Settings'!O8:P",
          "'Thee''s Sheet Settings'!R8:AE",
          "'Thee''s Sheet Settings'!AG8:AH",
        ],
        [
          "'Runner''s Schedule'!A1:A3",
          "'Runner''s Schedule'!B1:F3",
          "'Runner''s Schedule'!G1:G3",
          "'Runner''s Schedule'!H1:H3",
          "'Runner''s Schedule'!C1:C3",
          "'Runner''s Schedule'!D1:D3",
          "'Runner''s Schedule'!I1",
          "'Players'!A1:A2",
          "'Players'!B1:B2",
          "'Monitors'!A1:A1",
          "'Monitors'!B1:B1",
        ],
      ]);
    }),
  );

  it.live("retries transient provider reads but not permanent failures", () =>
    Effect.gen(function* () {
      let transientAttempts = 0;
      const transientClient = {
        spreadsheets: {
          values: {
            batchGet: () => {
              transientAttempts += 1;
              if (transientAttempts === 1) {
                return Promise.reject({ response: { status: 503 } });
              }
              return transientAttempts === 2
                ? Promise.resolve({
                    data: {
                      valueRanges: [
                        {
                          values: [
                            ["User IDs", "'Players'!A1:A1"],
                            ["User Sheet Names", "'Players'!B1:B1"],
                          ],
                        },
                        { values: [["Start Time", "1767225600"]] },
                        { values: [] },
                        { values: [] },
                      ],
                    },
                  })
                : Promise.resolve({
                    data: {
                      valueRanges: [{ values: [["account-target"]] }, { values: [["Target"]] }],
                    },
                  });
            },
          },
        },
      } as unknown as sheets_v4.Sheets;
      expect(yield* makeUserScheduleProvider(transientClient).load("sheet-1", 2)).toEqual({
        eventStartEpochMs,
        players: [{ accountId: "account-target", name: "Target" }],
        monitors: [],
        schedules: [],
      });
      expect(transientAttempts).toBe(3);

      let permanentAttempts = 0;
      const permanentFailure = yield* Effect.flip(
        makeUserScheduleProvider({
          spreadsheets: {
            values: {
              batchGet: () => {
                permanentAttempts += 1;
                return Promise.reject({ response: { status: 403 } });
              },
            },
          },
        } as unknown as sheets_v4.Sheets).load("sheet-1", 2),
      );
      expect(permanentFailure.operation).toBe("read-configuration");
      expect(permanentAttempts).toBe(1);
    }),
  );

  it("classifies timeouts as safe provider-read retries", () => {
    expect(
      isRetryableUserScheduleReadFailure(
        new UserScheduleProviderError({
          operation: "read-configuration",
          cause: new Cause.TimeoutError(),
        }),
      ),
    ).toBe(true);
  });

  it("materializes only typed Declared Failures and redacts system details", () => {
    const declared = {
      _tag: "ExternalOperationRejected" as const,
      operation: "schedules.deliverUserSchedule.loadUserSchedule",
      code: "ProviderRejected",
      message: "The schedule provider rejected the user schedule read",
    };
    expect(isScheduleSheetWorkflowName(workflow.name)).toBe(true);
    expect(materializeScheduleWorkflowFailure(workflow, Cause.fail(declared))).toEqual({
      _tag: "Declared",
      error: declared,
    });
    expect(
      materializeScheduleWorkflowFailure(workflow, Cause.die("google-service-account-secret")),
    ).toEqual({ _tag: "System", code: "UnexpectedFailure", retryable: false });
  });
});
