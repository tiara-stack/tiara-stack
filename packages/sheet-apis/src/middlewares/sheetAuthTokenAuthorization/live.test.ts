import { Cause, Context, Effect, Exit, HashSet, Option, Predicate, Redacted, Ref } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import {
  decodeForwardedSheetAuthUserBearer,
  encodeForwardedSheetAuthUserBearer,
  SheetAuthTokenAuthorization,
} from "sheet-ingress-api/internal";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import type { Permission, SheetAuthOAuthScope } from "sheet-ingress-api/schemas/permissions";
import { Unauthorized } from "typhoon-core/error";
import { SheetAuthTokenAuthorizationLive } from "./live";

const existingUser = {
  accountId: "discord-user-existing",
  userId: "user-existing",
  permissions: HashSet.make("account:discord:discord-user-existing" as Permission),
  scopes: new Set(["sheet.read" as SheetAuthOAuthScope]),
  token: Redacted.make("existing-token"),
  tokenType: "session" as const,
};

const runMiddleware = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  credential = Redacted.make("invalid-forwarded-bearer"),
) =>
  Effect.gen(function* () {
    const authorization = yield* SheetAuthTokenAuthorization;
    return yield* authorization.sheetAuthToken(effect as never, {
      credential,
      endpoint: {} as never,
      group: {} as never,
    });
  }).pipe(Effect.provide(SheetAuthTokenAuthorizationLive)) as Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    never
  >;

describe("SheetAuthTokenAuthorizationLive", () => {
  it.effect("reuses an existing SheetAuthUser before decoding the bearer fallback", () =>
    Effect.gen(function* () {
      const observedUser = yield* Ref.make<
        Option.Option<Context.Service.Shape<typeof SheetAuthUser>>
      >(Option.none());
      yield* runMiddleware(
        Effect.gen(function* () {
          const user = yield* SheetAuthUser;
          yield* Ref.set(observedUser, Option.some(user));
          return HttpServerResponse.empty();
        }),
      ).pipe(Effect.provideService(SheetAuthUser, existingUser));
      const user = yield* Ref.get(observedUser);

      expect(Option.isSome(user)).toBe(true);
      if (Option.isSome(user)) {
        expect(user.value.userId).toBe("user-existing");
        expect(Redacted.value(user.value.token)).toBe("existing-token");
        expect(user.value.tokenType).toBe("session");
      }
    }),
  );

  it.effect("rejects an invalid forwarded bearer when no existing user is available", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runMiddleware(
          Effect.gen(function* () {
            yield* SheetAuthUser;
            return HttpServerResponse.empty();
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure: unknown = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(failure).toBeInstanceOf(Unauthorized);
        expect(Predicate.isTagged("Unauthorized")(failure)).toBe(true);
      }
    }),
  );

  it.effect("round-trips forwarded sheet-auth users through the bearer envelope", () =>
    Effect.gen(function* () {
      const token = encodeForwardedSheetAuthUserBearer({
        accountId: "discord-user-1",
        userId: "user-1",
        permissions: HashSet.make("account:discord:discord-user-1" as Permission),
        scopes: new Set(["sheet.read" as SheetAuthOAuthScope]),
        token: Redacted.make("sheet-auth-session-token"),
        tokenType: "session",
      });

      const user = yield* decodeForwardedSheetAuthUserBearer(token, {
        unavailableToken: Redacted.make("unavailable"),
      });

      expect(user.accountId).toBe("discord-user-1");
      expect(user.userId).toBe("user-1");
      expect(HashSet.has(user.permissions, "account:discord:discord-user-1")).toBe(true);
      expect(Redacted.value(user.token)).toBe("sheet-auth-session-token");
      expect(user.tokenType).toBe("session");
    }),
  );
});
