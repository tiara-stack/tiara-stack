import { HttpServer, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSwagger,
} from "effect/unstable/httpapi";
import { NodeFileSystem, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger, Option, Redacted, Context } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { cors } from "hono/cors";
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
import { Hono } from "hono";
import { createForwarder } from "./web-forwarder";

// Create Effect HTTP API with catch-all endpoints for Better Auth
// and explicit endpoints for well-known metadata that have SERVER_ONLY flag
const Api = HttpApi.make("sheet-auth")
  .add(
    HttpApiGroup.make("auth")
      .add(HttpApiEndpoint.get("get", "/*"))
      .add(HttpApiEndpoint.post("post", "/*"))
      .add(HttpApiEndpoint.put("put", "/*"))
      .add(HttpApiEndpoint.delete("delete", "/*"))
      .add(HttpApiEndpoint.patch("patch", "/*"))
      .add(HttpApiEndpoint.head("head", "/*"))
      .add(HttpApiEndpoint.options("options", "/*")),
  )
  .add(
    HttpApiGroup.make("well-known")
      .add(HttpApiEndpoint.get("oauthAuthServer", "/.well-known/oauth-authorization-server"))
      .add(HttpApiEndpoint.get("openidConfig", "/.well-known/openid-configuration")),
  );

// Auth service type - just the auth instance with cleanup
// Note: oauthProviderAuthServerMetadata and oauthProviderOpenIdConfigMetadata
// are standalone helper functions, not methods on the auth instance
interface AuthWithOAuthProvider extends AuthWithCleanup {}

// Auth service tag to share auth instance between route groups
class AuthService extends Context.Service<AuthService, AuthWithOAuthProvider>()("AuthService") {}

// Layer that creates the auth instance and provides it as a service
const authServiceLayer = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const discordClientId = yield* config.discordClientId;
    const discordClientSecret = yield* config.discordClientSecret;
    const postgresUrl = yield* config.postgresUrl;
    const oauthValidAudiences = yield* config.oauthValidAudiences;
    const trustedOAuthClientIds = yield* config.trustedOAuthClientIds;
    const baseUrl = yield* config.baseUrl;
    const trustedOrigins = yield* config.trustedOrigins;
    const cookieDomain = yield* config.cookieDomain;
    const tokenExchangeSubjectJwtSecret = yield* config.tokenExchangeSubjectJwtSecret;
    const tokenExchangeSubjectJwtIssuer = yield* config.tokenExchangeSubjectJwtIssuer;
    const subjectTokenKubernetesAudience = yield* config.subjectTokenKubernetesAudience;
    const subjectTokenKubernetesAllowedServiceAccounts =
      yield* config.subjectTokenKubernetesAllowedServiceAccounts;
    const subjectTokenKubernetesReviewerTokenPath =
      yield* config.subjectTokenKubernetesReviewerTokenPath;
    const subjectTokenKubernetesCaPath = yield* config.subjectTokenKubernetesCaPath;
    const subjectTokenKubernetesTokenReviewUrl = yield* config.subjectTokenKubernetesTokenReviewUrl;
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
      oauthValidAudiences,
      trustedOAuthClientIds,
      baseUrl,
      trustedOrigins: [...trustedOrigins],
      cookieDomain: Option.getOrUndefined(cookieDomain),
      tokenExchangeSubjectJwtSecret: Option.getOrUndefined(
        Option.map(tokenExchangeSubjectJwtSecret, Redacted.value),
      ),
      tokenExchangeSubjectJwtIssuer: Option.getOrUndefined(tokenExchangeSubjectJwtIssuer),
      subjectTokenKubernetesAudience,
      subjectTokenKubernetesAllowedServiceAccounts,
      subjectTokenKubernetesReviewerTokenPath,
      subjectTokenKubernetesCaPath,
      subjectTokenKubernetesTokenReviewUrl,
      secondaryStorageDriver: redisStorageDriver,
    }) as AuthWithOAuthProvider;

    // Add cleanup finalizer for connections
    yield* Effect.addFinalizer(() =>
      Effect.all([
        Effect.promise(() => auth.close()),
        Effect.promise(() => auth.closeStorage()),
      ]).pipe(
        Effect.tap(() => Effect.sync(() => console.log("Connections closed"))),
        Effect.tapError((error) =>
          Effect.sync(() => console.error("Failed to close connections:", error)),
        ),
      ),
    );

    return auth;
  }),
);

// Helper to check if origin matches trusted origins (supports wildcards like http://localhost:*)
// * matches single hostname segment only (e.g., *.example.com matches a.example.com but not a.b.example.com)
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((allowed) => {
    if (allowed === origin) return true;
    if (allowed.includes("*")) {
      // Replace * with placeholder, escape all regex chars, then restore as [^./]*
      // [^./]* ensures * matches only valid hostname chars (no dots or slashes)
      const withPlaceholder = allowed.replace(/\*/g, "\x00");
      const escaped = withPlaceholder.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      // eslint-disable-next-line no-control-regex
      const regex = new RegExp("^" + escaped.replace(/\x00/g, "[^./]*") + "$");
      return regex.test(origin);
    }
    return false;
  });
}

// Auth handler group - forwards all requests to Better Auth
const authLayer = HttpApiBuilder.group(
  Api,
  "auth",
  Effect.fn(function* (handlers) {
    const auth = yield* AuthService;
    const trustedOrigins = [...(yield* config.trustedOrigins)];
    const baseUrl = yield* config.baseUrl;
    const allowedOrigins = [...trustedOrigins, baseUrl];

    const app = new Hono();
    app.use(
      "*",
      cors({
        origin: (origin) => (isOriginAllowed(origin, allowedOrigins) ? origin : null),
        allowHeaders: ["Content-Type", "Authorization", "b3", "traceparent", "tracestate"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
        maxAge: 600,
        credentials: true,
      }),
    );

    app.on(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"], "*", (c) => {
      return auth.handler(c.req.raw);
    });

    const forward = createForwarder((req) => Promise.resolve(app.fetch(req)));
    return handlers
      .handle("get", forward)
      .handle("post", forward)
      .handle("put", forward)
      .handle("delete", forward)
      .handle("patch", forward)
      .handle("head", forward)
      .handle("options", forward);
  }),
).pipe(Layer.provide(authServiceLayer));

// Well-known handler group - handles SERVER_ONLY metadata endpoints
// by forwarding the helper Web handlers through Effect HTTP.
const wellKnownLayer = HttpApiBuilder.group(
  Api,
  "well-known",
  Effect.fn(function* (handlers) {
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
).pipe(Layer.provide(authServiceLayer));

const apiLayer = Layer.provide(HttpApiBuilder.layer(Api), [authLayer, wellKnownLayer]).pipe(
  Layer.merge(HttpApiSwagger.layer(Api)),
  Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
  Layer.merge(HttpRouter.add("GET", "/ready", HttpServerResponse.empty({ status: 200 }))),
);

const HttpLive = HttpRouter.serve(apiLayer).pipe(
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

HttpLive.pipe(
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(configProviderLayer),
  Layer.launch,
  NodeRuntime.runMain(),
);
