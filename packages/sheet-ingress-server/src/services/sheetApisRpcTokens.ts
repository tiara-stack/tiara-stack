import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  HashSet,
  Layer,
  Option,
  Redacted,
} from "effect";
import { Permission } from "sheet-ingress-api/schemas/permissions";
import { createOAuthClientCredentialsToken, toTokenCacheTTL } from "sheet-auth/client";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { config } from "@/config";

const sheetApisTokenPath = "/var/run/secrets/tokens/sheet-apis-token";
const sheetWorkflowsTokenPath = "/var/run/secrets/tokens/sheet-workflows-token";
const sheetBotTokenPath = "/var/run/secrets/tokens/sheet-bot-token";

type ServiceTokenConfig = {
  readonly id: string;
  readonly secret: Redacted.Redacted<string>;
};

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string>;
  readonly userId: string;
  readonly accountId: string;
  readonly permissions: HashSet.HashSet<Permission>;
  readonly timeToLive: Duration.Duration;
};

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

const resolveServiceClientConfig = (serviceTokenPath: string) =>
  Effect.gen(function* () {
    let idConfig: Option.Option<string>;
    let secretConfig: Option.Option<Redacted.Redacted<string>>;

    if (serviceTokenPath === sheetApisTokenPath) {
      idConfig = yield* config.sheetApisOAuthClientId;
      secretConfig = yield* config.sheetApisOAuthClientSecret;
    } else if (serviceTokenPath === sheetWorkflowsTokenPath) {
      idConfig = yield* config.sheetWorkflowsOAuthClientId;
      secretConfig = yield* config.sheetWorkflowsOAuthClientSecret;
    } else if (serviceTokenPath === sheetBotTokenPath) {
      idConfig = yield* config.sheetBotOAuthClientId;
      secretConfig = yield* config.sheetBotOAuthClientSecret;
    } else {
      return yield* Effect.fail(new Error(`Unknown service token path: ${serviceTokenPath}`));
    }

    const clientId = Option.getOrUndefined(idConfig);
    const clientSecret = Option.getOrUndefined(secretConfig);

    if (!clientId || !clientSecret) {
      return yield* Effect.fail(
        new Error(
          `OAuth service client credentials are not configured for path ${serviceTokenPath}`,
        ),
      );
    }

    return { id: clientId, secret: clientSecret } as ServiceTokenConfig;
  });

const servicePermissionSet = HashSet.fromIterable(["service"] as const);

export const readKubernetesTokenFile = (tokenFilePath: string, serviceName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const token = yield* fs.readFileString(tokenFilePath, "utf-8");
    const trimmed = token.trim();

    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new Error(`Kubernetes service token file is empty for ${serviceName}`),
      );
    }

    return trimmed;
  });

export class SheetApisRpcTokens extends Context.Service<SheetApisRpcTokens>()(
  "SheetApisRpcTokens",
  {
    make: Effect.gen(function* () {
      const sheetAuthIssuer = yield* config.sheetAuthIssuer;
      const serviceTokenCache = yield* Cache.makeWith(
        Effect.fn("SheetApisRpcTokens.lookupServiceToken")(function* (serviceTokenPath: string) {
          const credentials = yield* resolveServiceClientConfig(serviceTokenPath);
          const issued = yield* createOAuthClientCredentialsToken(
            sheetAuthIssuer,
            credentials.id,
            credentials.secret,
          );

          const timeToLive = toTokenCacheTTL(issued.expiresIn);
          yield* Effect.annotateCurrentSpan({
            serviceClientId: credentials.id,
            tokenType: issued.tokenType,
            tokenLength: Redacted.value(issued.token).length,
          });

          return {
            token: issued.token,
            userId: credentials.id,
            accountId: `oauth-client:${credentials.id}`,
            permissions: servicePermissionSet,
            timeToLive,
          } satisfies TokenCacheEntry;
        }),
        {
          capacity: 3,
          timeToLive: Exit.match({
            onFailure: () => Duration.seconds(30),
            onSuccess: ({ timeToLive }) => timeToLive,
          }),
        },
      );

      const getServiceToken = Effect.fn("SheetApisRpcTokens.getServiceToken")(function* (
        tokenPath: string,
      ) {
        const entry = yield* Cache.get(serviceTokenCache, tokenPath);
        return Redacted.value(entry.token);
      });

      const getServiceUser = Effect.fn("SheetApisRpcTokens.getServiceUser")(function* () {
        const serviceClient = yield* Cache.get(serviceTokenCache, sheetApisTokenPath);

        return {
          accountId: serviceClient.accountId,
          userId: serviceClient.userId,
          permissions: serviceClient.permissions,
          token: serviceClient.token,
        } satisfies SheetAuthUserType;
      });

      return {
        getServiceToken,
        getServiceUser,
        withServiceUser: Effect.fn("SheetApisRpcTokens.withServiceUser")(function* <A, E, R>(
          effect: Effect.Effect<A, E, R>,
        ) {
          const serviceUser = yield* getServiceUser();
          return yield* effect.pipe(Effect.provideService(SheetAuthUser, serviceUser));
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(SheetApisRpcTokens, this.make);
}
