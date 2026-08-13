import { expect } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { validateWorkflowContractRegistrations } from "effect-zero-workflow";
import { InvocationId, type AnyWorkflowContract } from "effect-zero-workflow/contract";
import { DiscordAccountId, UserId } from "sheet-auth/identity";
import type { SheetWorkflowRegistration } from "./registration";

const workflowTestUserId = Schema.decodeUnknownSync(UserId)("user-1");
export const workflowTestAccountId = Schema.decodeUnknownSync(DiscordAccountId)("discord-1");
export const workflowTestPrincipal = {
  kind: "user" as const,
  userId: workflowTestUserId,
  discordAccount: { accountId: workflowTestAccountId },
};
export const workflowTestContext = {
  ownerKey: "user:user-1",
  principal: workflowTestPrincipal,
};
export const workflowTestInvocationId = Schema.decodeUnknownSync(InvocationId)(
  "123e4567-e89b-42d3-a456-426614174000",
);

export const assertRegistrationValidationFails = (
  contracts: ReadonlyArray<AnyWorkflowContract>,
  registrations: ReadonlyArray<SheetWorkflowRegistration>,
) =>
  Effect.gen(function* () {
    const missing = yield* Effect.exit(
      validateWorkflowContractRegistrations(contracts, registrations.slice(1)),
    );
    const duplicate = yield* Effect.exit(
      validateWorkflowContractRegistrations(contracts, [...registrations, registrations[0]!]),
    );
    if (Exit.isSuccess(missing) || Exit.isSuccess(duplicate)) {
      throw new Error("Expected registration validation to fail");
    }
    const missingError = Option.getOrThrow(Cause.findErrorOption(missing.cause));
    const duplicateError = Option.getOrThrow(Cause.findErrorOption(duplicate.cause));
    expect(missingError.reason).toBe("MissingRegistration");
    expect(duplicateError.reason).toBe("DuplicateRegistration");
  });

export const makeRecordingWorkflowAuthorization = (calls: Array<unknown>) => ({
  authorize: (contract: unknown, principal: unknown, input: unknown) => {
    calls.push({ contract, principal, input });
    return Effect.void;
  },
  authorizeSlotOpen: () => Effect.die("unused"),
  authorizeCheckinRespond: () => Effect.die("unused"),
  workspaceCapabilities: () => Effect.die("unused"),
});
