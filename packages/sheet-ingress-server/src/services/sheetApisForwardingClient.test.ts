// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Effect, HashSet, Option, Redacted } from "effect";
import { Headers } from "effect/unstable/http";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const makeSheetApisRpcTokens = () =>
  ({
    getServiceToken: (resource: string) => Effect.succeed(`${resource}-token`),
  }) as never;

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
    Effect.provideService(SheetAuthUser, {
      accountId: "discord-user-1",
      userId: "user-1",
      permissions: HashSet.empty(),
      scopes: new Set() as never,
      token: Redacted.make("sheet-auth-session-token"),
    }),
  ) as Effect.Effect<A, E, never>;

describe("SheetApisForwardingClient", () => {
  it.effect(
    "builds sheet-apis ingress headers with sheet-auth session token but no Discord access token",
    () =>
      Effect.gen(function* () {
        const headers = yield* run(getIngressRpcHeaders({ serviceTokenResource: "sheet-apis" }));

        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(
          "Bearer sheet-apis-token",
        );
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"))).toBe("user-1");
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"))).toBe(
          "discord-user-1",
        );
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(
          "Bearer sheet-auth-session-token",
        );
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-token"))).toBe(
          "Bearer sheet-auth-session-token",
        );
        expect(Option.isNone(Headers.get(headers, "x-sheet-discord-access-token"))).toBe(true);
      }),
  );

  it.effect(
    "builds sheet-bot ingress headers with the sheet-bot service token and shared auth context",
    () =>
      Effect.gen(function* () {
        const headers = yield* run(getIngressRpcHeaders({ serviceTokenResource: "sheet-bot" }));

        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(
          "Bearer sheet-bot-token",
        );
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"))).toBe("user-1");
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"))).toBe(
          "discord-user-1",
        );
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(
          "Bearer sheet-auth-session-token",
        );
        expect(Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-token"))).toBe(
          "Bearer sheet-auth-session-token",
        );
      }),
  );
});
