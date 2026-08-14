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
import { InteractiveDeclaredFailure, SlotsDeliverList } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  makeSheetApisClient,
  makeTrustedSheetPersistenceMock,
  normalizePayloadText,
  renderTextForTest,
} from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import {
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { makeSlotDeliveryKey } from "./keys";
import {
  executeSlotsDeliverListLoadAction,
  executeSlotsDeliverListRespondAction,
  makeSlotsDeliverListDefinition,
  makeSlotsDeliverListMessage,
  makeSlotsDeliverListWorkflowBody,
} from "./slotListDefinition";
import { slotListWorkflowOperationsLayer } from "./slotListOperations";
import {
  isRetryableSheetsReadFailure,
  makeSlotListProvider,
  SlotListProvider,
  SlotListProviderError,
} from "./slotListProvider";
import { SlotView } from "./slotListSchema";
import { SlotListWorkflowOperations } from "./slotListService";
import {
  isSlotSheetWorkflowName,
  materializeSlotWorkflowFailure,
  SlotSheetWorkflowDefinitions,
  SlotSheetWorkflows,
} from "./definitions";
import { SlotSheetWorkflowRegistrations } from "./registry";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const input = Schema.decodeUnknownSync(SlotsDeliverList.input)({
  workspaceId: "workspace-1",
  responseReference,
  day: 2,
  messageType: "persistent",
});
const eventStartEpochMs = Date.parse("2026-01-01T00:00:00.000Z");
const view: SlotView = {
  eventStartEpochMs,
  schedules: [
    { _tag: "Schedule", visible: true, hour: 2, filledSlots: 5, overfillSlots: 0 },
    { _tag: "Schedule", visible: true, hour: null, filledSlots: 0, overfillSlots: 0 },
    { _tag: "Break", visible: true, hour: 3 },
    { _tag: "Schedule", visible: true, hour: 1, filledSlots: 2, overfillSlots: 0 },
  ],
};
const responseKey = makeSlotDeliveryKey(SlotsDeliverList, invocationId, "respond");
const requiredEntry = <A>(entry: A | undefined, label: string): A =>
  Option.getOrThrowWith(Option.fromNullishOr(entry), () => new Error(`${label} is not registered`));
const isSlotListDefinition = (
  definition: (typeof SlotSheetWorkflowDefinitions)[number],
): definition is ReturnType<typeof makeSlotsDeliverListDefinition> =>
  definition.contract === SlotsDeliverList;
const slotListDefinition = requiredEntry(
  SlotSheetWorkflowDefinitions.find(isSlotListDefinition),
  "SlotsDeliverList definition",
);
const slotListRegistration = requiredEntry(
  SlotSheetWorkflowRegistrations.find(
    ({ contract }) => contract.identity === SlotsDeliverList.identity,
  ),
  "SlotsDeliverList registration",
);
const slotListWorkflow = requiredEntry(
  SlotSheetWorkflows.find(({ name }) => name === workflowContractKey(SlotsDeliverList)),
  "SlotsDeliverList workflow",
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
  overrides: Partial<TrustedSheetPersistence["Service"]["workspaces"]> = {},
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
  ...overrides,
});

const makeOperations = (provider: SlotListProvider["Service"], bot: SheetBotHttpClient) =>
  Effect.gen(function* () {
    const persistence = basePersistence();
    const workspaces = configuredWorkspaces(persistence.workspaces);
    return yield* SlotListWorkflowOperations.pipe(
      Effect.provide(slotListWorkflowOperationsLayer),
      Effect.provide(Layer.succeed(TrustedSheetPersistence, { ...persistence, workspaces })),
      Effect.provide(Layer.succeed(SlotListProvider, provider)),
      Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
    );
  });

describe("slot-list delivery Workflow Definition slice", () => {
  it("rejects non-finite event timestamps and schedule hours", () => {
    const nonFiniteValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const value of nonFiniteValues) {
      expect(Schema.is(SlotView)({ ...view, eventStartEpochMs: value })).toBe(false);
      expect(
        Schema.is(SlotView)({
          ...view,
          schedules: [{ ...view.schedules[0]!, hour: value }],
        }),
      ).toBe(false);
    }
  });

  it("registers the pinned definition with exactly the approved Durable Actions", () => {
    expect(slotListDefinition.contract).toBe(SlotsDeliverList);
    expect(slotListDefinition.workflow.name).toBe(workflowContractKey(SlotsDeliverList));
    expect(slotListDefinition.actions.map(({ workflow }) => workflow.name)).toEqual([
      "slots.deliverList.load-slot-view",
      "slots.deliverList.respond",
    ]);
    expect(slotListDefinition.contract.declaredFailure).toBe(InteractiveDeclaredFailure);
    expect(slotListRegistration.definitionVersion).toBe("1");
    expect(SlotsDeliverList.authorizationPolicy).toMatchObject({
      principalKinds: ["user"],
      requiredCapabilities: ["workspace.member"],
      resource: "workspace",
      resourceField: "workspaceId",
    });
  });

  it.effect("renders exact legacy embeds after missing-hour filtering and hour ordering", () =>
    Effect.gen(function* () {
      expect(normalizePayloadText(yield* makeSlotsDeliverListMessage(2, view))).toEqual({
        embeds: [
          {
            title: "Day 2 Open Slots",
            description: "+3 | hour 1 <t:1767225600:t> - <t:1767229200:t>",
          },
          {
            title: "Day 2 Filled Slots",
            description: "hour 2 <t:1767229200:t> - <t:1767232800:t>",
          },
          {
            description:
              "📅 Preview: View your schedule online at https://schedule.theerapakg.moe/",
            color: 0x5865f2,
          },
        ],
      });
    }),
  );

  it.effect("declares an invalid provider event timestamp instead of defecting", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          makeSlotsDeliverListMessage(2, { ...view, eventStartEpochMs: Number.POSITIVE_INFINITY }),
        ),
      ).toEqual({
        _tag: "ExternalOperationRejected",
        operation: "slots.deliverList.loadSlotView",
        code: "InvalidProviderResponse",
        message: "The schedule provider returned an invalid event start time",
      });
    }),
  );

  it.effect("bounds large slot lists to Discord embed limits", () =>
    Effect.gen(function* () {
      const message = yield* makeSlotsDeliverListMessage(2, {
        eventStartEpochMs,
        schedules: Array.from({ length: 500 }, (_, index) => ({
          _tag: "Schedule" as const,
          visible: true,
          hour: index + 1,
          filledSlots: index % 2 === 0 ? 0 : 5,
          overfillSlots: 0,
        })),
      });
      const embeds = message.embeds ?? [];
      const descriptions = embeds.map((embed) => renderTextForTest(embed.description) ?? "");
      const titles = embeds.map((embed) => renderTextForTest(embed.title) ?? "");

      expect(descriptions[0]).toContain("additional slots omitted");
      expect(descriptions[1]).toContain("additional slots omitted");
      expect(descriptions[0]!.length).toBeLessThanOrEqual(4_096);
      expect(descriptions[1]!.length).toBeLessThanOrEqual(4_096);
      expect(
        [...descriptions, ...titles].reduce((total, value) => total + value.length, 0),
      ).toBeLessThan(6_000);
    }),
  );

  it.effect("preserves persistent and ephemeral deferral parity without changing visibility", () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = [];
      const body = makeSlotsDeliverListWorkflowBody({
        load: () => Effect.succeed(view),
        respond: ({ message }) => {
          messages.push(message);
          return Effect.succeed(receipt);
        },
      });
      const persistent = yield* body({ invocationId, principal, input });
      const ephemeral = yield* body({
        invocationId,
        principal,
        input: { ...input, messageType: "ephemeral" },
      });
      expect(persistent).toEqual({
        workspaceId: "workspace-1",
        day: 2,
        messageType: "persistent",
        deliveryReceipts: [receipt],
      });
      expect(ephemeral).toEqual({
        ...persistent,
        messageType: "ephemeral",
      });
      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual(messages[0]);
      expect(messages[0]).not.toHaveProperty("visibility");
    }),
  );

  it.effect("uses deterministic Action Keys and an operation-specific Delivery Key", () =>
    Effect.gen(function* () {
      const message = yield* makeSlotsDeliverListMessage(input.day, view);
      const payload = {
        invocationId,
        principal,
        input,
        message,
      };
      const actionIds = yield* Effect.forEach(slotListDefinition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const replayIds = yield* Effect.forEach(slotListDefinition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const respondAction = requiredEntry(
        slotListDefinition.actions.find(
          ({ workflow }) => workflow.name === "slots.deliverList.respond",
        ),
        "SlotsDeliverList respond action",
      );
      const respondActionId = yield* respondAction.workflow.executionId(payload);
      const changedMessageId = yield* respondAction.workflow.executionId({
        ...payload,
        message: { content: "Changed presentation" },
      });
      expect(replayIds).toEqual(actionIds);
      expect(new Set(actionIds).size).toBe(2);
      expect(changedMessageId).toBe(respondActionId);
      expect(responseKey).toBe(`slots.deliverList:1:${invocationId}:respond`);
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
        authorizeSlotOpen: () => Effect.die("unused"),
        authorizeCheckinRespond: () => Effect.die("unused"),
        authorizeRoomOrdersNavigate: () => Effect.die("unused"),
        authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
        authorizeRoomOrdersSend: () => Effect.die("unused"),
        workspaceCapabilities: () => Effect.die("unused"),
      };
      const operations: SlotListWorkflowOperations["Service"] = {
        loadSlotView: () => {
          calls.push("load-slot-view");
          return Effect.succeed(view);
        },
        respond: () => {
          calls.push("respond");
          return Effect.succeed(receipt);
        },
      };
      const services = Layer.mergeAll(
        Layer.succeed(ReadOnlyWorkflowAuthorization, authorization),
        Layer.succeed(SlotListWorkflowOperations, operations),
      );
      yield* executeSlotsDeliverListLoadAction({ invocationId, principal, input }).pipe(
        Effect.provide(services),
      );
      const message = yield* makeSlotsDeliverListMessage(input.day, view);
      yield* executeSlotsDeliverListRespondAction({
        invocationId,
        principal,
        input,
        message,
      }).pipe(Effect.provide(services));
      expect(calls).toEqual(["authorize", "load-slot-view", "authorize", "respond"]);

      authorized = false;
      const replayFailure = yield* Effect.flip(
        executeSlotsDeliverListLoadAction({ invocationId, principal, input }).pipe(
          Effect.provide(services),
        ),
      );
      expect(replayFailure).toEqual({
        _tag: "AuthorizationRevoked",
        policy: SlotsDeliverList.authorizationPolicy.policy,
      });
      expect(calls).toEqual(["authorize", "load-slot-view", "authorize", "respond", "authorize"]);
    }),
  );

  it.effect("enforces owner isolation for workspace-member invocations", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: (contract: unknown, effectivePrincipal: unknown, value: unknown) => {
          calls.push({ contract, principal: effectivePrincipal, input: value });
          return Effect.void;
        },
        authorizeSlotOpen: () => Effect.die("unused"),
        authorizeCheckinRespond: () => Effect.die("unused"),
        authorizeRoomOrdersNavigate: () => Effect.die("unused"),
        authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
        authorizeRoomOrdersSend: () => Effect.die("unused"),
        workspaceCapabilities: () => Effect.die("unused"),
      };
      yield* slotListRegistration
        .authorize(context, input)
        .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
      expect(calls).toEqual([{ contract: SlotsDeliverList, principal, input }]);
      const isolation = yield* Effect.exit(
        slotListRegistration
          .authorizeObservation({
            ...context,
            ownerKey: "user:other",
          })
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

  it.effect("resolves the trusted workspace sheet across repeated reads after a failure", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      let attempt = 0;
      const provider: SlotListProvider["Service"] = {
        load: (spreadsheetId, day) => {
          calls.push({ spreadsheetId, day });
          attempt += 1;
          return attempt === 1
            ? Effect.fail(
                new SlotListProviderError({
                  operation: "read-day-schedules",
                  cause: "transient provider failure",
                }),
              )
            : Effect.succeed(view);
        },
      };
      const operations = yield* makeOperations(
        provider,
        makeBot(() => Effect.die("unused")),
      );
      expect(yield* Effect.flip(operations.loadSlotView(input))).toEqual({
        _tag: "ExternalOperationRejected",
        operation: "slots.deliverList.loadSlotView",
        code: "ProviderRejected",
        message: "The schedule provider rejected the slot view read",
      });
      expect(yield* operations.loadSlotView(input)).toEqual(view);
      expect(calls).toEqual([
        { spreadsheetId: "sheet-1", day: 2 },
        { spreadsheetId: "sheet-1", day: 2 },
      ]);
    }),
  );

  it.effect(
    "reconciles ambiguous delivery with one Delivery Key and declares rejection pre-commit",
    () =>
      Effect.gen(function* () {
        const keys: Array<typeof DeliveryKey.Type> = [];
        let attempt = 0;
        const bot = makeBot(({ payload }) => {
          keys.push(payload.deliveryKey);
          attempt += 1;
          return attempt === 1
            ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous outcome" }))
            : Effect.succeed(receipt);
        });
        const operations = yield* makeOperations({ load: () => Effect.succeed(view) }, bot);
        const message = yield* makeSlotsDeliverListMessage(input.day, view);
        const ambiguousFailure = yield* Effect.flip(
          operations.respond(
            input,
            message,
            responseKey,
            SlotsDeliverList.authorizationPolicy.policy,
          ),
        );
        expect(ambiguousFailure).toMatchObject({
          _tag: "SlotListWorkflowOperationsError",
          operation: "slots.deliverList.respond",
          cause: {
            _tag: "BotDependencyUnavailable",
            message: "ambiguous outcome",
          },
        });
        expect(
          yield* operations.respond(
            input,
            message,
            responseKey,
            SlotsDeliverList.authorizationPolicy.policy,
          ),
        ).toEqual(receipt);
        expect(keys).toEqual([responseKey, responseKey]);

        const deliveryFailures = [
          {
            error: new BotResponseExpired({ message: "expired secret" }),
            expected: {
              _tag: "DeliveryRejected",
              operation: "slots.deliverList.respond",
              message: "The response is no longer available",
              recoveryRequired: false,
            },
          },
          {
            error: new BotRequestRejected({ message: "rejected secret" }),
            expected: {
              _tag: "DeliveryRejected",
              operation: "slots.deliverList.respond",
              message: "The slot list response was rejected",
              recoveryRequired: false,
            },
          },
          {
            error: new BotAdmissionDenied({ message: "membership revoked" }),
            expected: {
              _tag: "AuthorizationRevoked",
              policy: SlotsDeliverList.authorizationPolicy.policy,
            },
          },
          {
            error: new BotResourceNotFound({
              resource: "response",
              message: "response is unavailable",
            }),
            expected: {
              _tag: "ResourceNotFound",
              resource: "response",
            },
          },
        ] as const;
        yield* Effect.forEach(deliveryFailures, ({ error, expected }) =>
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
                  SlotsDeliverList.authorizationPolicy.policy,
                ),
              ),
            ).toEqual(expected);
          }),
        );
      }),
  );

  it.effect("reads only the configured event and day schedule ranges runner-locally", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly ranges: ReadonlyArray<string>;
        readonly valueRenderOption: string | undefined;
        readonly dateTimeRenderOption: string | undefined;
      }> = [];
      const responses = [
        [
          { values: [["Start Time", "1767225600"]] },
          {
            values: [
              [
                "main",
                "2",
                "Runner's Schedule",
                "A1:A3",
                "auto",
                undefined,
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
          {
            values: [
              ["runner", "1-2"],
              ["Runner", "3-3"],
            ],
          },
        ],
        [
          { values: [["3"], [], ["1"]] },
          {
            values: [["runner", "B", "C", "D", "E"], ["runner"], ["runner", "B"]],
          },
          { values: [[], ["X"], []] },
          { values: [[true]] },
        ],
      ] as const;
      let request = 0;
      const client = {
        spreadsheets: {
          values: {
            batchGet: ({
              dateTimeRenderOption,
              ranges,
              valueRenderOption,
            }: {
              readonly ranges?: ReadonlyArray<string>;
              readonly valueRenderOption?: string;
              readonly dateTimeRenderOption?: string;
            }) => {
              calls.push({
                ranges: ranges ?? [],
                valueRenderOption,
                dateTimeRenderOption,
              });
              const valueRanges = responses[request++] ?? [];
              return Promise.resolve({ data: { valueRanges } });
            },
          },
        },
      } as unknown as sheets_v4.Sheets;
      const provider = makeSlotListProvider(client);
      expect(yield* provider.load("sheet-1", 2)).toEqual({
        eventStartEpochMs,
        schedules: [
          { _tag: "Schedule", visible: true, hour: 3, filledSlots: 5, overfillSlots: 0 },
          { _tag: "Break", visible: true, hour: null },
          { _tag: "Schedule", visible: true, hour: 1, filledSlots: 2, overfillSlots: 0 },
        ],
      });
      expect(calls).toEqual([
        {
          ranges: [
            "'Thee''s Sheet Settings'!O8:P",
            "'Thee''s Sheet Settings'!R8:AE",
            "'Thee''s Sheet Settings'!AG8:AH",
          ],
          valueRenderOption: "UNFORMATTED_VALUE",
          dateTimeRenderOption: "SERIAL_NUMBER",
        },
        {
          ranges: [
            "'Runner''s Schedule'!A1:A3",
            "'Runner''s Schedule'!B1:F3",
            "'Runner''s Schedule'!G1:G3",
            "'Runner''s Schedule'!I1",
          ],
          valueRenderOption: "UNFORMATTED_VALUE",
          dateTimeRenderOption: "SERIAL_NUMBER",
        },
      ]);
    }),
  );

  it.effect("batches day schedule ranges without changing their planned order", () =>
    Effect.gen(function* () {
      const configurationRows = Array.from({ length: 26 }, (_, index) => [
        `main-${index}`,
        "2",
        `Schedule ${index}`,
        "A1:A1",
        "auto",
        undefined,
        "none",
        "B1:B1",
        "C1:C1",
        "D1:D1",
        undefined,
        undefined,
        "E1",
      ]);
      const expectedScheduleRanges = configurationRows.flatMap((_, index) => [
        `'Schedule ${index}'!A1:A1`,
        `'Schedule ${index}'!B1:B1`,
        `'Schedule ${index}'!C1:C1`,
        `'Schedule ${index}'!E1`,
      ]);
      const calls: Array<ReadonlyArray<string>> = [];
      let request = 0;
      const client = {
        spreadsheets: {
          values: {
            batchGet: ({ ranges = [] }: { readonly ranges?: ReadonlyArray<string> }) => {
              calls.push([...ranges]);
              request += 1;
              return Promise.resolve({
                data:
                  request === 1
                    ? {
                        valueRanges: [
                          { values: [["Start Time", "1767225600"]] },
                          { values: configurationRows },
                          { values: [] },
                        ],
                      }
                    : {
                        valueRanges: ranges.map((range) => ({
                          values: range.endsWith("A1:A1")
                            ? [[String(expectedScheduleRanges.indexOf(range))]]
                            : [],
                        })),
                      },
              });
            },
          },
        },
      } as unknown as sheets_v4.Sheets;

      expect(yield* makeSlotListProvider(client).load("sheet-1", 2)).toEqual({
        eventStartEpochMs,
        schedules: configurationRows.map((_, index) => ({
          _tag: "Break",
          visible: true,
          hour: index * 4,
        })),
      });
      expect(calls.map(({ length }) => length)).toEqual([3, 100, 4]);
      expect(calls.slice(1).flat().sort()).toEqual(expectedScheduleRanges.slice().sort());
    }),
  );

  it.effect("rejects malformed Google Sheets rows at the provider boundary", () =>
    Effect.gen(function* () {
      const client = {
        spreadsheets: {
          values: {
            batchGet: () =>
              Promise.resolve({
                data: {
                  valueRanges: [
                    { values: [[{ malformed: true }]] },
                    { values: [] },
                    { values: [] },
                  ],
                },
              }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const failure = yield* Effect.flip(makeSlotListProvider(client).load("sheet-1", 2));
      expect(failure._tag).toBe("SlotListProviderError");
      expect(failure.operation).toBe("read-configuration");
    }),
  );

  it.effect("rejects incomplete batch responses before range indexes can shift", () =>
    Effect.gen(function* () {
      const client = {
        spreadsheets: {
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: [{}, {}] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;
      const failure = yield* Effect.flip(makeSlotListProvider(client).load("sheet-1", 2));
      expect(failure.operation).toBe("read-configuration");
      expect(String(failure.cause)).toContain("Expected 3 value ranges, received 2");
    }),
  );

  it.live("retries only transient Sheets failures with the same ranges", () =>
    Effect.gen(function* () {
      const transientFailures = [
        { response: { status: 408 } },
        { response: { status: 429 } },
        { response: { status: 503 } },
        { code: "ECONNREFUSED" },
        { code: "ECONNRESET" },
        { code: "ENOTFOUND" },
      ] as const;
      yield* Effect.forEach(transientFailures, (transientFailure) =>
        Effect.gen(function* () {
          const calls: Array<ReadonlyArray<string>> = [];
          const client = {
            spreadsheets: {
              values: {
                batchGet: ({ ranges = [] }: { readonly ranges?: ReadonlyArray<string> }) => {
                  calls.push([...ranges]);
                  return calls.length === 1
                    ? Promise.reject(transientFailure)
                    : Promise.resolve({
                        data: {
                          valueRanges: [
                            { values: [["Start Time", "1767225600"]] },
                            { values: [] },
                            { values: [] },
                          ],
                        },
                      });
                },
              },
            },
          } as unknown as sheets_v4.Sheets;

          expect(yield* makeSlotListProvider(client).load("sheet-1", 2)).toEqual({
            eventStartEpochMs,
            schedules: [],
          });
          expect(calls).toEqual([
            [
              "'Thee''s Sheet Settings'!O8:P",
              "'Thee''s Sheet Settings'!R8:AE",
              "'Thee''s Sheet Settings'!AG8:AH",
            ],
            [
              "'Thee''s Sheet Settings'!O8:P",
              "'Thee''s Sheet Settings'!R8:AE",
              "'Thee''s Sheet Settings'!AG8:AH",
            ],
          ]);
        }),
      );

      let permanentAttempts = 0;
      const permanentFailure = yield* Effect.flip(
        makeSlotListProvider({
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

      let exhaustedAttempts = 0;
      const exhaustedFailure = yield* Effect.flip(
        makeSlotListProvider({
          spreadsheets: {
            values: {
              batchGet: () => {
                exhaustedAttempts += 1;
                return Promise.reject({ response: { status: 503 } });
              },
            },
          },
        } as unknown as sheets_v4.Sheets).load("sheet-1", 2),
      );
      expect(exhaustedFailure.operation).toBe("read-configuration");
      expect(exhaustedAttempts).toBe(3);
    }),
  );

  it("retries a mapped timeout failure", () => {
    expect(
      isRetryableSheetsReadFailure(
        new SlotListProviderError({
          operation: "read-configuration",
          cause: new Cause.TimeoutError(),
        }),
      ),
    ).toBe(true);
  });

  it.effect("reports schema details for invalid schedule and runner configuration", () =>
    Effect.gen(function* () {
      const cases = [
        {
          scheduleRows: [
            [
              "main",
              "2",
              "Schedule",
              "A1:A3",
              "auto",
              undefined,
              "unsupported",
              "B1:F3",
              "G1:G3",
              "H1:H3",
              undefined,
              undefined,
              "I1",
            ],
          ],
          runnerRows: [],
          expected: "Invalid schedule encoding type: unsupported",
        },
        {
          scheduleRows: [],
          runnerRows: [["Runner", "9-3"]],
          expected: "Invalid runner hour range: 9-3",
        },
      ] as const;
      yield* Effect.forEach(cases, ({ expected, runnerRows, scheduleRows }) =>
        Effect.gen(function* () {
          const client = {
            spreadsheets: {
              values: {
                batchGet: () =>
                  Promise.resolve({
                    data: {
                      valueRanges: [
                        { values: [["Start Time", "1767225600"]] },
                        { values: scheduleRows },
                        { values: runnerRows },
                      ],
                    },
                  }),
              },
            },
          } as unknown as sheets_v4.Sheets;
          const failure = yield* Effect.flip(makeSlotListProvider(client).load("sheet-1", 2));
          expect(failure.operation).toBe("read-configuration");
          expect(String(failure.cause)).toContain(expected);
        }),
      );
    }),
  );

  it("materializes only typed Declared Failures and redacts system details", () => {
    const declared = {
      _tag: "ExternalOperationRejected" as const,
      operation: "slots.deliverList.loadSlotView",
      code: "ProviderRejected",
      message: "The schedule provider rejected the slot view read",
    };
    expect(isSlotSheetWorkflowName(slotListWorkflow.name)).toBe(true);
    expect(materializeSlotWorkflowFailure(slotListWorkflow, Cause.fail(declared))).toEqual({
      _tag: "Declared",
      error: declared,
    });
    expect(
      materializeSlotWorkflowFailure(slotListWorkflow, Cause.die("google-service-account-secret")),
    ).toEqual({ _tag: "System", code: "UnexpectedFailure", retryable: false });
  });
});
