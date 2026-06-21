// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, HashSet, Redacted, Ref } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { SheetApisAnonymousUserFallback } from "sheet-ingress-api/middlewares/sheetApisAnonymousUserFallback/tag";
import { SheetApisServiceUserFallback } from "sheet-ingress-api/middlewares/sheetApisServiceUserFallback/tag";
import { SheetBotServiceAuthorization } from "sheet-ingress-api/middlewares/sheetBotServiceAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { Permission } from "sheet-ingress-api/schemas/permissions";
import { Unauthorized } from "typhoon-core/error";
import { SheetAuthUserResolver } from "../services/authResolver";
import { SheetApisRpcTokens } from "../services/sheetApisRpcTokens";
import {
  SheetApisAnonymousUserFallbackLive,
  SheetApisServiceUserFallbackLive,
  SheetBotServiceAuthorizationLive,
} from "./proxyAuthorization";

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

const options = { endpoint: undefined as never, group: undefined as never };

const runPromise = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>);

const runPromiseExit = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
  Effect.runPromiseExit(effect as Effect.Effect<A, E, never>);

const makeUser = (accountId: string, permissions: Iterable<Permission> = []) =>
  ({
    accountId,
    userId: `${accountId}-user`,
    permissions: HashSet.fromIterable(permissions),
    scopes: new Set() as never,
    token: Redacted.make(`${accountId}-token`),
  }) as SheetAuthUserType;

const makeServiceUser = () =>
  ({
    accountId: "service",
    userId: "service-user",
    permissions: HashSet.fromIterable(["service"]),
    scopes: new Set(["service"]) as never,
    token: Redacted.make("service-token"),
  }) satisfies SheetAuthUserType;

const captureUser = (ref: Ref.Ref<SheetAuthUserType | undefined>) =>
  Effect.gen(function* () {
    const user = yield* SheetAuthUser;
    yield* Ref.set(ref, user);
    return HttpServerResponse.empty();
  });

describe("proxy authorization middleware", () => {
  it("provides anonymous user when no auth user exists", async () => {
    const user = await runPromise(
      Effect.gen(function* () {
        const middleware = yield* SheetApisAnonymousUserFallback;
        const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
        yield* middleware(captureUser(ref), options);
        return yield* Ref.get(ref);
      }).pipe(Effect.provide(SheetApisAnonymousUserFallbackLive)),
    );

    expect(user?.accountId).toBe("anonymous");
    expect(user?.userId).toBe("anonymous");
    expect(HashSet.size(user?.permissions ?? HashSet.empty())).toBe(0);
  });

  it("preserves an existing auth user for anonymous fallback", async () => {
    const existing = makeUser("discord-user");
    const user = await runPromise(
      Effect.gen(function* () {
        const middleware = yield* SheetApisAnonymousUserFallback;
        const ref = yield* Ref.make<SheetAuthUserType | undefined>(undefined);
        yield* middleware(captureUser(ref), options).pipe(
          Effect.provideService(SheetAuthUser, existing),
        );
        return yield* Ref.get(ref);
      }).pipe(Effect.provide(SheetApisAnonymousUserFallbackLive)),
    );

    expect(user).toEqual(existing);
  });

  it("provides service user when no auth user exists", async () => {
    let getServiceUserCalls = 0;
    const serviceUser = makeServiceUser();
    const tokens = {
      getServiceUser: () =>
        Effect.sync(() => {
          getServiceUserCalls += 1;
          return serviceUser;
        }),
    } as never;

    const user = await runPromise(
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
  });

  it("preserves existing auth user and does not resolve service user", async () => {
    let getServiceUserCalls = 0;
    const existing = makeUser("discord-user");
    const tokens = {
      getServiceUser: () =>
        Effect.sync(() => {
          getServiceUserCalls += 1;
          return makeServiceUser();
        }),
    } as never;

    const user = await runPromise(
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
  });

  it("maps service user fallback failures to Unauthorized", async () => {
    const tokens = {
      getServiceUser: () => Effect.fail(new Error("service user unavailable")),
    } as never;

    const exit = await runPromiseExit(
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
  });

  it("allows sheet-bot service tokens", async () => {
    const resolver = {
      resolveToken: () => Effect.succeed(makeServiceUser()),
    } as never;

    const response = await runPromise(
      Effect.gen(function* () {
        const middleware = yield* SheetBotServiceAuthorization;
        return yield* middleware.sheetBotServiceToken(Effect.succeed(HttpServerResponse.empty()), {
          ...options,
          credential: Redacted.make("service-token"),
        });
      }).pipe(
        Effect.provide(SheetBotServiceAuthorizationLive),
        Effect.provideService(SheetAuthUserResolver, resolver),
      ),
    );

    expect(response).toEqual(HttpServerResponse.empty());
  });

  it("rejects sheet-bot tokens without service permission", async () => {
    const resolver = {
      resolveToken: () => Effect.succeed(makeUser("discord-user")),
    } as never;

    const exit = await runPromiseExit(
      Effect.gen(function* () {
        const middleware = yield* SheetBotServiceAuthorization;
        return yield* middleware.sheetBotServiceToken(Effect.succeed(HttpServerResponse.empty()), {
          ...options,
          credential: Redacted.make("user-token"),
        });
      }).pipe(
        Effect.provide(SheetBotServiceAuthorizationLive),
        Effect.provideService(SheetAuthUserResolver, resolver),
      ),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("treats sheet-bot resolver failures as unauthorized", async () => {
    const resolver = {
      resolveToken: () => Effect.fail(new Unauthorized({ message: "bad token" })),
    } as never;

    const exit = await runPromiseExit(
      Effect.gen(function* () {
        const middleware = yield* SheetBotServiceAuthorization;
        return yield* middleware.sheetBotServiceToken(Effect.succeed(HttpServerResponse.empty()), {
          ...options,
          credential: Redacted.make("bad-token"),
        });
      }).pipe(
        Effect.provide(SheetBotServiceAuthorizationLive),
        Effect.provideService(SheetAuthUserResolver, resolver),
      ),
    );

    expect(exit._tag).toBe("Failure");
  });
});
