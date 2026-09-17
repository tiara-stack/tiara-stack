import { describe, expect, it } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIInteraction } from "dfx/types";
import { AuthorizationLoadWorkspaceCapabilities } from "sheet-workflow-contracts";
import { Cause, Duration, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { TestClock } from "effect/testing";
import { workflowInvocationIdFromString } from "sheet-workflow-http-client";
import { readConfigurationAttachment } from "./sheet";
import { requireSheetConfigurationManageAccess } from "./sheet";

const interaction = { user: { id: "123456789012345679" } } as unknown as APIInteraction;

describe("Sheet Configuration attachment transport", () => {
  it.effect("drains a rejected redirect response before failing", () =>
    Effect.gen(function* () {
      let response: Response | undefined;
      const requestClient = HttpClient.make((request) => {
        response = new Response("redirect body", { status: 302 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const exit = yield* Effect.exit(
        readConfigurationAttachment(requestClient, {
          filename: "sheet-configuration.json",
          size: 15,
          url: "https://cdn.discordapp.com/attachments/1/sheet-configuration.json",
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "SheetCommandError",
        message: "The attached configuration file could not be downloaded.",
      });
      expect(response?.bodyUsed).toBe(true);
    }),
  );

  it.effect("observes permission checks through one owner-scoped subscription", () =>
    Effect.gen(function* () {
      const reference = {
        invocationId: workflowInvocationIdFromString("123e4567-e89b-42d3-a456-426614174000"),
        contractIdentity: AuthorizationLoadWorkspaceCapabilities.identity,
        wireVersion: AuthorizationLoadWorkspaceCapabilities.wireVersion,
      } as const;
      const capabilities = Schema.decodeUnknownSync(AuthorizationLoadWorkspaceCapabilities.success)(
        {
          workspaceId: "123456789012345680",
          capabilities: ["manage"],
        },
      );
      const now = new Date();
      let enqueueCount = 0;
      let observedUserId: string | undefined;
      const result = yield* requireSheetConfigurationManageAccess(
        {
          authorizationLoadWorkspaceCapabilities: {
            enqueue: () => {
              enqueueCount += 1;
              return Effect.succeed(reference);
            },
            get: () => Stream.never,
            list: () => Stream.never,
          },
        },
        (userId, observedReference) => {
          observedUserId = typeof userId === "string" ? userId : undefined;
          expect(observedReference).toEqual(reference);
          return Stream.fromIterable([
            Option.none(),
            Option.some({
              reference,
              result: { _tag: "Pending" as const, phase: "Queued" as const },
              submittedAt: now,
              updatedAt: now,
            }),
            Option.some({
              reference,
              result: { _tag: "Success" as const, value: capabilities, completedAt: now },
              submittedAt: now,
              updatedAt: now,
            }),
          ]);
        },
        "123456789012345680",
      ).pipe(Effect.provideService(Ix.Interaction, interaction));

      expect(result).toBeUndefined();
      expect(enqueueCount).toBe(1);
      expect(observedUserId).toBe("123456789012345679");
    }),
  );

  it.effect("keeps a typed permission failure terminal without re-enqueueing", () =>
    Effect.gen(function* () {
      const reference = {
        invocationId: workflowInvocationIdFromString("123e4567-e89b-42d3-a456-426614174000"),
        contractIdentity: AuthorizationLoadWorkspaceCapabilities.identity,
        wireVersion: AuthorizationLoadWorkspaceCapabilities.wireVersion,
      } as const;
      const failure = Schema.decodeUnknownSync(
        AuthorizationLoadWorkspaceCapabilities.declaredFailure,
      )({
        _tag: "AuthorizationRevoked",
        policy: "workspace.member",
      });
      let enqueueCount = 0;
      const exit = yield* Effect.exit(
        requireSheetConfigurationManageAccess(
          {
            authorizationLoadWorkspaceCapabilities: {
              enqueue: () => {
                enqueueCount += 1;
                return Effect.succeed(reference);
              },
              get: () => Stream.never,
              list: () => Stream.never,
            },
          },
          () =>
            Stream.succeed(
              Option.some({
                reference,
                result: {
                  _tag: "Failure" as const,
                  failure: {
                    _tag: "Declared" as const,
                    error: failure,
                  },
                  completedAt: new Date(),
                },
                submittedAt: new Date(),
                updatedAt: new Date(),
              }),
            ),
          "123456789012345680",
        ).pipe(Effect.provideService(Ix.Interaction, interaction)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(enqueueCount).toBe(1);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SheetCommandError",
          message: "Could not verify Sheet Configuration access. Try again.",
        });
      }
    }),
  );

  it.effect("does not re-enqueue when permission observation times out", () =>
    Effect.gen(function* () {
      const reference = {
        invocationId: workflowInvocationIdFromString("123e4567-e89b-42d3-a456-426614174000"),
        contractIdentity: AuthorizationLoadWorkspaceCapabilities.identity,
        wireVersion: AuthorizationLoadWorkspaceCapabilities.wireVersion,
      } as const;
      let enqueueCount = 0;
      const fiber = yield* Effect.exit(
        requireSheetConfigurationManageAccess(
          {
            authorizationLoadWorkspaceCapabilities: {
              enqueue: () => {
                enqueueCount += 1;
                return Effect.succeed(reference);
              },
              get: () => Stream.never,
              list: () => Stream.never,
            },
          },
          () => Stream.succeed(Option.none()).pipe(Stream.concat(Stream.never)),
          "123456789012345680",
        ).pipe(Effect.provideService(Ix.Interaction, interaction)),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(60));
      const timedOut = yield* Fiber.join(fiber);
      expect(Exit.isFailure(timedOut)).toBe(true);
      expect(enqueueCount).toBe(1);
      if (Exit.isFailure(timedOut)) {
        expect(Cause.squash(timedOut.cause)).toMatchObject({
          _tag: "SheetCommandError",
          message: "The Sheet Configuration permission check timed out.",
        });
      }
    }),
  );
});
