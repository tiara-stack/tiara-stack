import { Effect } from "effect";
import { AuthorizationService } from "@/services";

const withCurrentGuildAuth =
  <Args>(
    authorizationService: typeof AuthorizationService.Service,
    extractGuildId: (args: Args) => string,
  ) =>
  <A, E, R>(body: (args: Args) => Effect.Effect<A, E, R>) =>
    Effect.fnUntraced(
      function* (args: Args) {
        return yield* body(args);
      },
      (effect, args) => authorizationService.provideCurrentGuildUser(extractGuildId(args), effect),
    );

export const withCurrentGuildAuthFromQuery =
  (authorizationService: typeof AuthorizationService.Service) =>
  <Args extends { query: { guildId: string } }, A, E, R>(
    body: (args: Args) => Effect.Effect<A, E, R>,
  ) =>
    withCurrentGuildAuth<Args>(authorizationService, ({ query }) => query.guildId)(body);

export const withCurrentGuildAuthFromPayload =
  (authorizationService: typeof AuthorizationService.Service) =>
  <Args extends { payload: { guildId: string } }, A, E, R>(
    body: (args: Args) => Effect.Effect<A, E, R>,
  ) =>
    withCurrentGuildAuth<Args>(authorizationService, ({ payload }) => payload.guildId)(body);
