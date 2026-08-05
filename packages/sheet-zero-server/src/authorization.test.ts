import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { VerifiedOAuthResourceToken } from "sheet-auth/oauth-resource-authorization";
import { zeroContextFromToken } from "./authorization";

const token = (input: Partial<VerifiedOAuthResourceToken> = {}): VerifiedOAuthResourceToken => ({
  accountId: undefined,
  actorClientId: undefined,
  actorSub: undefined,
  clientId: undefined,
  exp: undefined,
  scopes: new Set(),
  sub: undefined,
  ...input,
});

const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("Zero OAuth context", () => {
  it.effect("rejects an empty procedure batch without service scope", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(zeroContextFromToken([], token()));

      expect(failure(exit)).toMatchObject({
        _tag: "ZeroDispatchUnauthorizedError",
        procedure: "zero",
        message: "Access outside the runs API requires service scope",
      });
    }),
  );

  it.effect("allows an empty procedure batch for a service caller", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        [],
        token({ clientId: "sheet-db-server", scopes: new Set(["service"]) }),
      );

      expect(context).toEqual({
        principalId: "sheet-db-server",
        visibilityKey: "service:sheet-db-server",
      });
    }),
  );

  it.effect("allows runs.get without workflow.dispatch", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["runs.get"],
        token({
          accountId: "discord-account-1",
          sub: "auth-user-1",
        }),
      );

      expect(context).toEqual({
        principalId: "discord-account-1",
        visibilityKey: "account:discord-account-1",
      });
    }),
  );

  it.effect("allows runs.list without workflow.dispatch", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["runs.list"],
        token({ accountId: "discord-account-1" }),
      );

      expect(context).toEqual({
        principalId: "discord-account-1",
        visibilityKey: "account:discord-account-1",
      });
    }),
  );

  it.effect("allows a batch containing both public run queries", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["runs.get", "runs.list"],
        token({ accountId: "discord-account-1" }),
      );

      expect(context.visibilityKey).toBe("account:discord-account-1");
    }),
  );

  it.effect("accepts existing service clients for calls outside the runs API", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["messageSlot.get"],
        token({
          clientId: "sheet-apis",
          scopes: new Set(["service"]),
        }),
      );

      expect(context).toEqual({
        principalId: "sheet-apis",
        visibilityKey: "service:sheet-apis",
      });
    }),
  );

  it.effect("allows the service caller to batch run and domain procedures", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["runs.list", "messageSlot.get"],
        token({
          clientId: "sheet-apis",
          scopes: new Set(["service"]),
        }),
      );

      expect(context).toEqual({
        principalId: "sheet-apis",
        visibilityKey: "service:sheet-apis",
      });
    }),
  );

  for (const scopes of [[], ["service"], ["ingress.forward"]] as const) {
    it.effect(
      `rejects delegated workflow enqueue with scopes: ${scopes.join(", ") || "none"}`,
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            zeroContextFromToken(
              ["runs.enqueueAsCaller"],
              token({
                clientId: "sheet-ingress",
                scopes: new Set(scopes),
              }),
            ),
          );

          expect(failure(exit)).toMatchObject({
            _tag: "ZeroDispatchUnauthorizedError",
            message: "Delegated workflow enqueue requires service and ingress.forward scopes",
          });
        }),
    );
  }

  it.effect("allows trusted ingress to enqueue a delegated workflow", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["runs.enqueueAsCaller"],
        token({
          clientId: "sheet-ingress",
          scopes: new Set(["service", "ingress.forward"]),
        }),
      );

      expect(context).toEqual({
        principalId: "sheet-ingress",
        visibilityKey: "service:sheet-ingress",
      });
    }),
  );

  it.effect("requires delegated scopes for mixed delegated and domain batches", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["runs.enqueueAsCaller", "messageSlot.mutate"],
        token({
          clientId: "sheet-ingress",
          scopes: new Set(["service", "ingress.forward"]),
        }),
      );

      expect(context).toEqual({
        principalId: "sheet-ingress",
        visibilityKey: "service:sheet-ingress",
      });

      const exit = yield* Effect.exit(
        zeroContextFromToken(
          ["runs.enqueueAsCaller", "messageSlot.mutate"],
          token({
            clientId: "sheet-ingress",
            scopes: new Set(["service"]),
          }),
        ),
      );
      expect(failure(exit)).toMatchObject({
        message: "Delegated workflow enqueue requires service and ingress.forward scopes",
      });
    }),
  );

  it.effect("rejects domain procedures for account tokens", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        zeroContextFromToken(
          ["runs.list", "messageSlot.get"],
          token({
            accountId: "discord-account-1",
            scopes: new Set(["workflow.dispatch"]),
          }),
        ),
      );

      expect(failure(exit)).toMatchObject({
        _tag: "ZeroDispatchUnauthorizedError",
        message: "Access outside the runs API requires service scope",
      });
    }),
  );

  it.effect("requires workflow.dispatch for mixed run query and mutator batches", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        zeroContextFromToken(
          ["runs.list", "runs.command"],
          token({ accountId: "discord-account-1" }),
        ),
      );

      expect(failure(exit)).toMatchObject({
        message: "Runs access token is missing workflow.dispatch",
      });
    }),
  );

  it.effect("allows mixed run query and mutator batches with workflow.dispatch", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["runs.get", "runs.command"],
        token({
          accountId: "discord-account-1",
          scopes: new Set(["workflow.dispatch"]),
        }),
      );

      expect(context.visibilityKey).toBe("account:discord-account-1");
    }),
  );

  it.effect("rejects mixed runs and domain batches without service scope", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        zeroContextFromToken(
          ["runs.command", "messageSlot.get"],
          token({
            accountId: "discord-account-1",
            scopes: new Set(["workflow.dispatch"]),
          }),
        ),
      );

      expect(failure(exit)).toMatchObject({
        message: "Access outside the runs API requires service scope",
      });
    }),
  );

  it.effect("rejects service tokens without a client identity", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        zeroContextFromToken(["messageSlot.get"], token({ scopes: new Set(["service"]) })),
      );

      expect(failure(exit)).toMatchObject({
        message: "Service access token is missing a client identity",
      });
    }),
  );

  it.effect("rejects dispatched run mutations without an account identity", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        zeroContextFromToken(["runs.command"], token({ scopes: new Set(["workflow.dispatch"]) })),
      );

      expect(failure(exit)).toMatchObject({
        message: "Runs access token is missing an account identity",
      });
    }),
  );

  it.effect("uses public visibility for anonymous public run queries", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(["runs.get"], token());

      expect(context).toEqual({ principalId: "anonymous", visibilityKey: "public" });
    }),
  );
});
