import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect";
import { Entity, ShardingConfig } from "effect/unstable/cluster";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import { EffectivePrincipal } from "sheet-auth/identity";
import { CalculationDeclaredFailure, CalculationsRecalculateSheet } from "sheet-workflow-contracts";
import {
  CalculationProjectionEntity,
  makeCalculationProjectionEntityLayer,
} from "@/entities/calculationProjection";
import { workflowTestInvocationId as invocationId } from "../shared/testHelpers";
import { authorizeAppsScriptInstallation } from "../readOnly/authorization";
import { calculateProjection, calculationFailureProjection } from "./calculation";
import {
  makeCalculationsRecalculateSheetDefinition,
  makeCalculationsRecalculateSheetSerializedBody,
  makeCalculationsRecalculateSheetWorkflowBody,
} from "./definition";
import {
  calculationActionIdentities,
  makeCalculationActionKey,
  makeCalculationSerializationKey,
} from "./keys";
import { calculationResultRange, canonicalCalculationSheetRef } from "./range";
import { CalculationWriteExecution, maximumPersistedCalculationPayloadBytes } from "./schema";
import type {
  CalculationProjection,
  CalculationSource,
  CalculationSourceSnapshot,
  CalculationSourceTeam,
} from "./schema";
import { decodeCalculationSource } from "./source";

const spreadsheetId = "spreadsheet-1";
const canonicalSheetRef = "Calculation!AX30:CC";
const installationIdentity = `apps-script.installation:${spreadsheetId}`;
const principal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "service",
  serviceId: installationIdentity,
  oauthClientId: installationIdentity,
});
const userPrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "user",
  userId: "user-1",
});
const input = Schema.decodeUnknownSync(CalculationsRecalculateSheet.input)({
  spreadsheetId,
  sheetRef: canonicalSheetRef,
  hour: 7,
  config: { cc: false, considerEnc: false, healNeeded: 0 },
  players: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name, index) => ({
    name,
    encable: index === 0,
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

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 10,
  sendRetryInterval: 100,
});

const sourceTeam = (name: string, index: number): CalculationSourceTeam => ({
  type: "Unit",
  playerId: `player-${index}`,
  playerName: name,
  teamName: `${name} Team`,
  tags: index === 0 ? ["tierer_hint"] : [],
  lead: 10 + index,
  backline: 5 + index,
  talent: 100 + index,
});

const calculationSource = (overrides: Partial<CalculationSource> = {}): CalculationSource => ({
  sheetId: 42,
  sheetTitle: "Calculation",
  canonicalSheetRef,
  preWriteProjection: [
    [6, "old"],
    [1, 2, 3],
  ],
  players: input.players.map(({ name }, index) => ({
    name,
    teams: [sourceTeam(name, index)],
  })),
  failure: null,
  ...overrides,
});

const calculationSourceWithCandidates = (candidateCount: number): CalculationSource =>
  calculationSource({
    players: input.players.map(({ name }, playerIndex) => ({
      name,
      teams: Array.from({ length: candidateCount }, (_, candidateIndex) =>
        sourceTeam(name, playerIndex * candidateCount + candidateIndex),
      ),
    })),
  });

const errorFrom = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

describe("sheet recalculation workflow", () => {
  it("accepts only non-negative integer room counts in result ranges", () => {
    expect(calculationResultRange(0)).toBe("AX31:CC31");
    expect(calculationResultRange(2)).toBe("AX31:CC32");
    expect(calculationResultRange(3)).toBe("AX31:CC33");
    expect(() => calculationResultRange(Number.NaN)).toThrow(RangeError);
    expect(() => calculationResultRange(1.5)).toThrow(RangeError);
    expect(() => calculationResultRange(-1)).toThrow(RangeError);
    expect(() => calculationResultRange(10_000_000)).toThrow(RangeError);
  });

  it("registers exactly the pinned v1 workflow and two v1 actions", () => {
    const definition = makeCalculationsRecalculateSheetDefinition();
    expect(definition.contract).toBe(CalculationsRecalculateSheet);
    expect(definition.workflow.name).toBe(workflowContractKey(CalculationsRecalculateSheet));
    expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
      ["calculations.recalculateSheet.load-calculation-source", "1"],
      ["calculations.recalculateSheet.write-calculation-projection", "1"],
    ]);
    expect(CalculationsRecalculateSheet).toMatchObject({
      wireVersion: "1",
      authorizationPolicy: {
        version: "1",
        principalKinds: ["service"],
        requiredCapabilities: ["service.allowed"],
        resource: "spreadsheet",
        resourceField: "spreadsheetId",
        serviceRule: "apps-script.installation",
        revalidateBeforeEffects: true,
      },
    });
  });

  it("requires canonical sheet identity on persisted write executions", () => {
    const writeExecution = {
      ...execution,
      source: calculationSource(),
      projection: {
        rows: [[7]],
        outputRange: "AX31:CC31",
        roomCount: 0,
        failure: null,
      },
    };
    expect(Schema.is(CalculationWriteExecution)(writeExecution)).toBe(true);
    expect(Schema.is(CalculationWriteExecution)({ ...writeExecution, sheetTitle: "Other" })).toBe(
      false,
    );
    expect(
      Schema.is(CalculationWriteExecution)({
        ...writeExecution,
        canonicalSheetRef: "Other!AX30:CC",
      }),
    ).toBe(false);
  });

  it("canonicalizes only one sheet's exact AX30:CC projection", () => {
    expect(canonicalCalculationSheetRef(" Calculation!ax30:cc ")).toEqual({
      sheetTitle: "Calculation",
      sheetRef: canonicalSheetRef,
    });
    expect(canonicalCalculationSheetRef("'Room Order'!AX30:CC")).toEqual({
      sheetTitle: "Room Order",
      sheetRef: "'Room Order'!AX30:CC",
    });
    expect(canonicalCalculationSheetRef("'Owner''s Calc'!AX30:CC")).toEqual({
      sheetTitle: "Owner's Calc",
      sheetRef: "'Owner''s Calc'!AX30:CC",
    });
    expect(canonicalCalculationSheetRef("' Calc '!AX30:CC")).toEqual({
      sheetTitle: " Calc ",
      sheetRef: "' Calc '!AX30:CC",
    });
    expect(canonicalCalculationSheetRef("K!AX30:CC")).toEqual({
      sheetTitle: "K",
      sheetRef: "'K'!AX30:CC",
    });
    expect(canonicalCalculationSheetRef("Calc !AX30:CC")).toEqual({
      sheetTitle: "Calc ",
      sheetRef: "'Calc '!AX30:CC",
    });
    for (const invalid of [
      "Calculation!AX31:CC",
      "Calculation!AX30:CB",
      "Calculation!A1",
      "AX30:CC",
      "Calculation!AX30:CC,Other!A1",
      "''!AX30:CC",
    ]) {
      expect(canonicalCalculationSheetRef(invalid)).toBeUndefined();
    }
  });

  it.effect("accepts only the bound Apps Script installation identity", () =>
    Effect.gen(function* () {
      const policy = CalculationsRecalculateSheet.authorizationPolicy;
      yield* authorizeAppsScriptInstallation(principal, input, policy);
      const rejected = [
        userPrincipal,
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "other-service",
          oauthClientId: installationIdentity,
        }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: installationIdentity,
          oauthClientId: "other-client",
        }),
      ];
      for (const candidate of rejected) {
        const exit = yield* Effect.exit(authorizeAppsScriptInstallation(candidate, input, policy));
        expect(errorFrom(exit)._tag).toBe("WorkflowInvocationUnauthorized");
      }
      for (const target of [
        { ...input, spreadsheetId: "other-spreadsheet" },
        { ...input, sheetRef: "Calculation!AX31:CC" },
        { ...input, sheetRef: "not-a-range" },
        { ...input, spreadsheetId: undefined },
        { ...input, spreadsheetId: 42 },
        { ...input, sheetRef: undefined },
        { ...input, sheetRef: 42 },
      ]) {
        const exit = yield* Effect.exit(authorizeAppsScriptInstallation(principal, target, policy));
        expect(errorFrom(exit)._tag).toBe("WorkflowInvocationUnauthorized");
      }
      for (const field of [
        "accessToken",
        "credentials",
        "googleCredentials",
        "oauthToken",
        "providerCredentials",
      ]) {
        const exit = yield* Effect.exit(
          authorizeAppsScriptInstallation(principal, { ...input, [field]: "caller-token" }, policy),
        );
        expect(errorFrom(exit)._tag).toBe("WorkflowInvocationUnauthorized");
      }
    }),
  );

  it("derives stable action and serialization keys from pinned logical identity", () => {
    const loadKey = makeCalculationActionKey(
      invocationId,
      calculationActionIdentities.load,
      spreadsheetId,
      canonicalSheetRef,
    );
    expect(
      makeCalculationActionKey(
        invocationId,
        calculationActionIdentities.load,
        spreadsheetId,
        canonicalSheetRef,
      ),
    ).toBe(loadKey);
    expect(
      makeCalculationActionKey(
        invocationId,
        calculationActionIdentities.write,
        spreadsheetId,
        canonicalSheetRef,
      ),
    ).not.toBe(loadKey);
    expect(makeCalculationSerializationKey(spreadsheetId, canonicalSheetRef)).toBe(
      makeCalculationSerializationKey(spreadsheetId, canonicalSheetRef),
    );
    expect(makeCalculationSerializationKey(spreadsheetId, "Other!AX30:CC")).not.toBe(
      makeCalculationSerializationKey(spreadsheetId, canonicalSheetRef),
    );
    expect(
      makeCalculationSerializationKey(spreadsheetId, `'${"x".repeat(500)}'!AX30:CC`).length,
    ).toBeLessThanOrEqual(255);
    expect(
      makeCalculationActionKey(
        invocationId,
        calculationActionIdentities.load,
        spreadsheetId,
        `'${"x".repeat(500)}'!AX30:CC`,
      ).length,
    ).toBeLessThanOrEqual(255);
  });

  it.live("serializes distinct invocations in accepted order by canonical projection", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<Array<string>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const layer = makeCalculationProjectionEntityLayer({
        run: ({ payload }) =>
          Effect.gen(function* () {
            const current = payload.invocationId === invocationId ? 1 : 2;
            yield* Ref.update(events, (items) => [...items, `${current}:start`]);
            if (current === 1) {
              yield* Deferred.succeed(firstStarted, void 0);
              yield* Deferred.await(releaseFirst);
            } else {
              yield* Deferred.succeed(secondStarted, void 0);
              yield* Deferred.await(releaseSecond);
            }
            yield* Ref.update(events, (items) => [...items, `${current}:end`]);
            return {
              spreadsheetId: input.spreadsheetId,
              sheetRef: input.sheetRef,
              hour: input.hour,
              outputRange: "AX31:CC31",
              roomCount: 1,
            };
          }),
      });
      const clientFor = yield* Entity.makeTestClient(CalculationProjectionEntity, layer);
      const client = yield* clientFor(
        makeCalculationSerializationKey(spreadsheetId, canonicalSheetRef),
      );
      const first = yield* client.run(execution).pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* client
        .run({
          ...execution,
          invocationId: Schema.decodeUnknownSync(InvocationId)(
            "22222222-2222-4222-8222-222222222222",
          ),
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirst, void 0);
      yield* Deferred.await(secondStarted);
      expect(yield* Ref.get(events)).toEqual(["1:start", "1:end", "2:start"]);
      yield* Deferred.succeed(releaseSecond, void 0);
      yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(yield* Ref.get(events)).toEqual(["1:start", "1:end", "2:start", "2:end"]);
    }).pipe(Effect.provide(TestShardingConfig)),
  );

  it.effect("preserves the legacy five-player row layout, ordering, and averages", () =>
    Effect.gen(function* () {
      const projection = yield* calculateProjection(input, calculationSource());
      expect(projection).toMatchObject({
        outputRange: "AX31:CC31",
        roomCount: 1,
        failure: null,
      });
      expect(projection.rows[0]).toEqual([7, ""]);
      expect(projection.rows[1]).toHaveLength(32);
      expect(projection.rows[1]?.slice(0, 2)).toEqual([102, 11]);
      expect(projection.rows[1]?.slice(2, 8)).toEqual([
        "Alpha Team",
        10,
        5,
        9,
        100,
        "encable, tierer_hint",
      ]);
      expect(projection.rows[1]?.slice(26, 32)).toEqual(["Echo Team", 14, 9, 13, 104, ""]);
    }),
  );

  it.effect("keeps the calculation frontier ordered and drops equal-effect ties", () =>
    Effect.gen(function* () {
      const frontierSource = calculationSource({
        players: input.players.map(({ name }, playerIndex) => ({
          name,
          teams: [
            {
              ...sourceTeam(name, playerIndex * 2),
              playerName: name,
              teamName: `${name} Low`,
              lead: 1,
              backline: 1,
              talent: 0,
              tags: [],
            },
            {
              ...sourceTeam(name, playerIndex * 2 + 1),
              playerName: name,
              teamName: `${name} High`,
              lead: 10,
              backline: 10,
              talent: 100,
              tags: [],
            },
          ],
        })),
      });
      const projection = yield* calculateProjection(input, frontierSource);
      expect(projection.roomCount).toBe(6);
      expect(projection.rows.slice(1).map((row) => row.slice(0, 2))).toEqual([
        [100, 10],
        [80, 8.2],
        [60, 6.4],
        [40, 4.6],
        [20, 2.8],
        [0, 1],
      ]);
    }),
  );

  it.effect("applies fixed, heal, encore, cc, and empty-result semantics", () =>
    Effect.gen(function* () {
      const configured = {
        ...input,
        config: { cc: false, considerEnc: true, healNeeded: 1 },
        fixedTeams: [{ name: "Alpha Team", heal: true }],
      };
      const projection = yield* calculateProjection(configured, calculationSource());
      expect(projection.roomCount).toBe(1);
      const tags = String(projection.rows[1]?.[7]).split(", ");
      expect(tags).toContain("fixed");
      expect(tags).toContain("heal");
      expect(tags).toContain("enc");

      const missingTalent = calculationSource({
        players: input.players.map(({ name }, index) => ({
          name,
          teams: [{ ...sourceTeam(name, index), talent: null }],
        })),
      });
      const nonCcProjection = yield* calculateProjection(input, missingTalent);
      expect(nonCcProjection.rows[1]?.[2]).toBe("Alpha Team");
      const ccProjection = yield* calculateProjection(
        { ...input, config: { ...input.config, cc: true } },
        missingTalent,
      );
      expect(ccProjection.rows[1]?.[2]).toBe("Placeholder");

      const healedOnly = yield* calculateProjection(
        { ...input, config: { ...input.config, healNeeded: 1 } },
        calculationSource(),
      );
      expect(healedOnly.rows).toEqual([[7, ""]]);
    }),
  );

  it.effect("fails safely when the calculation search space exceeds its bound", () =>
    Effect.gen(function* () {
      const oversized = calculationSource({
        players: input.players.map(({ name }, playerIndex) => ({
          name,
          teams: Array.from({ length: 11 }, (_, teamIndex) =>
            sourceTeam(`${name}-${teamIndex}`, playerIndex * 11 + teamIndex),
          ),
        })),
      });
      const exit = yield* Effect.exit(calculateProjection(input, oversized));
      expect(errorFrom(exit)).toMatchObject({
        _tag: "BusinessRuleRejected",
        code: "CalculationSearchSpaceTooLarge",
      });
    }),
  );

  it.effect("supports the bounded seven-candidate room frontier", () =>
    Effect.gen(function* () {
      const result = yield* calculateProjection(input, calculationSourceWithCandidates(7));
      expect(result.roomCount).toBe(31);
    }),
  );

  it.effect("rejects the next candidate frontier beyond the room bound", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        calculateProjection(input, calculationSourceWithCandidates(8)),
      );
      expect(errorFrom(exit)).toMatchObject({
        _tag: "BusinessRuleRejected",
        code: "CalculationSearchSpaceTooLarge",
      });
    }),
  );

  it.effect("rejects duplicate fixed team names", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        calculateProjection(
          {
            ...input,
            fixedTeams: [
              { name: "Alpha Team", heal: false },
              { name: "Alpha Team", heal: true },
            ],
          },
          calculationSource(),
        ),
      );
      expect(errorFrom(exit)).toMatchObject({
        _tag: "InvalidRequest",
        code: "DuplicateFixedTeam",
      });
    }),
  );

  it("renders bounded deterministic failure projections", () => {
    const failure: typeof CalculationDeclaredFailure.Type = {
      _tag: "ConfigurationMissing",
      configuration: "spreadsheet.calculationTeams",
    };
    expect(calculationFailureProjection(7, failure)).toEqual({
      rows: [[7, "CALCULATION_CONFIGURATION_MISSING: Sheet configuration is incomplete"]],
      outputRange: "AX31:CC31",
      roomCount: 0,
      failure,
    });
  });

  it("decodes grouped raw source data in pure control flow", () => {
    const snapshot: CalculationSourceSnapshot = {
      sheetId: 42,
      sheetTitle: "Calculation",
      canonicalSheetRef,
      preWriteProjection: [[6, "old"]],
      settingsRows: [
        ["User IDs", "Users!A2:A"],
        ["User Sheet Names", "Users!B2:B"],
      ],
      teamConfigurationRows: [
        ["Unit", "Teams", "A2:A", "B2:B", "split", "C2:C,D2:D,E2:E", "ranges", "F2:F"],
      ],
      sourceRanges: [
        { range: "Users!A2:A", rows: [["p1"], ["p2"], ["p3"], ["p4"], ["p5"]] },
        {
          range: "Users!B2:B",
          rows: [["alpha"], ["bravo"], ["charlie"], ["delta"], ["echo"]],
        },
        {
          range: "'Teams'!A2:A",
          rows: [["alpha (enc)"], ["bravo"], ["charlie"], ["delta"], ["echo"]],
        },
        {
          range: "'Teams'!B2:B",
          rows: [["Alpha Team"], ["Bravo Team"], ["Charlie Team"], ["Delta Team"], ["Echo Team"]],
        },
        { range: "'Teams'!C2:C", rows: [[10], [11], [12], [13], [14]] },
        { range: "'Teams'!D2:D", rows: [[5], [6], [7], [8], [9]] },
        { range: "'Teams'!E2:E", rows: [[100], [101], [102], [103], [104]] },
        { range: "'Teams'!F2:F", rows: [["tierer_hint"], [], [], [], []] },
      ],
    };
    const decoded = decodeCalculationSource(
      snapshot,
      input.players.map(({ name }) => name),
    );
    expect(decoded.failure).toBeNull();
    expect(decoded.players.map(({ teams }) => teams.length)).toEqual([1, 1, 1, 1, 1]);
    expect(decoded.players[0]?.teams[0]).toMatchObject({
      playerId: "p1",
      playerName: "Alpha",
      teamName: "Alpha Team",
      lead: 10,
      backline: 5,
      talent: 100,
      tags: ["tierer_hint"],
    });
    expect(
      decodeCalculationSource(
        { ...snapshot, settingsRows: [] },
        input.players.map(({ name }) => name),
      ).failure,
    ).toEqual({
      _tag: "ConfigurationMissing",
      configuration: "spreadsheet.calculationTeams",
    });
    expect(
      decodeCalculationSource(
        {
          ...snapshot,
          sourceRanges: snapshot.sourceRanges.slice(0, -1),
        },
        input.players.map(({ name }) => name),
      ).failure,
    ).toEqual({
      _tag: "InvalidRequest",
      code: "IncompleteCalculationSource",
      message: "The provider read did not include every configured calculation range",
    });
    const oversizedProjection = decodeCalculationSource(
      {
        ...snapshot,
        preWriteProjection: [Array.from({ length: 33 }, () => 1)],
      },
      input.players.map(({ name }) => name),
    );
    expect(oversizedProjection.failure).toMatchObject({
      _tag: "InvalidRequest",
      code: "CalculationProjectionPayloadTooLarge",
    });
    expect(oversizedProjection.preWriteProjection).toEqual([]);
    const duplicatePlayerSnapshot = {
      ...snapshot,
      sourceRanges: snapshot.sourceRanges.map((sourceRange) =>
        sourceRange.range === "Users!B2:B"
          ? { ...sourceRange, rows: [["alpha"], ["alpha"], ["charlie"], ["delta"], ["echo"]] }
          : sourceRange,
      ),
    };
    const decodedDuplicate = decodeCalculationSource(
      duplicatePlayerSnapshot,
      input.players.map(({ name }) => name),
    );
    expect(decodedDuplicate.players[0]?.teams).toHaveLength(1);
    expect(decodedDuplicate.players[0]?.teams[0]?.playerId).toBe("p1");
    expect(decodedDuplicate.failure).toMatchObject({
      _tag: "InvalidRequest",
      code: "InvalidCalculationSource",
    });
    const missingPlayerSnapshot = {
      ...snapshot,
      sourceRanges: snapshot.sourceRanges.map((sourceRange) =>
        sourceRange.range === "Users!B2:B"
          ? { ...sourceRange, rows: [["alpha"], ["missing"], ["charlie"], ["delta"], ["echo"]] }
          : sourceRange,
      ),
    };
    expect(
      decodeCalculationSource(
        missingPlayerSnapshot,
        input.players.map(({ name }) => name),
      ).failure,
    ).toMatchObject({
      _tag: "InvalidRequest",
      code: "InvalidCalculationSource",
    });
    const unrequestedDuplicateSnapshot = {
      ...snapshot,
      sourceRanges: snapshot.sourceRanges.map((sourceRange) =>
        sourceRange.range === "Users!A2:A"
          ? {
              ...sourceRange,
              rows: [["p1"], ["p2"], ["p3"], ["p4"], ["p5"], ["p6"], ["p7"]],
            }
          : sourceRange.range === "Users!B2:B"
            ? {
                ...sourceRange,
                rows: [
                  ["alpha"],
                  ["bravo"],
                  ["charlie"],
                  ["delta"],
                  ["echo"],
                  ["unused"],
                  ["unused"],
                ],
              }
            : sourceRange,
      ),
    };
    expect(
      decodeCalculationSource(
        unrequestedDuplicateSnapshot,
        input.players.map(({ name }) => name),
      ).failure,
    ).toBeNull();
  });

  it.effect("writes a safe failure projection before materializing its declared failure", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const snapshot: CalculationSourceSnapshot = {
        sheetId: 42,
        sheetTitle: "Calculation",
        canonicalSheetRef,
        preWriteProjection: [[6, "old"], ["stale"]],
        settingsRows: [],
        teamConfigurationRows: [],
        sourceRanges: [],
      };
      let capturedProjection: CalculationProjection | undefined;
      const exit = yield* Effect.exit(
        makeCalculationsRecalculateSheetSerializedBody({
          load: () =>
            Effect.sync(() =>
              decodeCalculationSource(
                snapshot,
                input.players.map(({ name }) => name),
              ),
            ).pipe(Effect.tap(() => Effect.sync(() => effects.push("load")))),
          write: ({ projection }) =>
            Effect.sync(() => {
              effects.push("write");
              capturedProjection = projection;
              return {
                disposition: "confirmed" as const,
                outputRange: projection.outputRange,
                roomCount: 0,
              };
            }),
        })(execution),
      );
      expect(effects).toEqual(["load", "write"]);
      expect(capturedProjection?.rows).toEqual([
        [7, "CALCULATION_CONFIGURATION_MISSING: Sheet configuration is incomplete"],
      ]);
      expect(errorFrom(exit)).toEqual({
        _tag: "ConfigurationMissing",
        configuration: "spreadsheet.calculationTeams",
      });
    }),
  );

  it.effect(
    "writes a failure projection when the pre-write snapshot is near the payload limit",
    () =>
      Effect.gen(function* () {
        const calculationFailureCell = 1_234_567_890_123_456;
        const calculationFailureRowWidth = 32;
        const approximateRowBytes =
          calculationFailureRowWidth * (String(calculationFailureCell).length + 1) + 2;
        const calculationFailureRowCount = Math.floor(
          maximumPersistedCalculationPayloadBytes / approximateRowBytes,
        );
        const preWriteProjection = Array.from({ length: calculationFailureRowCount }, () =>
          Array.from({ length: calculationFailureRowWidth }, () => calculationFailureCell),
        );
        const failure: typeof CalculationDeclaredFailure.Type = {
          _tag: "ConfigurationMissing",
          configuration: "spreadsheet.calculationTeams",
        };
        const source = calculationSource({ preWriteProjection, failure });
        let writes = 0;
        let capturedFailure: typeof CalculationDeclaredFailure.Type | null = null;
        const exit = yield* Effect.exit(
          makeCalculationsRecalculateSheetSerializedBody({
            load: () => Effect.succeed(source),
            write: ({ projection }) =>
              Effect.sync(() => {
                writes++;
                capturedFailure = projection.failure;
                return {
                  disposition: "confirmed" as const,
                  outputRange: projection.outputRange,
                  roomCount: projection.roomCount,
                };
              }),
          })(execution),
        );
        expect(writes).toBe(1);
        expect(capturedFailure).toEqual(failure);
        expect(errorFrom(exit)).toEqual(failure);
      }),
  );

  it.effect("preserves an oversized projection failure without an unsafe write", () =>
    Effect.gen(function* () {
      let writes = 0;
      const snapshot: CalculationSourceSnapshot = {
        sheetId: 42,
        sheetTitle: "Calculation",
        canonicalSheetRef,
        preWriteProjection: [Array.from({ length: 33 }, () => 1)],
        settingsRows: [],
        teamConfigurationRows: [],
        sourceRanges: [],
      };
      const exit = yield* Effect.exit(
        makeCalculationsRecalculateSheetSerializedBody({
          load: () =>
            Effect.succeed(
              decodeCalculationSource(
                snapshot,
                input.players.map(({ name }) => name),
              ),
            ),
          write: () =>
            Effect.sync(() => {
              writes++;
              return {
                disposition: "confirmed" as const,
                outputRange: "AX31:CC31",
                roomCount: 0,
              };
            }),
        })(execution),
      );
      expect(writes).toBe(0);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "InvalidRequest",
        code: "CalculationProjectionPayloadTooLarge",
      });
    }),
  );

  it.effect("rejects an oversized complete write payload before dispatching the write action", () =>
    Effect.gen(function* () {
      let writes = 0;
      const oversizedTags = "x".repeat(maximumPersistedCalculationPayloadBytes + 1);
      const source = calculationSource({
        players: calculationSource().players.map((player, playerIndex) =>
          playerIndex === 0
            ? {
                ...player,
                teams: player.teams.map((team) => ({ ...team, tags: [oversizedTags] })),
              }
            : player,
        ),
      });
      const exit = yield* Effect.exit(
        makeCalculationsRecalculateSheetSerializedBody({
          load: () => Effect.succeed(source),
          write: () =>
            Effect.sync(() => {
              writes++;
              return {
                disposition: "confirmed" as const,
                outputRange: "AX31:CC31",
                roomCount: 0,
              };
            }),
        })(execution),
      );
      expect(writes).toBe(0);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "InvalidRequest",
        code: "CalculationProjectionPayloadTooLarge",
      });
    }),
  );

  it.effect("rejects malformed ranges before entering serialized execution", () =>
    Effect.gen(function* () {
      let reached = false;
      const exit = yield* Effect.exit(
        makeCalculationsRecalculateSheetWorkflowBody({
          runSerialized: () =>
            Effect.sync(() => {
              reached = true;
              return {
                spreadsheetId: input.spreadsheetId,
                sheetRef: input.sheetRef,
                hour: input.hour,
                outputRange: "AX31:CC31",
                roomCount: 0,
              };
            }),
        })({
          ...execution,
          input: Schema.decodeUnknownSync(CalculationsRecalculateSheet.input)({
            ...input,
            sheetRef: "Calculation!A1",
          }),
        }),
      );
      expect(reached).toBe(false);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "InvalidRequest",
        code: "InvalidCalculationSheetReference",
      });
    }),
  );
});
