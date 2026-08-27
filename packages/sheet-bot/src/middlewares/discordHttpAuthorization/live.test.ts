import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import type { VerifiedOAuthResourceToken } from "sheet-auth/oauth-resource-authorization";
import { authorizeSheetBotAdmission, isHealthProbeRequest, sheetBotAdmissionForPath } from "./live";

const token = (
  scopes: ReadonlySet<string>,
  input: Partial<VerifiedOAuthResourceToken> = {},
): VerifiedOAuthResourceToken => ({
  accountId: undefined,
  actorClientId: undefined,
  actorSub: undefined,
  clientId: "sheet-workflows",
  exp: undefined,
  scopes,
  sub: undefined,
  ...input,
});

describe("sheet bot HTTP authorization", () => {
  it("allows Kubernetes health probes without authorization", () => {
    expect(
      isHealthProbeRequest(HttpServerRequest.fromWeb(new Request("http://localhost/live"))),
    ).toBe(true);
    expect(
      isHealthProbeRequest(HttpServerRequest.fromWeb(new Request("http://localhost/ready"))),
    ).toBe(true);
  });

  it("keeps non-health routes protected", () => {
    expect(
      isHealthProbeRequest(HttpServerRequest.fromWeb(new Request("http://localhost/application"))),
    ).toBe(false);
    expect(
      isHealthProbeRequest(
        HttpServerRequest.fromWeb(new Request("http://localhost/live", { method: "POST" })),
      ),
    ).toBe(false);
  });

  it("classifies typed capability paths and denies other routes", () => {
    expect(
      sheetBotAdmissionForPath("/internal/bot/clients/discord/discord-main/workspaces/workspace-1"),
    ).toBe("cache");
    expect(sheetBotAdmissionForPath("/internal/bot/delivery/messages/send")).toBe("delivery");
    expect(sheetBotAdmissionForPath("/internal/bot/%64elivery/messages/send")).toBe("delivery");
    expect(sheetBotAdmissionForPath("/internal/bot/unknown")).toBe("denied");
    expect(sheetBotAdmissionForPath("/internal/bot/%ZZ")).toBe("denied");
    expect(sheetBotAdmissionForPath("/bot/interactions/original-response")).toBe("denied");
  });

  it.effect("admits scoped service principals to typed routes", () =>
    authorizeSheetBotAdmission("cache", token(new Set(["bot.cache.read"]))),
  );

  it.effect("rejects users and missing capability scopes", () =>
    Effect.gen(function* () {
      const userDenied = yield* Effect.exit(
        authorizeSheetBotAdmission(
          "delivery",
          token(new Set(["bot.delivery.write"]), { sub: "user-1" }),
        ),
      );
      expect(Exit.isFailure(userDenied)).toBe(true);
      if (Exit.isSuccess(userDenied)) return;
      expect(Cause.squash(userDenied.cause)).toMatchObject({
        _tag: "BotAdmissionDenied",
        message: "Sheet-bot capability routes require a Service Principal",
      });

      const scopeDenied = yield* Effect.exit(
        authorizeSheetBotAdmission("delivery", token(new Set(["bot.cache.read"]))),
      );
      expect(Exit.isFailure(scopeDenied)).toBe(true);
      if (Exit.isSuccess(scopeDenied)) return;
      expect(Cause.squash(scopeDenied.cause)).toMatchObject({
        _tag: "BotAdmissionDenied",
        message: "Missing sheet-bot capability scope: bot.delivery.write",
      });
    }),
  );

  it.effect("denies unmatched internal bot routes", () =>
    Effect.gen(function* () {
      const denied = yield* Effect.exit(authorizeSheetBotAdmission("denied", token(new Set())));
      expect(Exit.isFailure(denied)).toBe(true);
      if (Exit.isSuccess(denied)) return;
      expect(Cause.squash(denied.cause)).toMatchObject({
        _tag: "BotAdmissionDenied",
        message: "Unsupported internal sheet-bot route",
      });
    }),
  );
});
