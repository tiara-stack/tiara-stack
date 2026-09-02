import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import { EffectivePrincipal } from "sheet-auth/identity";
import { BotDependencyUnavailable } from "sheet-bot-api";
import { CalculationsRecalculateSheet } from "sheet-workflow-contracts";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { workflowTestInvocationId as invocationId } from "../shared/testHelpers";
import { makeTrustedSheetPersistenceMock } from "../../services/testHelpers";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { calculationWorkflowOperationsLayer } from "./operations";
import {
  CalculationProviderError,
  CalculationProjectionWriteError,
  CalculationTargetError,
  CalculationProvider,
  type CalculationProviderShape,
} from "./provider";
import { CalculationWorkflowOperations } from "./service";
import type { CalculationSourceSnapshot } from "./schema";

const spreadsheetId = "spreadsheet-1";
const canonicalSheetRef = "Calculation!AX30:CC";
const installationIdentity = `apps-script.installation:${spreadsheetId}`;
const principal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "service",
  serviceId: installationIdentity,
  oauthClientId: installationIdentity,
});
const input = Schema.decodeUnknownSync(CalculationsRecalculateSheet.input)({
  spreadsheetId,
  sheetRef: canonicalSheetRef,
  hour: 7,
  config: { cc: false, considerEnc: false, healNeeded: 0 },
  players: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name) => ({
    name,
    encable: false,
  })),
  fixedTeams: [],
});
const execution = {
  invocationId,
  principal,
  input,
  sheetTitle: "Calculation",
  canonicalSheetRef,
};
const snapshot: CalculationSourceSnapshot = {
  sheetId: 42,
  sheetTitle: "Calculation",
  canonicalSheetRef,
  preWriteProjection: [[6, "old"], ["stale"]],
  settingsRows: [],
  teamConfigurationRows: [],
  sourceRanges: [],
};
const writeExecution = {
  ...execution,
  source: {
    sheetId: 42,
    sheetTitle: "Calculation",
    canonicalSheetRef,
    preWriteProjection: snapshot.preWriteProjection,
    players: input.players.map(({ name }) => ({ name, teams: [] })),
    failure: null,
  },
  projection: {
    rows: [
      [7, ""],
      [1, 2, 3],
    ],
    outputRange: "AX31:CC31",
    roomCount: 1,
    failure: null,
  },
};

const errorFrom = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

const unusedAuthorizationMethods = {
  authorizeSlotOpen: () => Effect.die("unused"),
  authorizeCheckinRespond: () => Effect.die("unused"),
  authorizeRoomOrdersNavigate: () => Effect.die("unused"),
  authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
  authorizeRoomOrdersSend: () => Effect.die("unused"),
  workspaceCapabilities: () => Effect.die("unused"),
};

const makeOperations = (options: {
  readonly authorize: () => Effect.Effect<
    void,
    WorkflowInvocationUnauthorized | BotDependencyUnavailable
  >;
  readonly provider: CalculationProviderShape;
}) =>
  CalculationWorkflowOperations.pipe(
    Effect.provide(calculationWorkflowOperationsLayer),
    Effect.provideService(ReadOnlyWorkflowAuthorization, {
      ...unusedAuthorizationMethods,
      authorize: () => options.authorize(),
    }),
    Effect.provideService(CalculationProvider, options.provider),
    Effect.provideService(TrustedSheetPersistence, makeTrustedSheetPersistenceMock()),
  );

const provider = (overrides: Partial<CalculationProviderShape> = {}): CalculationProviderShape => ({
  load: () => Effect.succeed(snapshot),
  readProjection: () => Effect.die("unused"),
  replaceProjection: () => Effect.die("unused"),
  ...overrides,
});

const ambiguous = () =>
  new CalculationProjectionWriteError({ ambiguous: true, cause: "private-provider-cause" });

describe("sheet recalculation operations", () => {
  it.effect("revalidates immediately before the grouped source read", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const operations = yield* makeOperations({
        authorize: () => Effect.sync(() => void effects.push("authorize")),
        provider: provider({
          load: () => Effect.sync(() => (effects.push("read"), snapshot)),
        }),
      });
      expect(yield* operations.load(execution)).toEqual({
        sheetId: snapshot.sheetId,
        sheetTitle: snapshot.sheetTitle,
        canonicalSheetRef: snapshot.canonicalSheetRef,
        preWriteProjection: snapshot.preWriteProjection,
        players: input.players.map(({ name }) => ({ name, teams: [] })),
        failure: {
          _tag: "ConfigurationMissing",
          configuration: "spreadsheet.calculationTeams",
        },
      });
      expect(effects).toEqual(["authorize", "read"]);
    }),
  );

  it.effect("fails closed on revocation and leaves the provider untouched", () =>
    Effect.gen(function* () {
      let read = false;
      const operations = yield* makeOperations({
        authorize: () =>
          Effect.fail(new WorkflowInvocationUnauthorized({ message: "authorization was revoked" })),
        provider: provider({
          load: () => Effect.sync(() => ((read = true), snapshot)),
        }),
      });
      const exit = yield* Effect.exit(operations.load(execution));
      expect(read).toBe(false);
      expect(errorFrom(exit)).toEqual({
        _tag: "AuthorizationRevoked",
        policy: CalculationsRecalculateSheet.authorizationPolicy.policy,
      });
    }),
  );

  it.effect("keeps authorization dependency failure retryable as an action defect", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations({
        authorize: () =>
          Effect.fail(new BotDependencyUnavailable({ message: "cache unavailable" })),
        provider: provider(),
      });
      const exit = yield* Effect.exit(operations.load(execution));
      expect(errorFrom(exit)).toMatchObject({
        _tag: "CalculationWorkflowOperationsError",
        operation: "calculations.recalculateSheet.load-calculation-source.authorize",
      });
    }),
  );

  it.effect("maps target lookup failures to invalid requests", () =>
    Effect.gen(function* () {
      for (const code of ["MissingSheet", "NonCanonicalSheet"] as const) {
        const operations = yield* makeOperations({
          authorize: () => Effect.void,
          provider: provider({
            load: () => Effect.fail(new CalculationTargetError({ code })),
          }),
        });
        const exit = yield* Effect.exit(operations.load(execution));
        expect(errorFrom(exit)).toMatchObject({
          _tag: "InvalidRequest",
          code,
        });
      }
    }),
  );

  it.effect("maps provider load failures to an external rejection", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          load: () =>
            Effect.fail(
              new CalculationProviderError({ operation: "read-source", cause: "provider-defect" }),
            ),
        }),
      });
      const exit = yield* Effect.exit(operations.load(execution));
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ProviderRejected",
      });
    }),
  );

  it.effect("revalidates even when the exact desired projection is already present", () =>
    Effect.gen(function* () {
      let authorizations = 0;
      let writes = 0;
      const operations = yield* makeOperations({
        authorize: () => Effect.sync(() => void authorizations++),
        provider: provider({
          readProjection: () => Effect.succeed([[7], [1, 2, 3]]),
          replaceProjection: () => Effect.sync(() => void writes++),
        }),
      });
      const result = yield* operations.write({
        ...writeExecution,
        source: {
          ...writeExecution.source,
          preWriteProjection: [[7], [1, 2, 3]],
        },
      });
      expect(result.disposition).toBe("reconciled");
      expect(authorizations).toBe(1);
      expect(writes).toBe(0);
    }),
  );

  it.effect("maps an exact-state reconciliation read failure to provider rejection", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          readProjection: () =>
            Effect.fail(
              new CalculationProviderError({
                operation: "read-projection",
                cause: "shortcut-read-failed",
              }),
            ),
          replaceProjection: () => Effect.die("unused"),
        }),
      });
      const exit = yield* Effect.exit(
        operations.write({
          ...writeExecution,
          source: { ...writeExecution.source, preWriteProjection: writeExecution.projection.rows },
        }),
      );
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ProviderRejected",
      });
    }),
  );

  it.effect("rejects a changed live projection instead of trusting stale pre-write state", () =>
    Effect.gen(function* () {
      let writes = 0;
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          readProjection: () => Effect.succeed([[7], [9, 9, 9]]),
          replaceProjection: () => Effect.sync(() => void writes++),
        }),
      });
      const exit = yield* Effect.exit(
        operations.write({
          ...writeExecution,
          source: {
            ...writeExecution.source,
            preWriteProjection: writeExecution.projection.rows,
          },
        }),
      );
      expect(writes).toBe(0);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ProjectionWriteRejected",
      });
    }),
  );

  it.effect("fails closed before the projection write on revocation or dependency failure", () =>
    Effect.gen(function* () {
      for (const authorizationFailure of [
        new WorkflowInvocationUnauthorized({ message: "revoked" }),
        new BotDependencyUnavailable({ message: "cache unavailable" }),
      ]) {
        let writes = 0;
        const operations = yield* makeOperations({
          authorize: () => Effect.fail(authorizationFailure),
          provider: provider({
            replaceProjection: () => Effect.sync(() => void writes++),
          }),
        });
        const exit = yield* Effect.exit(operations.write(writeExecution));
        expect(writes).toBe(0);
        expect(errorFrom(exit)._tag).toBe(
          authorizationFailure._tag === "WorkflowInvocationUnauthorized"
            ? "AuthorizationRevoked"
            : "CalculationWorkflowOperationsError",
        );
      }
    }),
  );

  it.effect("confirms an ambiguous write from exact desired state", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const operations = yield* makeOperations({
        authorize: () => Effect.sync(() => void effects.push("authorize")),
        provider: provider({
          replaceProjection: () =>
            Effect.sync(() => void effects.push("write")).pipe(
              Effect.andThen(Effect.fail(ambiguous())),
            ),
          readProjection: () =>
            Effect.sync(() => (effects.push("observe"), writeExecution.projection.rows)),
        }),
      });
      expect((yield* operations.write(writeExecution)).disposition).toBe("reconciled");
      expect(effects).toEqual(["authorize", "write", "observe"]);
    }),
  );

  it.effect("reports an unconfirmed outcome when reconciliation cannot read the projection", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          replaceProjection: () => Effect.fail(ambiguous()),
          readProjection: () =>
            Effect.fail(
              new CalculationProviderError({
                operation: "read-projection",
                cause: "reconciliation-read-failed",
              }),
            ),
        }),
      });
      const exit = yield* Effect.exit(operations.write(writeExecution));
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ProjectionWriteUnconfirmed",
      });
    }),
  );

  it.effect("safely retries only after exact pre-write state and fresh authorization", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      let writes = 0;
      const operations = yield* makeOperations({
        authorize: () => Effect.sync(() => void effects.push("authorize")),
        provider: provider({
          replaceProjection: () =>
            Effect.sync(() => {
              effects.push("write");
              writes++;
              return writes;
            }).pipe(
              Effect.flatMap((attempt) => (attempt === 1 ? Effect.fail(ambiguous()) : Effect.void)),
            ),
          readProjection: () =>
            Effect.sync(() => (effects.push("observe"), snapshot.preWriteProjection)),
        }),
      });
      expect((yield* operations.write(writeExecution)).disposition).toBe("confirmed");
      expect(effects).toEqual(["authorize", "write", "observe", "authorize", "write"]);
    }),
  );

  it.effect("rejects a non-ambiguous projection write without observing state", () =>
    Effect.gen(function* () {
      let observations = 0;
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          replaceProjection: () =>
            Effect.fail(
              new CalculationProjectionWriteError({ ambiguous: false, cause: "invalid-range" }),
            ),
          readProjection: () =>
            Effect.sync(() => {
              observations++;
              return snapshot.preWriteProjection;
            }),
        }),
      });
      const exit = yield* Effect.exit(operations.write(writeExecution));
      expect(observations).toBe(0);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ProjectionWriteRejected",
      });
    }),
  );

  it.effect("maps a live pre-write conflict to a conflicting outcome", () =>
    Effect.gen(function* () {
      let observations = 0;
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          replaceProjection: () =>
            Effect.fail(
              new CalculationProjectionWriteError({
                ambiguous: false,
                conflicting: true,
                cause: "the projection changed",
              }),
            ),
          readProjection: () =>
            Effect.sync(() => {
              observations++;
              return snapshot.preWriteProjection;
            }),
        }),
      });
      const exit = yield* Effect.exit(operations.write(writeExecution));
      expect(observations).toBe(0);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ConflictingAmbiguousOutcome",
      });
    }),
  );

  it.effect("stops after an ambiguous retry remains unconfirmed", () =>
    Effect.gen(function* () {
      let writes = 0;
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          replaceProjection: () => {
            writes++;
            return Effect.fail(ambiguous());
          },
          readProjection: () => Effect.succeed(snapshot.preWriteProjection),
        }),
      });
      const exit = yield* Effect.exit(operations.write(writeExecution));
      expect(writes).toBe(2);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ProjectionWriteUnconfirmed",
      });
    }),
  );

  it.effect("preserves an unexpected provider defect instead of remapping it", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          replaceProjection: () => Effect.die("provider-defect"),
        }),
      });
      const exit = yield* Effect.exit(operations.write(writeExecution));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect("does not retry when authorization is revoked at the second revalidation", () =>
    Effect.gen(function* () {
      let authorizations = 0;
      let writes = 0;
      const operations = yield* makeOperations({
        authorize: () => {
          authorizations++;
          return authorizations === 1
            ? Effect.void
            : Effect.fail(new WorkflowInvocationUnauthorized({ message: "revoked" }));
        },
        provider: provider({
          replaceProjection: () => {
            writes++;
            return Effect.fail(ambiguous());
          },
          readProjection: () => Effect.succeed(snapshot.preWriteProjection),
        }),
      });
      const exit = yield* Effect.exit(operations.write(writeExecution));
      expect(writes).toBe(1);
      expect(errorFrom(exit)._tag).toBe("AuthorizationRevoked");
    }),
  );

  it.effect("preserves a conflicting third state and refuses a blind overwrite", () =>
    Effect.gen(function* () {
      let writes = 0;
      const operations = yield* makeOperations({
        authorize: () => Effect.void,
        provider: provider({
          replaceProjection: () => {
            writes++;
            return Effect.fail(ambiguous());
          },
          readProjection: () => Effect.succeed([[999, "operator edit"]]),
        }),
      });
      const exit = yield* Effect.exit(operations.write(writeExecution));
      expect(writes).toBe(1);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "ExternalOperationRejected",
        code: "ConflictingAmbiguousOutcome",
      });
    }),
  );
});
