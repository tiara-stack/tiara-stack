// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, HashSet, Option, Redacted, Ref } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  SheetApisAnonymousUserFallback,
  SheetApisServiceUserFallback,
  SheetBotServiceAuthorization,
} from "sheet-ingress-api/internal";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { Permission } from "sheet-ingress-api/schemas/permissions";
import { Unauthorized } from "typhoon-core/error";
import { SheetAuthUserResolver } from "../services/authResolver";
import { SheetApisRpcTokens } from "../services/sheetApisRpcTokens";
import * as Data from "effect/Data";

class SheetIngressServerMiddlewaresProxyAuthorizationTestError extends Data.TaggedError(
  "SheetIngressServerMiddlewaresProxyAuthorizationTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
import {
  SheetApisAnonymousUserFallbackLive,
  SheetApisServiceUserFallbackLive,
  SheetBotServiceAuthorizationLive,
} from "./proxyAuthorization";

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

const options = { endpoint: undefined as never, group: undefined as never };

const provideHttpRequestContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://localhost/test")),
    ),
    Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
    Effect.provideService(HttpRouter.RouteContext, {
      params: {},
      route: undefined as never,
    }),
  );

const runPromise = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
  effect as Effect.Effect<A, E, never>;

const runPromiseExit = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
  Effect.exit(effect as Effect.Effect<A, E, never>);

const makeUser = (accountId: string, permissions: Iterable<Permission> = []) =>
  ({
    accountId,
    userId: `${accountId}-user`,
    permissions: HashSet.fromIterable(permissions),
    scopes: new Set() as never,
    token: Redacted.make(`${accountId}-token`),
    tokenType: "session",
  }) as SheetAuthUserType;

const makeServiceUser = () =>
  ({
    accountId: "service",
    userId: "service-user",
    permissions: HashSet.fromIterable(["service"]),
    scopes: new Set(["service"]) as never,
    token: Redacted.make("service-token"),
    tokenType: "service",
  }) satisfies SheetAuthUserType;

const captureUser = (ref: Ref.Ref<SheetAuthUserType | undefined>) =>
  Effect.gen(function* () {
    const user = yield* SheetAuthUser;
    yield* Ref.set(ref, user);
    return HttpServerResponse.empty();
  });

const captureOptionalUser = (ref: Ref.Ref<SheetAuthUserType | undefined>) =>
  Effect.gen(function* () {
    const maybeUser = yield* Effect.serviceOption(SheetAuthUser);
    yield* Ref.set(ref, Option.getOrUndefined(maybeUser));
    return HttpServerResponse.empty();
  });

describe("proxy authorization middleware", () => {
  it.effect("does not provide anonymous user when no auth user exists", () =>
    Effect.gen(function* () {
      const user = yield* Effect.scoped(
        Effect.gen(function* () {
          const middleware = yield* SheetApisAnonymousUserFallback;
          const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
          yield* provideHttpRequestContext(middleware(captureOptionalUser(ref), options));
          return yield* Ref.get(ref);
        }).pipe(Effect.provide(SheetApisAnonymousUserFallbackLive)),
      );

      expect(user).toBeUndefined();
    }),
  );

  it.effect("preserves an existing auth user for anonymous fallback", () =>
    Effect.gen(function* () {
      const existing = makeUser("discord-user");
      const user = yield* Effect.scoped(
        Effect.gen(function* () {
          const middleware = yield* SheetApisAnonymousUserFallback;
          const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
          yield* provideHttpRequestContext(
            middleware(captureOptionalUser(ref), options).pipe(
              Effect.provideService(SheetAuthUser, existing),
            ),
          );
          return yield* Ref.get(ref);
        }).pipe(Effect.provide(SheetApisAnonymousUserFallbackLive)),
      );

      expect(user).toEqual(existing);
    }),
  );

  it.effect("provides service user when no auth user exists", () =>
    Effect.gen(function* () {
      let getServiceUserCalls = 0;
      const serviceUser = makeServiceUser();
      const tokens = {
        getServiceUser: () =>
          Effect.sync(() => {
            getServiceUserCalls += 1;
            return serviceUser;
          }),
      } as never;

      const user = yield* runPromise(
        Effect.gen(function* () {
          const middleware = yield* SheetApisServiceUserFallback;
          const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
          yield* middleware(captureUser(ref), options);
          return yield* Ref.get(ref);
        }).pipe(
          Effect.provide(SheetApisServiceUserFallbackLive),
          Effect.provideService(SheetApisRpcTokens, tokens),
        ),
      );

      expect(user).toEqual(serviceUser);
      expect(getServiceUserCalls).toBe(1);
    }),
  );

  it.effect("preserves existing auth user and does not resolve service user", () =>
    Effect.gen(function* () {
      let getServiceUserCalls = 0;
      const existing = makeUser("discord-user");
      const tokens = {
        getServiceUser: () =>
          Effect.sync(() => {
            getServiceUserCalls += 1;
            return makeServiceUser();
          }),
      } as never;

      const user = yield* runPromise(
        Effect.gen(function* () {
          const middleware = yield* SheetApisServiceUserFallback;
          const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
          yield* middleware(captureUser(ref), options).pipe(
            Effect.provideService(SheetAuthUser, existing),
          );
          return yield* Ref.get(ref);
        }).pipe(
          Effect.provide(SheetApisServiceUserFallbackLive),
          Effect.provideService(SheetApisRpcTokens, tokens),
        ),
      );

      expect(user).toEqual(existing);
      expect(getServiceUserCalls).toBe(0);
    }),
  );

  it.effect("maps service user fallback failures to Unauthorized", () =>
    Effect.gen(function* () {
      const tokens = {
        getServiceUser: () =>
          Effect.fail(
            new SheetIngressServerMiddlewaresProxyAuthorizationTestError({
              message: "service user unavailable",
            }),
          ),
      } as never;

      const exit = yield* runPromiseExit(
        Effect.gen(function* () {
          const middleware = yield* SheetApisServiceUserFallback;
          const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
          return yield* middleware(captureUser(ref), options);
        }).pipe(
          Effect.provide(SheetApisServiceUserFallbackLive),
          Effect.provideService(SheetApisRpcTokens, tokens),
        ),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const cause = Cause.pretty(exit.cause);
        expect(cause).toContain("Unauthorized");
        expect(cause).toContain("Failed to create service-user auth session");
      }
    }),
  );

  it.effect("allows sheet-bot service tokens", () =>
    Effect.gen(function* () {
      const resolver = {
        resolveToken: () => Effect.succeed(makeServiceUser()),
      } as never;

      const response = yield* runPromise(
        Effect.gen(function* () {
          const middleware = yield* SheetBotServiceAuthorization;
          return yield* middleware.sheetBotServiceToken(
            Effect.succeed(HttpServerResponse.empty()),
            {
              ...options,
              credential: Redacted.make("service-token"),
            },
          );
        }).pipe(
          Effect.provide(SheetBotServiceAuthorizationLive),
          Effect.provideService(SheetAuthUserResolver, resolver),
        ),
      );

      expect(response).toEqual(HttpServerResponse.empty());
    }),
  );

  it.effect("provides resolved sheet-bot service users to handlers", () =>
    Effect.gen(function* () {
      const serviceUser = makeServiceUser();
      const resolver = {
        resolveToken: () => Effect.succeed(serviceUser),
      } as never;

      const user = yield* runPromise(
        Effect.gen(function* () {
          const middleware = yield* SheetBotServiceAuthorization;
          const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
          yield* middleware.sheetBotServiceToken(captureUser(ref) as never, {
            ...options,
            credential: Redacted.make("service-token"),
          });
          return yield* Ref.get(ref);
        }).pipe(
          Effect.provide(SheetBotServiceAuthorizationLive),
          Effect.provideService(SheetAuthUserResolver, resolver),
        ),
      );

      expect(user).toEqual(serviceUser);
    }),
  );

  it.effect("rejects sheet-bot tokens without service permission", () =>
    Effect.gen(function* () {
      const resolver = {
        resolveToken: () => Effect.succeed(makeUser("discord-user")),
      } as never;

      const exit = yield* runPromiseExit(
        Effect.gen(function* () {
          const middleware = yield* SheetBotServiceAuthorization;
          return yield* middleware.sheetBotServiceToken(
            Effect.succeed(HttpServerResponse.empty()),
            {
              ...options,
              credential: Redacted.make("user-token"),
            },
          );
        }).pipe(
          Effect.provide(SheetBotServiceAuthorizationLive),
          Effect.provideService(SheetAuthUserResolver, resolver),
        ),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("treats sheet-bot resolver failures as unauthorized", () =>
    Effect.gen(function* () {
      const resolver = {
        resolveToken: () => Effect.fail(new Unauthorized({ message: "bad token" })),
      } as never;

      const exit = yield* runPromiseExit(
        Effect.gen(function* () {
          const middleware = yield* SheetBotServiceAuthorization;
          return yield* middleware.sheetBotServiceToken(
            Effect.succeed(HttpServerResponse.empty()),
            {
              ...options,
              credential: Redacted.make("bad-token"),
            },
          );
        }).pipe(
          Effect.provide(SheetBotServiceAuthorizationLive),
          Effect.provideService(SheetAuthUserResolver, resolver),
        ),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );
});
