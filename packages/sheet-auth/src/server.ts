import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
  HttpServerRequest,
  PlatformConfigProvider,
} from "@effect/platform";
import {
  NodeHttpClient,
  NodeContext,
  NodeHttpServer,
  NodeHttpServerRequest,
  NodeRuntime,
} from "@effect/platform-node";
import { Context, Effect, Layer, Logger, Redacted } from "effect";
import { getRequestListener } from "@hono/node-server";
import { createServer } from "http";
import redisDriver from "unstorage/drivers/redis";
import { authConfig, type AuthWithCleanup } from "./auth-config";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { config } from "./config";
import { MetricsLive } from "./metrics";
import { TracesLive } from "./traces";

// Create Effect HTTP API with catch-all endpoints for Better Auth
// and explicit endpoints for well-known metadata that have SERVER_ONLY flag
const Api = HttpApi.make("sheet-auth")
  .add(
    HttpApiGroup.make("auth")
      .add(HttpApiEndpoint.get("get", "/*"))
      .add(HttpApiEndpoint.post("post", "/*"))
      .add(HttpApiEndpoint.put("put", "/*"))
      .add(HttpApiEndpoint.del("delete", "/*"))
      .add(HttpApiEndpoint.patch("patch", "/*"))
      .add(HttpApiEndpoint.head("head", "/*"))
      .add(HttpApiEndpoint.options("options", "/*")),
  )
  .add(
    HttpApiGroup.make("well-known")
      .add(HttpApiEndpoint.get("oauthAuthServer", "/.well-known/oauth-authorization-server"))
      .add(HttpApiEndpoint.get("openidConfig", "/.well-known/openid-configuration")),
  );

// Handler type
type HandlerParams = {
  request: HttpServerRequest.HttpServerRequest;
};

// Auth service type - just the auth instance with cleanup
// Note: oauthProviderAuthServerMetadata and oauthProviderOpenIdConfigMetadata
// are standalone helper functions, not methods on the auth instance
interface AuthWithOAuthProvider extends AuthWithCleanup {}

// Auth service tag to share auth instance between route groups
class AuthService extends Context.Tag("AuthService")<AuthService, AuthWithOAuthProvider>() {}

// Helper to create a forwarder from a web handler
const createForwarder =
  (webHandler: (req: Request) => Promise<Response>) =>
  ({ request }: HandlerParams) =>
    Effect.promise(() => {
      const listener = getRequestListener(webHandler);
      return listener(
        NodeHttpServerRequest.toIncomingMessage(request),
        NodeHttpServerRequest.toServerResponse(request),
      );
    });

// Layer that creates the auth instance and provides it as a service
const AuthServiceLive = Layer.scoped(
  AuthService,
  Effect.gen(function* () {
    const discordClientId = yield* config.discordClientId;
    const discordClientSecret = yield* config.discordClientSecret;
    const postgresUrl = yield* config.postgresUrl;
    const kubernetesAudience = yield* config.kubernetesAudience;
    const baseUrl = yield* config.baseUrl;
    const redisUrl = yield* config.redisUrl;
    const redisBase = yield* config.redisBase;

    // Create Redis driver for secondary storage
    const redisStorageDriver = redisDriver({
      url: Redacted.value(redisUrl),
      base: redisBase,
    });

    // Create Better Auth instance with basePath: "/" (root)
    const auth = authConfig({
      postgresUrl,
      discordClientId,
      discordClientSecret: Redacted.value(discordClientSecret),
      kubernetesAudience,
      baseUrl,
      secondaryStorageDriver: redisStorageDriver,
    }) as AuthWithOAuthProvider;

    // Add cleanup finalizer for connections
    yield* Effect.addFinalizer(() =>
      Effect.all([
        Effect.promise(() => auth.close()),
        Effect.promise(() => auth.closeStorage()),
      ]).pipe(
        Effect.tapBoth({
          onFailure: (error) =>
            Effect.sync(() => console.error("Failed to close connections:", error)),
          onSuccess: () => Effect.sync(() => console.log("Connections closed")),
        }),
        Effect.orElse(() => Effect.void),
      ),
    );

    return auth;
  }),
);

// Auth handler group - forwards all requests to Better Auth
const AuthLive = HttpApiBuilder.group(Api, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const forward = createForwarder(auth.handler);
    return handlers
      .handle("get", forward)
      .handle("post", forward)
      .handle("put", forward)
      .handle("delete", forward)
      .handle("patch", forward)
      .handle("head", forward)
      .handle("options", forward);
  }),
);

// Well-known handler group - handles SERVER_ONLY metadata endpoints
// by wrapping the helper functions with getRequestListener
const WellKnownLive = HttpApiBuilder.group(Api, "well-known", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;

    // Create web handlers for well-known endpoints
    // These helpers expect auth.api to have getOAuthServerConfig/getOpenIdConfig
    // but those are SERVER_ONLY endpoints not actually on the api. We cast to satisfy types.
    const oauthAuthServerHandler = oauthProviderAuthServerMetadata(
      auth as AuthWithCleanup & { api: { getOAuthServerConfig: (...args: unknown[]) => unknown } },
    );
    const openIdConfigHandler = oauthProviderOpenIdConfigMetadata(
      auth as AuthWithCleanup & { api: { getOpenIdConfig: (...args: unknown[]) => unknown } },
    );

    return handlers
      .handle("oauthAuthServer", createForwarder(oauthAuthServerHandler))
      .handle("openidConfig", createForwarder(openIdConfigHandler));
  }),
);

const ApiLive = Layer.provide(HttpApiBuilder.api(Api), Layer.merge(AuthLive, WellKnownLive));

// CORS middleware that echoes back the request origin to support credentials
const corsMiddlewareLive = HttpApiBuilder.middlewareCors({
  allowedOrigins: (_origin) => true,
  allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400,
});

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(HttpApiBuilder.middlewareOpenApi()),
  Layer.provide(corsMiddlewareLive),
  Layer.provide(ApiLive),
  Layer.provide(AuthServiceLive),
  Layer.provide(NodeHttpClient.layer),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

HttpLive.pipe(
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.logFmt),
  Layer.provide(PlatformConfigProvider.layerDotEnvAdd(".env")),
  Layer.provide(NodeContext.layer),
  Layer.launch,
  NodeRuntime.runMain({ disablePrettyLogger: true }),
);
