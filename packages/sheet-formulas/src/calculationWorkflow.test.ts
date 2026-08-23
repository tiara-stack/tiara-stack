import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";
import { SheetWorkflowContracts } from "sheet-workflow-contracts";
import {
  calculationStatus,
  calculationStatusForError,
  calculationStatusForOutcome,
  calculationInputFingerprint,
  makeCalculationInvocationId,
  makeCalculationSheetReference,
  submitCalculation,
  workflowHttpConfiguration,
  type CalculationInput,
  type CalculationProperties,
} from "./calculationWorkflow";

const input = Schema.decodeUnknownSync(SheetWorkflowContracts.calculations.recalculateSheet.input)({
  spreadsheetId: "spreadsheet-a",
  sheetRef: "Raid!AX30:CC",
  hour: 12,
  config: { cc: false, considerEnc: true, healNeeded: 1 },
  players: [
    { name: "one", encable: true },
    { name: "two", encable: true },
    { name: "three", encable: true },
    { name: "four", encable: true },
    { name: "five", encable: true },
  ],
  fixedTeams: [],
});

const properties = (
  events: Array<string>,
  persistedInvocationId: string | null = null,
): CalculationProperties => {
  const values = new Map<string, string>();
  if (persistedInvocationId !== null) {
    values.set("SHEET_FORMULAS_CALCULATION_INVOCATION_ID", persistedInvocationId);
  }

  return {
    getProperty: (name) => values.get(name) ?? null,
    setProperty: (name, value) => {
      values.set(name, value);
      events.push(`property:${name}:${value}`);
    },
    deleteProperty: (name) => {
      values.delete(name);
      events.push(`deleteProperty:${name}`);
    },
  };
};

const serializedInvocation = (invocationId: string, overrides = {}) =>
  JSON.stringify({
    invocationId,
    spreadsheetId: input.spreadsheetId,
    sheetRef: input.sheetRef,
    inputFingerprint: calculationInputFingerprint(input),
    ...overrides,
  });

describe("Apps Script calculation workflow submission", () => {
  it.effect("persists one invocation ID and reuses it across an ambiguous retry", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const invocationId = yield* makeWorkflowInvocationId();
      let attempts = 0;
      const client = {
        enqueue: (
          _input: CalculationInput,
          options: { readonly invocationId: typeof invocationId },
        ) =>
          Effect.sync(() => {
            attempts += 1;
            events.push(`request:${options.invocationId}`);
            if (attempts === 1) {
              return Effect.fail({
                _tag: "WorkflowTransportUnavailable",
                operation: "Enqueue",
                retryable: true,
                message: "temporary transport failure",
              });
            }
            return Effect.succeed({ invocationId: options.invocationId });
          }).pipe(Effect.flatten),
      };

      yield* submitCalculation({
        properties: properties(events),
        client,
        input,
        invocationId,
        beforeRequest: Effect.sync(() => events.push("status:Submitting")),
      });

      expect(events).toEqual([
        `property:SHEET_FORMULAS_CALCULATION_INVOCATION_ID:${serializedInvocation(invocationId)}`,
        "status:Submitting",
        `request:${invocationId}`,
        `request:${invocationId}`,
        "deleteProperty:SHEET_FORMULAS_CALCULATION_INVOCATION_ID",
      ]);
    }),
  );

  it.effect("keeps the persisted invocation ID after retry exhaustion", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const invocationId = yield* makeWorkflowInvocationId();
      const client = {
        enqueue: (
          _input: CalculationInput,
          options: { readonly invocationId: typeof invocationId },
        ) =>
          Effect.sync(() => {
            events.push(`request:${options.invocationId}`);
            return Effect.fail({
              _tag: "WorkflowTransportUnavailable",
              operation: "Enqueue",
              retryable: true,
              message: "temporary transport failure",
            });
          }).pipe(Effect.flatten),
      };

      const exit = yield* Effect.exit(
        submitCalculation({
          properties: properties(events),
          client,
          input,
          invocationId,
          beforeRequest: Effect.sync(() => events.push("status:Submitting")),
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(events).toEqual([
        `property:SHEET_FORMULAS_CALCULATION_INVOCATION_ID:${serializedInvocation(invocationId)}`,
        "status:Submitting",
        `request:${invocationId}`,
        `request:${invocationId}`,
      ]);
    }),
  );

  it.effect("reuses a matching persisted invocation ID", () =>
    Effect.gen(function* () {
      const persistedId = "123e4567-e89b-42d3-a456-426614174000";
      const reusedEvents: Array<string> = [];
      const reusedId = yield* makeCalculationInvocationId(
        properties(reusedEvents, serializedInvocation(persistedId)),
        input,
      );

      expect(reusedId).toBe(persistedId);
      expect(reusedEvents).toEqual([]);

      const reorderedInput: CalculationInput = {
        fixedTeams: input.fixedTeams,
        players: input.players.map(({ name, encable }) => ({ encable, name })),
        config: {
          healNeeded: input.config.healNeeded,
          considerEnc: input.config.considerEnc,
          cc: input.config.cc,
        },
        hour: input.hour,
        sheetRef: input.sheetRef,
        spreadsheetId: input.spreadsheetId,
      };
      const reorderedEvents: Array<string> = [];
      const reorderedId = yield* makeCalculationInvocationId(
        properties(reorderedEvents, serializedInvocation(persistedId)),
        reorderedInput,
      );

      expect(reorderedId).toBe(persistedId);
      expect(reorderedEvents).toEqual([]);
    }),
  );

  it.effect("uses the injected invocation ID generator", () =>
    Effect.gen(function* () {
      const generatedId = "123e4567-e89b-42d3-a456-426614174000";
      const events: Array<string> = [];
      const invocationId = yield* makeCalculationInvocationId(properties(events), input, () =>
        makeWorkflowInvocationId(() => generatedId),
      );

      expect(invocationId).toBe(generatedId);
      expect(events).toEqual([]);
    }),
  );

  it.effect("deletes and regenerates a persisted ID for a sheet reference mismatch", () =>
    Effect.gen(function* () {
      const persistedId = "123e4567-e89b-42d3-a456-426614174000";
      const mismatchedEvents: Array<string> = [];
      const mismatchedId = yield* makeCalculationInvocationId(
        properties(
          mismatchedEvents,
          serializedInvocation(persistedId, { sheetRef: "Other!AX30:CC" }),
        ),
        input,
      );

      expect(mismatchedId).not.toBe(persistedId);
      expect(mismatchedEvents).toEqual(["deleteProperty:SHEET_FORMULAS_CALCULATION_INVOCATION_ID"]);
    }),
  );

  it.effect("deletes and regenerates an invalid persisted ID", () =>
    Effect.gen(function* () {
      const invalidEvents: Array<string> = [];
      const generatedId = yield* makeCalculationInvocationId(
        properties(invalidEvents, "not-an-invocation-id"),
        input,
      );

      expect(generatedId).not.toBe("not-an-invocation-id");
      expect(invalidEvents).toEqual(["deleteProperty:SHEET_FORMULAS_CALCULATION_INVOCATION_ID"]);
    }),
  );

  it("projects accepted, definitive rejection, and ambiguous transport outcomes", () => {
    expect(calculationStatusForOutcome("accepted")).toBe(calculationStatus.queued);
    expect(calculationStatusForOutcome("definitive-rejection")).toBe(calculationStatus.didNotStart);
    expect(
      calculationStatusForError({
        _tag: "WorkflowInputRejected",
        message: "invalid input",
      }),
    ).toBe(calculationStatus.didNotStart);
    expect(
      calculationStatusForError({
        _tag: "WorkflowTransportUnavailable",
        operation: "Enqueue",
        retryable: true,
        message: "request outcome is ambiguous",
      }),
    ).toBe(calculationStatus.submitting);
  });

  it.effect("binds workflow configuration and calculation sheet references", () =>
    Effect.gen(function* () {
      const configuration = yield* workflowHttpConfiguration(
        {
          getProperty: (name) =>
            ({
              SHEET_WORKFLOWS_HTTP_BASE_URL: "https://workflows.example.test",
              SHEET_AUTH_ISSUER: "https://auth.example.test",
              SHEET_WORKFLOWS_HTTP_CLIENT_SECRET: "secret",
            })[name] ?? null,
          setProperty: () => undefined,
          deleteProperty: () => undefined,
        },
        "spreadsheet-a",
      );

      expect(configuration.baseUrl).toBe("https://workflows.example.test");
      expect(configuration.authIssuer).toBe("https://auth.example.test");
      expect(configuration.clientId).toBe("apps-script.installation:spreadsheet-a");
      expect(Redacted.value(configuration.clientSecret)).toBe("secret");
    }),
  );

  it.effect("rejects incomplete workflow configuration", () =>
    Effect.gen(function* () {
      const missingSecret = yield* Effect.exit(
        workflowHttpConfiguration(
          {
            getProperty: (name) =>
              ({
                SHEET_WORKFLOWS_HTTP_BASE_URL: "https://workflows.example.test",
                SHEET_AUTH_ISSUER: "https://auth.example.test",
              })[name] ?? null,
            setProperty: () => undefined,
            deleteProperty: () => undefined,
          },
          "spreadsheet-a",
        ),
      );
      const whitespaceSecret = yield* Effect.exit(
        workflowHttpConfiguration(
          {
            getProperty: (name) =>
              ({
                SHEET_WORKFLOWS_HTTP_BASE_URL: "https://workflows.example.test",
                SHEET_AUTH_ISSUER: "https://auth.example.test",
                SHEET_WORKFLOWS_HTTP_CLIENT_SECRET: "   ",
              })[name] ?? null,
            setProperty: () => undefined,
            deleteProperty: () => undefined,
          },
          "spreadsheet-a",
        ),
      );

      expect(Exit.isFailure(missingSecret)).toBe(true);
      expect(Exit.isFailure(whitespaceSecret)).toBe(true);
    }),
  );

  it("formats calculation sheet references", () => {
    expect(makeCalculationSheetReference("Raid_Night")).toBe("Raid_Night!AX30:CC");
    expect(makeCalculationSheetReference("Raid Night")).toBe("'Raid Night'!AX30:CC");
    expect(makeCalculationSheetReference("Q1")).toBe("'Q1'!AX30:CC");
    expect(makeCalculationSheetReference("AX30")).toBe("'AX30'!AX30:CC");
    expect(makeCalculationSheetReference("D23")).toBe("'D23'!AX30:CC");
    expect(makeCalculationSheetReference("O'Brien")).toBe("'O''Brien'!AX30:CC");
  });
});
