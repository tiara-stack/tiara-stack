import { expect, layer } from "@effect/vitest";
import { Cause, Context, Effect, Exit, HashSet, Layer, Option, Redacted, Schema } from "effect";
import { CheckinHandleButtonError } from "sheet-ingress-api/dispatch";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import { vi } from "vitest";
import { AuthorizationService } from "../../services/authorization";
import { MessageLookup } from "../../services/messageLookup";
import { SheetWorkflowsForwardingClient } from "../../services/sheetWorkflowsForwardingClient";
import { dispatchHandlers } from "./dispatch";

type TestRouteHandler = (
  args: Record<string, unknown>,
) => Effect.Effect<
  unknown,
  unknown,
  AuthorizationService | MessageLookup | SheetAuthUser | SheetWorkflowsForwardingClient
>;

const testUser: Context.Service.Shape<typeof SheetAuthUser> = {
  accountId: "discord-user-1",
  userId: "user-1",
  permissions: HashSet.empty(),
  scopes: new Set(),
  token: Redacted.make("test-token"),
  tokenType: "session",
};

const messageLookup: Context.Service.Shape<typeof MessageLookup> = {
  getMessageCheckinData: () => Effect.succeed(Option.none()),
  getMessageCheckinMembers: () => Effect.succeed([]),
  getMessageRoomOrder: () => Effect.succeed(Option.none()),
  getMessageSlotData: () => Effect.succeed(Option.none()),
};

const TestLayer = Layer.mergeAll(
  Layer.succeed(MessageLookup, messageLookup),
  Layer.succeed(SheetAuthUser, testUser),
);

const getDispatchRoute = (name: "autoCheckinTest" | "checkinButton" | "kick") => {
  const routes = new Map<string, TestRouteHandler>();
  const handlers = {
    handle(routeName: string, handler: unknown) {
      routes.set(routeName, handler as TestRouteHandler);
      return this;
    },
  };
  dispatchHandlers.dispatch(handlers as unknown as Parameters<typeof dispatchHandlers.dispatch>[0]);
  const route = routes.get(name);
  if (route === undefined) {
    throw new Error(`Dispatch route ${name} was not registered`);
  }
  return route;
};

const runRoute = (
  name: "autoCheckinTest" | "checkinButton" | "kick",
  payload: Record<string, unknown>,
  authorizationService: Context.Service.Shape<typeof AuthorizationService>,
  forwardingClient: Context.Service.Shape<typeof SheetWorkflowsForwardingClient>,
) =>
  getDispatchRoute(name)({ payload }).pipe(
    Effect.provideService(AuthorizationService, authorizationService),
    Effect.provideService(SheetWorkflowsForwardingClient, forwardingClient),
  );

layer(TestLayer)("dispatch handlers", (it) => {
  it.effect("returns a transport-safe error when a check-in message is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runRoute(
          "checkinButton",
          {
            client: { platform: "discord", clientId: "discord-main" },
            messageId: "missing-message-1",
            interactionResponseToken: "interaction-token-1",
            interactionResponseDeadlineEpochMs: Date.now() + 60_000,
          },
          {} as Context.Service.Shape<typeof AuthorizationService>,
          { dispatch: {} } as unknown as Context.Service.Shape<
            typeof SheetWorkflowsForwardingClient
          >,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(Option.getOrNull(error)).toMatchObject({
        _tag: "ArgumentError",
        message: "Cannot get message checkin data, the message might not be registered",
        cause: undefined,
      });
      if (Option.isSome(error)) {
        yield* Schema.encodeUnknownEffect(CheckinHandleButtonError)(error.value);
      }
    }),
  );

  it.effect("forwards monitor authorization for auto-check-in tests", () =>
    Effect.gen(function* () {
      const requireMonitorWorkspace: Context.Service.Shape<
        typeof AuthorizationService
      >["requireMonitorWorkspace"] = vi.fn(() => Effect.as(SheetAuthUser, undefined));
      const autoCheckinTest = vi.fn(() => Effect.succeed({ status: "accepted" }));
      const payload = {
        client: { platform: "discord", clientId: "discord-main" },
        dispatchRequestId: "dispatch-auto-checkin-test",
        workspaceId: "workspace-1",
        anchorConversationId: "conversation-1",
      };

      yield* runRoute(
        "autoCheckinTest",
        payload,
        { requireMonitorWorkspace } as unknown as Context.Service.Shape<
          typeof AuthorizationService
        >,
        { dispatch: { autoCheckinTest } } as unknown as Context.Service.Shape<
          typeof SheetWorkflowsForwardingClient
        >,
      );

      expect(requireMonitorWorkspace).toHaveBeenCalledWith("workspace-1");
      expect(autoCheckinTest).toHaveBeenCalledWith({
        requester: { accountId: "discord-user-1", userId: "user-1" },
        authorization: { workspaceId: "workspace-1", scope: "monitor" },
        payload,
      });
    }),
  );

  it.effect("forwards monitor authorization for kick", () =>
    Effect.gen(function* () {
      const requireMonitorWorkspace: Context.Service.Shape<
        typeof AuthorizationService
      >["requireMonitorWorkspace"] = vi.fn(() => Effect.as(SheetAuthUser, undefined));
      const kick = vi.fn(() => Effect.succeed({ status: "accepted" }));
      const payload = {
        client: { platform: "discord", clientId: "discord-main" },
        dispatchRequestId: "dispatch-kick",
        workspaceId: "workspace-1",
      };

      yield* runRoute(
        "kick",
        payload,
        { requireMonitorWorkspace } as unknown as Context.Service.Shape<
          typeof AuthorizationService
        >,
        { dispatch: { kick } } as unknown as Context.Service.Shape<
          typeof SheetWorkflowsForwardingClient
        >,
      );

      expect(requireMonitorWorkspace).toHaveBeenCalledWith("workspace-1");
      expect(kick).toHaveBeenCalledWith({
        requester: { accountId: "discord-user-1", userId: "user-1" },
        payload,
      });
    }),
  );
});
