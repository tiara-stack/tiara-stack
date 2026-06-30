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
    getDelegatedAuthorization: ({ resource }: { readonly resource: string }) =>
      Effect.succeed(
        Redacted.make(
          resource === "sheet-bot" ? `${resource}-token` : `${resource}-delegated-token`,
        ),
      ),
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
      tokenType: "session",
    }),
  );

const runWithoutUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()));

describe("SheetApisForwardingClient", () => {
  it.effect("builds sheet-apis ingress headers with a delegated bearer token", () =>
    Effect.gen(function* () {
      const headers = yield* run(getIngressRpcHeaders({ serviceTokenResource: "sheet-apis" }));

      expect(Option.getOrUndefined(Headers.get(headers, "authorization"))).toBe(
        "Bearer sheet-apis-delegated-token",
      );
      expect(Option.isNone(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(true);
      expect(Option.isNone(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(true);
      expect(Option.isNone(Headers.get(headers, "x-sheet-auth-token"))).toBe(true);
    }),
  );

  it.effect("builds sheet-bot ingress headers with a service bearer token", () =>
    Effect.gen(function* () {
      const headers = yield* run(getIngressRpcHeaders({ serviceTokenResource: "sheet-bot" }));

      expect(Option.getOrUndefined(Headers.get(headers, "authorization"))).toBe(
        "Bearer sheet-bot-token",
      );
      expect(Option.isNone(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(true);
    }),
  );

  it.effect("uses a service bearer token when no SheetAuthUser is available", () =>
    Effect.gen(function* () {
      const headers = yield* runWithoutUser(
        getIngressRpcHeaders({ serviceTokenResource: "sheet-apis" }),
      );

      expect(Option.getOrUndefined(Headers.get(headers, "authorization"))).toBe(
        "Bearer sheet-apis-token",
      );
    }),
  );
});
