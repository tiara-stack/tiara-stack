import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  BotAdmissionDenied,
  BotDependencyUnavailable,
  BotResourceNotFound,
  BotResponseExpired,
  DeliveryKey,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { InteractiveDeclaredFailure, SlotsOpen, WorkspaceId } from "sheet-workflow-contracts";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  makeSheetApisClient,
  makeTrustedSheetPersistenceMock,
  normalizePayloadText,
} from "@/services/testHelpers";
import {
  ReadOnlyWorkflowAuthorization,
  readOnlyWorkflowAuthorizationLayer,
  type AuthorizedSlotOpenContext,
} from "../readOnly/authorization";
import {
  workflowTestContext as invocationContext,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { SlotSheetWorkflowContracts } from "./catalog";
import {
  isSlotSheetWorkflowName,
  materializeSlotWorkflowFailure,
  SlotSheetWorkflowDefinitions,
  SlotSheetWorkflows,
} from "./definitions";
import { makeSlotDeliveryKey } from "./keys";
import { SlotListProvider, SlotListProviderError } from "./slotListProvider";
import type { SlotView } from "./slotListSchema";
import {
  executeSlotsOpenLoadAction,
  executeSlotsOpenRespondAction,
  makeSlotsOpenDefinition,
  makeSlotsOpenMessage,
  makeSlotsOpenWorkflowBody,
} from "./slotOpenDefinition";
import { slotOpenWorkflowOperationsLayer } from "./slotOpenOperations";
import { SlotOpenWorkflowOperations } from "./slotOpenService";
import { SlotSheetWorkflowRegistrations } from "./registry";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-slot-open");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const input = Schema.decodeUnknownSync(SlotsOpen.input)({
  responseReference,
  messageId: "message-1",
});
const slotContext: AuthorizedSlotOpenContext = {
  clientPlatform: "discord",
  clientId: "discord-main",
  messageId: "message-1",
  workspaceId,
  conversationId: "conversation-1",
  day: 2,
};
const eventStartEpochMs = Date.parse("2026-01-01T00:00:00.000Z");
const view: SlotView = {
  eventStartEpochMs,
  schedules: [
    { _tag: "Schedule", visible: true, hour: 2, filledSlots: 5, overfillSlots: 0 },
    { _tag: "Break", visible: true, hour: 3 },
    { _tag: "Schedule", visible: true, hour: 1, filledSlots: 2, overfillSlots: 0 },
  ],
};
const responseKey = makeSlotDeliveryKey(SlotsOpen, invocationId, "respond");
const receipt = {
  deliveryKey: responseKey,
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};
const slotRow: {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
  readonly day: number;
  readonly createdByUserId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
} = {
  ...slotContext,
  createdByUserId: "creator-1",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

const requiredEntry = <A>(entry: A | undefined, label: string): A =>
  Option.getOrThrowWith(Option.fromNullishOr(entry), () => new Error(`${label} is not registered`));

const definition = requiredEntry(
  SlotSheetWorkflowDefinitions.find(({ contract }) => contract.identity === SlotsOpen.identity),
  "SlotsOpen definition",
) as ReturnType<typeof makeSlotsOpenDefinition>;
const registration = requiredEntry(
  SlotSheetWorkflowRegistrations.find(({ contract }) => contract.identity === SlotsOpen.identity),
  "SlotsOpen registration",
);

const makeAuthorizationBot = (
  getMember: (request: unknown) => Effect.Effect<unknown, unknown> = () =>
    Effect.succeed({ userId: principal.discordAccount.accountId, roleIds: [] }),
): SheetBotHttpClient =>
  ({
    cache: {
      getApplication: () => Effect.succeed({ ownerId: "application-owner" }),
      getMember,
      getWorkspace: () =>
        Effect.succeed({
          id: "workspace-1",
          name: "Workspace One",
          icon: null,
          ownerId: "workspace-owner",
        }),
      listRoles: () => Effect.succeed([]),
    },
  }) as unknown as SheetBotHttpClient;

const makeAuthorization = (options: {
  readonly row?: Option.Option<typeof slotRow>;
  readonly getMember?: (request: unknown) => Effect.Effect<unknown, unknown>;
  readonly onLookup?: (args: {
    readonly clientPlatform: string;
    readonly clientId: string;
    readonly messageId: string;
  }) => void;
}) => {
  const persistence = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
  const row = options.row ?? Option.some(slotRow);
  return Effect.gen(function* () {
    return yield* ReadOnlyWorkflowAuthorization;
  }).pipe(
    Effect.provide(readOnlyWorkflowAuthorizationLayer),
    Effect.provide(
      Layer.succeed(SheetBotCacheClient, {
        get: () => makeAuthorizationBot(options.getMember),
      }),
    ),
    Effect.provide(
      Layer.succeed(TrustedSheetPersistence, {
        ...persistence,
        workspaces: {
          ...persistence.workspaces,
          getWorkspaceMonitorRoles: () => Effect.succeed([]),
        },
        slotState: {
          ...persistence.slotState,
          getMessageSlotData: (args) => {
            options.onLookup?.(args);
            return Effect.succeed(row);
          },
        },
      }),
    ),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ sheetBotClientId: slotContext.clientId })),
    ),
  );
};

const makeDeliveryBot = (
  respond: (request: {
    readonly payload: {
      readonly responseReference: typeof ResponseReference.Type;
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly message: unknown;
    };
  }) => Effect.Effect<unknown, unknown>,
): SheetBotHttpClient => ({ delivery: { respond } }) as unknown as SheetBotHttpClient;

const makeOperations = (provider: SlotListProvider["Service"], bot: SheetBotHttpClient) => {
  const persistence = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
  return Effect.gen(function* () {
    return yield* SlotOpenWorkflowOperations;
  }).pipe(
    Effect.provide(slotOpenWorkflowOperationsLayer),
    Effect.provide(
      Layer.succeed(TrustedSheetPersistence, {
        ...persistence,
        workspaces: {
          ...persistence.workspaces,
          getWorkspaceConfigByWorkspaceId: () =>
            Effect.succeed(
              Option.some({
                workspaceId: slotContext.workspaceId,
                sheetId: "sheet-1",
                autoCheckin: null,
                monitorConversationId: null,
                createdAt: 1,
                updatedAt: 1,
                deletedAt: null,
              }),
            ),
        },
      }),
    ),
    Effect.provide(Layer.succeed(SlotListProvider, provider)),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
  );
};

describe("slot-open button Workflow Definition slice", () => {
  it("publishes and registers the pinned contract with exactly two v1 Durable Actions", () => {
    expect(SlotsOpen.wireVersion).toBe("1");
    expect(SlotsOpen.authorizationPolicy).toMatchObject({
      version: "2",
      principalKinds: ["user"],
      requiredCapabilities: ["workspace.member"],
      resource: "message",
      resourceField: "messageId",
      revalidateBeforeEffects: true,
    });
    expect(Object.keys(SlotsOpen.input.fields)).toEqual(["responseReference", "messageId"]);
    expect(definition.contract).toBe(SlotsOpen);
    expect(definition.workflow.name).toBe(workflowContractKey(SlotsOpen));
    expect(definition.actions.map(({ workflow }) => workflow.name)).toEqual([
      "slots.open.load-slot-view",
      "slots.open.respond",
    ]);
    expect(definition.contract.declaredFailure).toBe(InteractiveDeclaredFailure);
    expect(registration.definitionVersion).toBe("1");
    expect(SlotSheetWorkflowContracts.at(-1)).toBe(SlotsOpen);
    expect(isSlotSheetWorkflowName(workflowContractKey(SlotsOpen))).toBe(true);
    expect(SlotSheetWorkflows.some(({ name }) => name === workflowContractKey(SlotsOpen))).toBe(
      true,
    );
  });

  it.effect("resolves only the canonical registered message and current workspace membership", () =>
    Effect.gen(function* () {
      const lookups: Array<unknown> = [];
      const authorization = yield* makeAuthorization({
        onLookup: (args) => lookups.push(args),
      });
      expect(yield* authorization.authorizeSlotOpen(principal, input)).toEqual(slotContext);
      yield* registration
        .authorize(invocationContext, input)
        .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
      expect(lookups).toEqual([
        {
          clientPlatform: "discord",
          clientId: "discord-main",
          messageId: "message-1",
        },
        {
          clientPlatform: "discord",
          clientId: "discord-main",
          messageId: "message-1",
        },
      ]);
    }),
  );

  it.effect(
    "fails closed for unlinked, service, non-member, missing, legacy, and cross-client state",
    () =>
      Effect.gen(function* () {
        const servicePrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "sheet-bot.gateway",
          oauthClientId: "sheet-bot-client",
        });
        const cases = [
          {
            principal: { ...principal, discordAccount: undefined },
            authorization: yield* makeAuthorization({}),
          },
          { principal: servicePrincipal, authorization: yield* makeAuthorization({}) },
          {
            principal,
            authorization: yield* makeAuthorization({
              getMember: () =>
                Effect.fail(
                  new BotResourceNotFound({ resource: "member", message: "not a member" }),
                ),
            }),
          },
          { principal, authorization: yield* makeAuthorization({ row: Option.none() }) },
          {
            principal,
            authorization: yield* makeAuthorization({
              row: Option.some({ ...slotRow, workspaceId: null }),
            }),
          },
          {
            principal,
            authorization: yield* makeAuthorization({
              row: Option.some({ ...slotRow, conversationId: null }),
            }),
          },
          {
            principal,
            authorization: yield* makeAuthorization({
              row: Option.some({ ...slotRow, clientId: "discord-other" }),
            }),
          },
        ] as const;

        for (const candidate of cases) {
          const exit = yield* Effect.exit(
            candidate.authorization.authorizeSlotOpen(candidate.principal, input),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
              _tag: "WorkflowInvocationUnauthorized",
              message: "Workflow invocation is unauthorized",
            });
          }
        }
      }),
  );

  it.effect("renders the exact ephemeral legacy slot-button response without the web promo", () =>
    Effect.gen(function* () {
      expect(normalizePayloadText(yield* makeSlotsOpenMessage(slotContext.day, view))).toEqual({
        embeds: [
          {
            title: "Day 2 Open Slots",
            description: "+3 | hour 1 <t:1767225600:t> - <t:1767229200:t>",
          },
          {
            title: "Day 2 Filled Slots",
            description: "hour 2 <t:1767229200:t> - <t:1767232800:t>",
          },
        ],
        visibility: "ephemeral",
      });
    }),
  );

  it.effect("attributes invalid provider timestamps to the slot-open operation", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          makeSlotsOpenMessage(slotContext.day, {
            ...view,
            eventStartEpochMs: Number.POSITIVE_INFINITY,
          }),
        ),
      ).toEqual({
        _tag: "ExternalOperationRejected",
        operation: "slots.open.loadSlotView",
        code: "InvalidProviderResponse",
        message: "The schedule provider returned an invalid event start time",
      });
    }),
  );

  it.effect(
    "derives success only from the stored slot context and commits at response delivery",
    () =>
      Effect.gen(function* () {
        const messages: Array<unknown> = [];
        const body = makeSlotsOpenWorkflowBody({
          load: () => Effect.succeed({ context: slotContext, view }),
          respond: ({ context, message }) => {
            expect(context).toEqual(slotContext);
            messages.push(message);
            return Effect.succeed(receipt);
          },
        });
        expect(yield* body({ invocationId, principal, input })).toEqual({
          messageId: slotContext.messageId,
          workspaceId: slotContext.workspaceId,
          day: slotContext.day,
          deliveryReceipts: [receipt],
        });
        expect(messages).toHaveLength(1);
      }),
  );

  it.effect("reauthorizes before each privileged action and rejects changed message binding", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let currentContext = slotContext;
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: () => Effect.die("unused"),
        authorizeSlotOpen: () => {
          calls.push("authorize");
          return Effect.succeed(currentContext);
        },
        authorizeCheckinRespond: () => Effect.die("unused"),
        authorizeRoomOrdersNavigate: () => Effect.die("unused"),
        authorizeRoomOrdersSend: () => Effect.die("unused"),
        workspaceCapabilities: () => Effect.die("unused"),
      };
      const operations: SlotOpenWorkflowOperations["Service"] = {
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
        Layer.succeed(SlotOpenWorkflowOperations, operations),
      );
      const loaded = yield* executeSlotsOpenLoadAction({ invocationId, principal, input }).pipe(
        Effect.provide(services),
      );
      const message = yield* makeSlotsOpenMessage(slotContext.day, view);
      yield* executeSlotsOpenRespondAction({
        invocationId,
        principal,
        input,
        context: loaded.context,
        message,
      }).pipe(Effect.provide(services));
      expect(calls).toEqual(["authorize", "load-slot-view", "authorize", "respond"]);

      currentContext = { ...slotContext, day: 3 };
      expect(
        yield* Effect.flip(
          executeSlotsOpenRespondAction({
            invocationId,
            principal,
            input,
            context: loaded.context,
            message,
          }).pipe(Effect.provide(services)),
        ),
      ).toEqual({
        _tag: "AuthorizationRevoked",
        policy: SlotsOpen.authorizationPolicy.policy,
      });
      expect(calls.at(-1)).toBe("authorize");
    }),
  );

  it.effect("uses deterministic Action Keys and an operation-specific Delivery Key", () =>
    Effect.gen(function* () {
      const message = yield* makeSlotsOpenMessage(slotContext.day, view);
      const payload = { invocationId, principal, input, context: slotContext, message };
      const actionIds = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const replayIds = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const respondAction = requiredEntry(
        definition.actions.find(({ workflow }) => workflow.name === "slots.open.respond"),
        "SlotsOpen respond action",
      );
      expect(replayIds).toEqual(actionIds);
      expect(new Set(actionIds).size).toBe(2);
      expect(
        yield* respondAction.workflow.executionId({
          ...payload,
          message: { content: "Changed presentation" },
        }),
      ).toBe(yield* respondAction.workflow.executionId(payload));
      expect(responseKey).toBe(`slots.open:1:${invocationId}:respond`);
    }),
  );

  it.effect("maps provider rejection and reloads through the same trusted context", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      let attempt = 0;
      const operations = yield* makeOperations(
        {
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
        },
        makeDeliveryBot(() => Effect.die("unused")),
      );
      expect(yield* Effect.flip(operations.loadSlotView(slotContext))).toEqual({
        _tag: "ExternalOperationRejected",
        operation: "slots.open.loadSlotView",
        code: "ProviderRejected",
        message: "The schedule provider rejected the slot view read",
      });
      expect(yield* operations.loadSlotView(slotContext)).toEqual(view);
      expect(calls).toEqual([
        { spreadsheetId: "sheet-1", day: 2 },
        { spreadsheetId: "sheet-1", day: 2 },
      ]);
    }),
  );

  it.effect("reconciles ambiguous delivery with one key and maps typed terminal failures", () =>
    Effect.gen(function* () {
      const keys: Array<typeof DeliveryKey.Type> = [];
      let attempt = 0;
      const operations = yield* makeOperations(
        { load: () => Effect.succeed(view) },
        makeDeliveryBot(({ payload }) => {
          keys.push(payload.deliveryKey);
          attempt += 1;
          return attempt === 1
            ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous outcome" }))
            : Effect.succeed(receipt);
        }),
      );
      const message = yield* makeSlotsOpenMessage(slotContext.day, view);
      expect(
        yield* Effect.flip(
          operations.respond(input, message, responseKey, SlotsOpen.authorizationPolicy.policy),
        ),
      ).toMatchObject({
        _tag: "SlotOpenWorkflowOperationsError",
        operation: "slots.open.respond",
        cause: { _tag: "BotDependencyUnavailable", message: "ambiguous outcome" },
      });
      expect(
        yield* operations.respond(
          input,
          message,
          responseKey,
          SlotsOpen.authorizationPolicy.policy,
        ),
      ).toEqual(receipt);
      expect(keys).toEqual([responseKey, responseKey]);

      const typedFailures = [
        {
          error: new BotResponseExpired({ message: "expired" }),
          expected: {
            _tag: "DeliveryRejected",
            operation: "slots.open.respond",
            message: "The response is no longer available",
            recoveryRequired: false,
          },
        },
        {
          error: new BotAdmissionDenied({ message: "membership revoked" }),
          expected: {
            _tag: "AuthorizationRevoked",
            policy: SlotsOpen.authorizationPolicy.policy,
          },
        },
      ] as const;
      yield* Effect.forEach(typedFailures, ({ error, expected }) =>
        Effect.gen(function* () {
          const failing = yield* makeOperations(
            { load: () => Effect.succeed(view) },
            makeDeliveryBot(() => Effect.fail(error)),
          );
          expect(
            yield* Effect.flip(
              failing.respond(input, message, responseKey, SlotsOpen.authorizationPolicy.policy),
            ),
          ).toEqual(expected);
        }),
      );
    }),
  );

  it.effect("preserves owner isolation and stable failure materialization", () =>
    Effect.gen(function* () {
      const authorization = yield* makeAuthorization({});
      const exit = yield* Effect.exit(
        registration
          .authorizeObservation({ ...invocationContext, ownerKey: "user:other" })
          .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
          message: "Workflow owner does not match the effective principal",
        });
      }
      expect(
        materializeSlotWorkflowFailure(
          definition.workflow,
          Cause.fail({
            _tag: "AuthorizationRevoked",
            policy: SlotsOpen.authorizationPolicy.policy,
          }),
        ),
      ).toEqual({
        _tag: "Declared",
        error: {
          _tag: "AuthorizationRevoked",
          policy: SlotsOpen.authorizationPolicy.policy,
        },
      });
      const systemFailure = materializeSlotWorkflowFailure(
        definition.workflow,
        Cause.fail(new WorkflowInvocationUnauthorized({ message: "private detail" })),
      );
      expect(systemFailure).toMatchObject({ _tag: "System" });
      expect(JSON.stringify(systemFailure)).not.toContain("private detail");
    }),
  );
});
