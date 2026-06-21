import { Effect } from "effect";
import { AuthorizationService } from "@/services";

const withCurrentWorkspaceAuth =
  <Args>(
    authorizationService: typeof AuthorizationService.Service,
    extractWorkspaceId: (args: Args) => string,
  ) =>
  <A, E, R>(body: (args: Args) => Effect.Effect<A, E, R>) =>
    Effect.fnUntraced(
      function* (args: Args) {
        return yield* body(args);
      },
      (effect, args) =>
        authorizationService.provideCurrentWorkspaceUser(extractWorkspaceId(args), effect),
    );

export const withCurrentWorkspaceAuthFromQuery =
  (authorizationService: typeof AuthorizationService.Service) =>
  <Args extends { query: { workspaceId: string } }, A, E, R>(
    body: (args: Args) => Effect.Effect<A, E, R>,
  ) =>
    withCurrentWorkspaceAuth<Args>(authorizationService, ({ query }) => query.workspaceId)(body);

export const withCurrentWorkspaceAuthFromPayload =
  (authorizationService: typeof AuthorizationService.Service) =>
  <Args extends { payload: { workspaceId: string } }, A, E, R>(
    body: (args: Args) => Effect.Effect<A, E, R>,
  ) =>
    withCurrentWorkspaceAuth<Args>(
      authorizationService,
      ({ payload }) => payload.workspaceId,
    )(body);

export const withCurrentGuildAuthFromQuery =
  (authorizationService: typeof AuthorizationService.Service) =>
  <Args extends { query: { guildId: string } }, A, E, R>(
    body: (args: Args) => Effect.Effect<A, E, R>,
  ) =>
    withCurrentWorkspaceAuth<Args>(authorizationService, ({ query }) => query.guildId)(body);

export const withCurrentGuildAuthFromPayload =
  (authorizationService: typeof AuthorizationService.Service) =>
  <Args extends { payload: { guildId: string } }, A, E, R>(
    body: (args: Args) => Effect.Effect<A, E, R>,
  ) =>
    withCurrentWorkspaceAuth<Args>(authorizationService, ({ payload }) => payload.guildId)(body);
