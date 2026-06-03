import { NodeFileSystem } from "@effect/platform-node";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import {
  Cache,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Redacted,
  Ref,
  Schedule,
  pipe,
} from "effect";
import { createKubernetesOAuthSession } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/plugins/kubernetes-oauth";
import { SheetApisApi } from "sheet-ingress-api/sheet-apis";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

type TokenCacheEntry = {
  token: Redacted.Redacted<string> | undefined;
  timeToLive: Duration.Duration;
};

export class SheetApisClient extends Context.Service<SheetApisClient>()("SheetApisClient", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sheetAuthClient = yield* SheetAuthClient;
    const httpClient = yield* HttpClient.HttpClient;
    const k8sTokenRef = yield* Ref.make("");
    const baseUrl = yield* config.sheetIngressBaseUrl;

    yield* pipe(
      fs.readFileString("/var/run/secrets/tokens/sheet-auth-token", "utf-8"),
      Effect.map((token) => token.trim()),
      Effect.flatMap((token) => Ref.set(k8sTokenRef, token)),
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
      Effect.catch(() => Effect.void),
      Effect.withSpan("SheetApisClient.refreshK8sToken"),
      Effect.repeat(Schedule.spaced("5 minutes")),
      Effect.forkScoped,
    );

    const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
      Effect.fn("SheetApisClient.lookup")(function* () {
        const k8sToken = yield* Ref.get(k8sTokenRef);
        const session = yield* createKubernetesOAuthSession(
          sheetAuthClient,
          DISCORD_SERVICE_USER_ID_SENTINEL,
          k8sToken,
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        const now = yield* DateTime.now;
        const timeToLive = session?.session?.expiresAt
          ? pipe(
              DateTime.distance(now, session.session.expiresAt),
              Duration.subtract(Duration.seconds(60)),
            )
          : Duration.minutes(1);

        const entry = {
          token: session?.token,
          timeToLive,
        };
        yield* Effect.annotateCurrentSpan({
          tokenAvailable: entry.token !== undefined,
          timeToLiveMillis: Duration.toMillis(entry.timeToLive),
        });
        return entry;
      }),
      {
        capacity: 1,
        timeToLive: Exit.match({
          onFailure: () => Duration.minutes(1),
          onSuccess: ({ timeToLive }) => timeToLive,
        }),
      },
    );

    const httpClientWithToken = HttpClient.mapRequestEffect(httpClient, (request) =>
      Effect.gen(function* () {
        const { token } = yield* pipe(
          Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL),
          Effect.catch((err) =>
            pipe(
              Effect.logWarning(
                `Failed to get auth token, proceeding unauthenticated: ${String(err)}`,
              ),
              Effect.as({ token: undefined }),
            ),
          ),
        );

        yield* Effect.annotateCurrentSpan({ tokenAvailable: token !== undefined });
        return token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request;
      }).pipe(Effect.withSpan("SheetApisClient.mapAuthRequest")),
    ) as unknown as HttpClient.HttpClient;

    const client = yield* HttpApiClient.makeWith(SheetApisApi, {
      httpClient: httpClientWithToken,
      baseUrl,
    }).pipe(Effect.withSpan("SheetApisClient.makeWith", { attributes: { baseUrl } }));

    return {
      get: () => client,
    };
  }),
}) {
  static layer = Layer.effect(SheetApisClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
    Layer.provide(NodeFileSystem.layer),
  );
}
