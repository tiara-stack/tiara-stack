import { expect, layer } from "@effect/vitest";
import { Context, Effect, HashSet, Layer, Option, Redacted } from "effect";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
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

const getDispatchRoute = (name: "autoCheckinTest" | "kickout") => {
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
  name: "autoCheckinTest" | "kickout",
  payload: Record<string, unknown>,
  authorizationService: Context.Service.Shape<typeof AuthorizationService>,
  forwardingClient: Context.Service.Shape<typeof SheetWorkflowsForwardingClient>,
) =>
  getDispatchRoute(name)({ payload }).pipe(
    Effect.provideService(AuthorizationService, authorizationService),
    Effect.provideService(SheetWorkflowsForwardingClient, forwardingClient),
  );

layer(TestLayer)("dispatch handlers", (it) => {
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

  it.effect("forwards manage authorization for kickout", () =>
    Effect.gen(function* () {
      const requireManageWorkspace: Context.Service.Shape<
        typeof AuthorizationService
      >["requireManageWorkspace"] = vi.fn(() => Effect.as(SheetAuthUser, undefined));
      const kickout = vi.fn(() => Effect.succeed({ status: "accepted" }));
      const payload = {
        client: { platform: "discord", clientId: "discord-main" },
        dispatchRequestId: "dispatch-kickout",
        workspaceId: "workspace-1",
      };

      yield* runRoute(
        "kickout",
        payload,
        { requireManageWorkspace } as unknown as Context.Service.Shape<typeof AuthorizationService>,
        { dispatch: { kickout } } as unknown as Context.Service.Shape<
          typeof SheetWorkflowsForwardingClient
        >,
      );

      expect(requireManageWorkspace).toHaveBeenCalledWith("workspace-1");
      expect(kickout).toHaveBeenCalledWith({
        requester: { accountId: "discord-user-1", userId: "user-1" },
        authorization: { workspaceId: "workspace-1", scope: "manage" },
        payload,
      });
    }),
  );
});
