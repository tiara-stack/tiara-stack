import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { VerifiedOAuthResourceToken } from "sheet-auth/oauth-resource-authorization";
import { zeroContextFromToken } from "./workflowZeroAuthorization";

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
  it.effect("uses an account mailbox visibility key for workflow calls", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["workflow.enqueue"],
        token({
          accountId: "discord-account-1",
          scopes: new Set(["workflow.dispatch"]),
          sub: "auth-user-1",
        }),
      );

      expect(context).toEqual({
        principalId: "discord-account-1",
        visibilityKey: "account:discord-account-1",
      });
    }),
  );

  it.effect("accepts existing service clients for non-workflow calls", () =>
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

  it.effect("allows the service caller to batch workflow and domain procedures", () =>
    Effect.gen(function* () {
      const context = yield* zeroContextFromToken(
        ["workflow.list", "messageSlot.get"],
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

  it.effect("rejects domain procedures for account tokens", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        zeroContextFromToken(
          ["workflow.list", "messageSlot.get"],
          token({
            accountId: "discord-account-1",
            scopes: new Set(["workflow.dispatch"]),
          }),
        ),
      );

      expect(failure(exit)).toMatchObject({
        _tag: "ZeroDispatchUnauthorizedError",
        message: "Non-workflow Zero access requires service scope",
      });
    }),
  );
});
