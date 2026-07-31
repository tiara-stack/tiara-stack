import { Zero } from "@rocicorp/zero";
import { Cache, Duration, Effect, Exit, Layer, Match, pipe, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { type Schema, schema, mutators } from "sheet-db-schema/zero";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

const makeGetAuth = Effect.fn("zero.makeGetAuth")(function* () {
  const sheetAuthClient = yield* SheetAuthClient;
  const clientId = yield* config.sheetAuthOAuthClientId;
  const clientSecret = yield* config.sheetAuthOAuthClientSecret;
  const resource = yield* config.zeroOAuthAudience;
  const cache = yield* Cache.makeWith(
    Effect.fn("zero.getOAuthToken")(() =>
      createOAuthClientCredentialsToken(sheetAuthClient, {
        clientId,
        clientSecret,
        resource,
        scope: ["service"],
      }).pipe(
        Effect.map((token) => ({
          accessToken: token.accessToken,
          timeToLive: Duration.max(
            Duration.seconds(token.expiresAt - Math.floor(Date.now() / 1000) - 60),
            Duration.zero,
          ),
        })),
      ),
    ),
    {
      capacity: 1,
      timeToLive: Exit.match({
        onFailure: () => Duration.seconds(1),
        onSuccess: ({ timeToLive }) => timeToLive,
      }),
    },
  );

  return Effect.fn("zero.getAuth")(function* () {
    const token = yield* Cache.get(cache, resource);
    return Redacted.value(token.accessToken);
  });
});

const makeZero = Effect.fn("zero.makeZero")(function* () {
  const getAuth = yield* makeGetAuth();
  const auth = yield* getAuth();
  const zeroCacheServer = yield* config.zeroCacheServer;
  const zeroCacheUserId = yield* config.zeroCacheUserId;
  const context = yield* Effect.context();
  const zero = new Zero({
    server: zeroCacheServer,
    userID: zeroCacheUserId,
    auth,
    schema,
    mutators,
  });

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      zero.connection.state.subscribe((state) =>
        pipe(
          Match.value(state),
          Match.when({ name: "needs-auth" }, () =>
            pipe(
              getAuth(),
              Effect.flatMap((auth) => Effect.tryPromise(() => zero.connection.connect({ auth }))),
            ),
          ),
          Match.orElse(() => Effect.void),
          Effect.provideContext(context),
          Effect.runFork,
        ),
      ),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  return zero;
});

export class ZeroClient extends BaseZeroClient.ZeroClient<Schema, undefined, unknown>() {
  static layer = Layer.effect(
    ZeroClient,
    Effect.gen({ self: this }, function* () {
      const zero = yield* makeZero();
      return yield* this.make(zero);
    }),
  ).pipe(Layer.provide(SheetAuthClient.layer));
}
