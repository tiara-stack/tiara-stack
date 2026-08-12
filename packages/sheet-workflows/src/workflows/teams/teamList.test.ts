import { describe, expect, it } from "@effect/vitest";
import type { sheets_v4 } from "@googleapis/sheets";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import {
  BotDependencyUnavailable,
  DeliveryKey,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { InteractiveDeclaredFailure, TeamsDeliverList } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  makeSheetApisClient,
  makeTrustedSheetPersistenceMock,
  normalizePayloadText,
} from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import {
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import {
  executeTeamsDeliverListLoadAction,
  executeTeamsDeliverListRespondAction,
  makeTeamsDeliverListDefinition,
  makeTeamsDeliverListMessage,
  makeTeamsDeliverListWorkflowBody,
  selectUserTeams,
} from "./definition";
import { boundTeamListFields } from "../shared/teamListRendering";
import {
  isTeamSheetWorkflowName,
  materializeTeamWorkflowFailure,
  TeamSheetWorkflows,
} from "./definitions";
import { makeTeamDeliveryKey } from "./keys";
import { teamWorkflowOperationsLayer } from "./operations";
import {
  isRetryableUserTeamsReadFailure,
  makeUserTeamsProvider,
  UserTeamsProvider,
  UserTeamsProviderError,
} from "./provider";
import { TeamSheetWorkflowRegistrations } from "./registry";
import type { UserTeamsView } from "./schema";
import { TeamWorkflowOperations } from "./service";

const definition = makeTeamsDeliverListDefinition();
const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const input = Schema.decodeUnknownSync(TeamsDeliverList.input)({
  workspaceId: "workspace-1",
  responseReference,
  targetUserId: "account-target",
  targetUsername: "Target_User",
});
const view: UserTeamsView = {
  players: [
    { accountId: "account-target", name: "Target Alias" },
    { accountId: "account-target", name: "Second" },
    { accountId: "account-target", name: "Shared" },
    { accountId: "account-other", name: "Shared" },
  ],
  teams: [
    {
      playerName: "Target Alias",
      teamName: "Low_Team",
      tags: [],
      lead: 1,
      backline: 6,
      talent: null,
    },
    {
      playerName: "Target Alias",
      teamName: "High*Team",
      tags: ["rare_tag"],
      lead: 5,
      backline: 10,
      talent: 12,
    },
    {
      playerName: "Shared",
      teamName: "Ambiguous",
      tags: [],
      lead: 9,
      backline: 9,
      talent: null,
    },
    {
      playerName: "Target Alias",
      teamName: "Hint",
      tags: ["tierer_hint"],
      lead: 99,
      backline: 99,
      talent: null,
    },
    {
      playerName: "Second",
      teamName: "Second (e) | Beta",
      tags: ["fixed", "rare"],
      lead: 4,
      backline: 9,
      talent: 12,
    },
  ],
};
const responseKey = makeTeamDeliveryKey(TeamsDeliverList, invocationId, "respond");
const registration = Option.getOrThrow(
  Option.fromNullishOr(
    TeamSheetWorkflowRegistrations.find(
      ({ contract }) => contract.identity === TeamsDeliverList.identity,
    ),
  ),
);
const workflow = Option.getOrThrow(
  Option.fromNullishOr(
    TeamSheetWorkflows.find(({ name }) => name === workflowContractKey(TeamsDeliverList)),
  ),
);
const receipt = {
  deliveryKey: responseKey,
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};

const makeBot = (
  respond: (request: {
    readonly payload: {
      readonly responseReference: typeof ResponseReference.Type;
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly message: unknown;
    };
  }) => Effect.Effect<unknown, unknown>,
): SheetBotHttpClient => ({ delivery: { respond } }) as unknown as SheetBotHttpClient;

const workspaceConfiguration = (sheetId: string | null) => ({
  workspaceId: "workspace-1",
  sheetId,
  autoCheckin: null,
  monitorConversationId: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});

const makeOperations = (
  provider: UserTeamsProvider["Service"],
  bot: SheetBotHttpClient,
  workspace: Option.Option<ReturnType<typeof workspaceConfiguration>> = Option.some(
    workspaceConfiguration("sheet-1"),
  ),
) =>
  Effect.gen(function* () {
    const persistence = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
    return yield* TeamWorkflowOperations.pipe(
      Effect.provide(teamWorkflowOperationsLayer),
      Effect.provide(
        Layer.succeed(TrustedSheetPersistence, {
          ...persistence,
          workspaces: {
            ...persistence.workspaces,
            getWorkspaceConfigByWorkspaceId: () => Effect.succeed(workspace),
          },
        }),
      ),
      Effect.provide(Layer.succeed(UserTeamsProvider, provider)),
      Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
    );
  });

describe("team-list delivery Workflow Definition slice", () => {
  it("registers the pinned definition and target-user policy v2", () => {
    expect(definition.contract).toBe(TeamsDeliverList);
    expect(definition.workflow.name).toBe(workflowContractKey(TeamsDeliverList));
    expect(definition.actions.map(({ workflow }) => workflow.name)).toEqual([
      "teams.deliverList.load-user-teams",
      "teams.deliverList.respond",
    ]);
    expect(definition.contract.declaredFailure).toBe(InteractiveDeclaredFailure);
    expect(registration.definitionVersion).toBe("1");
    expect(TeamsDeliverList.authorizationPolicy).toMatchObject({
      version: "2",
      principalKinds: ["user"],
      requiredCapabilities: [],
      resource: "workspace",
      resourceField: "workspaceId",
      targetUserField: "targetUserId",
      userRule: "target-user-or-workspace-monitor-or-application-owner",
    });
  });

  it("includes every unambiguous alias and filters ambiguity and tierer hints before sorting", () => {
    expect(selectUserTeams(view, input.targetUserId).map(({ teamName }) => teamName)).toEqual([
      "Second (e) | Beta",
      "High*Team",
      "Low_Team",
    ]);
    expect(selectUserTeams(view, "missing-account")).toEqual([]);
  });

  it("renders exact legacy escaping, tag, ISV, and zero-team content", () => {
    const selected = selectUserTeams(view, input.targetUserId);
    expect(
      normalizePayloadText(makeTeamsDeliverListMessage(input.targetUsername, selected)),
    ).toEqual({
      embeds: [
        {
          title: "Target\\_User's Teams",
          description: null,
          fields: [
            {
              name: "Second \\(e\\) \\| Beta",
              value: "Tags: fixed, rare\nISV: 4/9/12k (+5%)",
            },
            {
              name: "High\\*Team",
              value: "Tags: rare\\_tag\nISV: 5/10/12k (+6%)",
            },
            { name: "Low\\_Team", value: "Tags: None\nISV: 1/6 (+2%)" },
          ],
        },
      ],
    });
    expect(normalizePayloadText(makeTeamsDeliverListMessage("Nobody", []))).toEqual({
      embeds: [{ title: "Nobody's Teams", description: "No teams found", fields: [] }],
    });
  });

  it("bounds fields to Discord limits with the exact overflow summary", () => {
    const fields = boundTeamListFields(
      Array.from({ length: 30 }, (_, index) => ({ name: `Team ${index}`, value: "x" })),
      "Teams",
    );
    expect(fields).toHaveLength(25);
    expect(fields.at(-1)).toEqual({
      name: "More teams",
      value: "6 additional teams were omitted.",
    });
    expect(boundTeamListFields([{ name: "n".repeat(300), value: "v".repeat(1_200) }], "T")).toEqual(
      [{ name: `${"n".repeat(255)}…`, value: `${"v".repeat(1_023)}…` }],
    );
    const characterBounded = boundTeamListFields(
      Array.from({ length: 10 }, (_, index) => ({
        name: `Team ${index}`,
        value: "v".repeat(1_024),
      })),
      "Teams",
    );
    expect(characterBounded).toHaveLength(6);
    expect(characterBounded.at(-1)).toEqual({
      name: "More teams",
      value: "5 additional teams were omitted.",
    });
  });

  it.effect("returns one response receipt as the sole Commit Point", () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = [];
      const body = makeTeamsDeliverListWorkflowBody({
        load: () => Effect.succeed(view),
        respond: ({ message }) => {
          messages.push(message);
          return Effect.succeed(receipt);
        },
      });
      expect(yield* body({ invocationId, principal, input })).toEqual({
        workspaceId: "workspace-1",
        targetUserId: "account-target",
        teamCount: 3,
        deliveryReceipts: [receipt],
      });
      expect(messages).toEqual([
        makeTeamsDeliverListMessage(
          input.targetUsername,
          selectUserTeams(view, input.targetUserId),
        ),
      ]);
    }),
  );

  it.effect("uses deterministic Action Keys and an operation-specific Delivery Key", () =>
    Effect.gen(function* () {
      const message = makeTeamsDeliverListMessage(
        input.targetUsername,
        selectUserTeams(view, input.targetUserId),
      );
      const payload = { invocationId, principal, input, message };
      const actionIds = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      expect(
        yield* Effect.forEach(definition.actions, ({ workflow }) => workflow.executionId(payload)),
      ).toEqual(actionIds);
      expect(new Set(actionIds).size).toBe(2);
      expect(responseKey).toBe(`teams.deliverList:1:${invocationId}:respond`);
    }),
  );

  it.effect(
    "reauthorizes before provider reads and response delivery and observes revocation",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        let authorized = true;
        const services = Layer.mergeAll(
          Layer.succeed(ReadOnlyWorkflowAuthorization, {
            authorize: () => {
              calls.push("authorize");
              return authorized
                ? Effect.void
                : Effect.fail(new WorkflowInvocationUnauthorized({ message: "revoked" }));
            },
            workspaceCapabilities: () => Effect.die("unused"),
          }),
          Layer.succeed(TeamWorkflowOperations, {
            loadUserTeams: () => {
              calls.push("load-user-teams");
              return Effect.succeed(view);
            },
            respond: () => {
              calls.push("respond");
              return Effect.succeed(receipt);
            },
          }),
        );
        yield* executeTeamsDeliverListLoadAction({ invocationId, principal, input }).pipe(
          Effect.provide(services),
        );
        yield* executeTeamsDeliverListRespondAction({
          invocationId,
          principal,
          input,
          message: makeTeamsDeliverListMessage(
            input.targetUsername,
            selectUserTeams(view, input.targetUserId),
          ),
        }).pipe(Effect.provide(services));
        expect(calls).toEqual(["authorize", "load-user-teams", "authorize", "respond"]);
        authorized = false;
        expect(
          yield* Effect.flip(
            executeTeamsDeliverListLoadAction({ invocationId, principal, input }).pipe(
              Effect.provide(services),
            ),
          ),
        ).toEqual({
          _tag: "AuthorizationRevoked",
          policy: TeamsDeliverList.authorizationPolicy.policy,
        });
        calls.length = 0;
        expect(
          yield* Effect.flip(
            executeTeamsDeliverListRespondAction({
              invocationId,
              principal,
              input,
              message: makeTeamsDeliverListMessage(
                input.targetUsername,
                selectUserTeams(view, input.targetUserId),
              ),
            }).pipe(Effect.provide(services)),
          ),
        ).toEqual({
          _tag: "AuthorizationRevoked",
          policy: TeamsDeliverList.authorizationPolicy.policy,
        });
        expect(calls).toEqual(["authorize"]);
      }),
  );

  it.effect("preserves owner isolation", () =>
    Effect.gen(function* () {
      const authorization = {
        authorize: () => Effect.void,
        workspaceCapabilities: () => Effect.die("unused"),
      };
      yield* registration
        .authorize(context, input)
        .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
      const exit = yield* Effect.exit(
        registration
          .authorizeObservation({ ...context, ownerKey: "user:other" })
          .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
          message: "Workflow owner does not match the effective principal",
        });
      }
    }),
  );

  it.effect("resolves trusted workspace state and materializes provider rejection", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const operations = yield* makeOperations(
        {
          load: (spreadsheetId) => {
            calls.push(spreadsheetId);
            return Effect.fail(
              new UserTeamsProviderError({ operation: "read-user-teams", cause: "secret" }),
            );
          },
        },
        makeBot(() => Effect.die("unused")),
      );
      expect(yield* Effect.flip(operations.loadUserTeams(input))).toEqual({
        _tag: "ExternalOperationRejected",
        operation: "teams.deliverList.loadUserTeams",
        code: "ProviderRejected",
        message: "The team provider rejected the user teams read",
      });
      expect(calls).toEqual(["sheet-1"]);
      const configurationFailure = yield* makeOperations(
        {
          load: () =>
            Effect.fail(
              new UserTeamsProviderError({ operation: "read-configuration", cause: "secret" }),
            ),
        },
        makeBot(() => Effect.die("unused")),
      );
      expect(yield* Effect.flip(configurationFailure.loadUserTeams(input))).toEqual({
        _tag: "ConfigurationMissing",
        configuration: "workspace.teamConfiguration",
      });
    }),
  );

  it.effect(
    "fails visibly before provider execution when workspace sheet state is unavailable",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const provider = {
          load: (spreadsheetId: string) => {
            calls.push(spreadsheetId);
            return Effect.succeed(view);
          },
        };
        const cases = [
          {
            workspace: Option.none<ReturnType<typeof workspaceConfiguration>>(),
            expected: {
              _tag: "ResourceNotFound",
              resource: "workspace",
              resourceId: "workspace-1",
            },
          },
          {
            workspace: Option.some(workspaceConfiguration(null)),
            expected: { _tag: "ConfigurationMissing", configuration: "workspace.sheetId" },
          },
        ] as const;
        for (const { expected, workspace } of cases) {
          const operations = yield* makeOperations(
            provider,
            makeBot(() => Effect.die("unused")),
            workspace,
          );
          expect(yield* Effect.flip(operations.loadUserTeams(input))).toEqual(expected);
        }
        expect(calls).toEqual([]);
      }),
  );

  it.effect("reconciles ambiguous response delivery with the same Delivery Key", () =>
    Effect.gen(function* () {
      const keys: Array<typeof DeliveryKey.Type> = [];
      let attempt = 0;
      const operations = yield* makeOperations(
        { load: () => Effect.succeed(view) },
        makeBot(({ payload }) => {
          keys.push(payload.deliveryKey);
          attempt += 1;
          return attempt === 1
            ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous" }))
            : Effect.succeed(receipt);
        }),
      );
      const message = makeTeamsDeliverListMessage(
        input.targetUsername,
        selectUserTeams(view, input.targetUserId),
      );
      expect(
        yield* Effect.flip(
          operations.respond(
            input,
            message,
            responseKey,
            TeamsDeliverList.authorizationPolicy.policy,
          ),
        ),
      ).toMatchObject({
        _tag: "TeamWorkflowOperationsError",
        operation: "teams.deliverList.respond",
      });
      expect(
        yield* operations.respond(
          input,
          message,
          responseKey,
          TeamsDeliverList.authorizationPolicy.policy,
        ),
      ).toEqual(receipt);
      expect(keys).toEqual([responseKey, responseKey]);
    }),
  );

  it.effect("reads team config, identities, and team ranges runner-locally", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const responses = [
        [
          {
            values: [
              [
                "Alpha",
                "Team Sheet",
                "A1:A4",
                "B1:B4",
                "split",
                "C1:C4,D1:D4,E1:E4",
                "ranges",
                "F1:F4",
              ],
              [
                "Beta",
                "Team Sheet",
                "G1:G1",
                "auto",
                "combined",
                "H1:H1",
                "constants",
                "fixed, rare",
              ],
              [
                "Malformed",
                "Team Sheet",
                "I1:I1",
                "auto",
                "split",
                "J1:J1,K1:K1",
                "ranges",
                "L1:L1",
              ],
            ],
          },
          {
            values: [
              ["User IDs", "'Players'!A1:A4"],
              ["User Sheet Names", "'Players'!B1:B4"],
            ],
          },
        ],
        [
          { values: [["Target Alias"], ["Target Alias"], ["shared"], ["Target Alias"]] },
          { values: [["Low_Team"], ["High*Team"], ["Ambiguous"], ["Hint"]] },
          { values: [["1"], ["5"], ["9"], ["99"]] },
          { values: [["6"], ["10"], ["9"], ["99"]] },
          { values: [[], ["12"], [], []] },
          { values: [[], ["rare_tag"], [], ["tierer_hint"]] },
          { values: [["Second (e)"]] },
          { values: [["4/9/12"]] },
          {
            values: [["account-target"], ["account-target"], ["account-target"], ["account-other"]],
          },
          { values: [["Target Alias"], ["Second"], ["shared"], ["shared"]] },
        ],
      ] as const;
      let request = 0;
      const client = {
        spreadsheets: {
          values: {
            batchGet: ({ ranges = [] }: { readonly ranges?: ReadonlyArray<string> }) => {
              calls.push([...ranges]);
              return Promise.resolve({ data: { valueRanges: responses[request++] ?? [] } });
            },
          },
        },
      } as unknown as sheets_v4.Sheets;
      expect(yield* makeUserTeamsProvider(client).load("sheet-1")).toEqual(view);
      expect(calls).toEqual([
        ["'Thee''s Sheet Settings'!E8:M", "'Thee''s Sheet Settings'!B8:C"],
        [
          "'Team Sheet'!A1:A4",
          "'Team Sheet'!B1:B4",
          "'Team Sheet'!C1:C4",
          "'Team Sheet'!D1:D4",
          "'Team Sheet'!E1:E4",
          "'Team Sheet'!F1:F4",
          "'Team Sheet'!G1:G1",
          "'Team Sheet'!H1:H1",
          "'Players'!A1:A4",
          "'Players'!B1:B4",
        ],
      ]);
    }),
  );

  it.live("retries transient provider reads but not permanent failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const provider = makeUserTeamsProvider({
        spreadsheets: {
          values: {
            batchGet: () => {
              attempts += 1;
              if (attempts === 1) return Promise.reject({ response: { status: 503 } });
              return attempts === 2
                ? Promise.resolve({
                    data: {
                      valueRanges: [
                        { values: [] },
                        {
                          values: [
                            ["User IDs", "'Players'!A1:A1"],
                            ["User Sheet Names", "'Players'!B1:B1"],
                          ],
                        },
                      ],
                    },
                  })
                : Promise.resolve({
                    data: {
                      valueRanges: [{ values: [["account-target"]] }, { values: [["Target"]] }],
                    },
                  });
            },
          },
        },
      } as unknown as sheets_v4.Sheets);
      expect(yield* provider.load("sheet-1")).toEqual({
        players: [{ accountId: "account-target", name: "Target" }],
        teams: [],
      });
      expect(attempts).toBe(3);

      let permanentAttempts = 0;
      const failure = yield* Effect.flip(
        makeUserTeamsProvider({
          spreadsheets: {
            values: {
              batchGet: () => {
                permanentAttempts += 1;
                return Promise.reject({ response: { status: 403 } });
              },
            },
          },
        } as unknown as sheets_v4.Sheets).load("sheet-1"),
      );
      expect(failure.operation).toBe("read-configuration");
      expect(permanentAttempts).toBe(1);
    }),
  );

  it("classifies timeouts as safe provider-read retries", () => {
    expect(
      isRetryableUserTeamsReadFailure(
        new UserTeamsProviderError({
          operation: "read-configuration",
          cause: new Cause.TimeoutError(),
        }),
      ),
    ).toBe(true);
  });

  it("materializes only typed Declared Failures and redacts system details", () => {
    const declared = {
      _tag: "ExternalOperationRejected" as const,
      operation: "teams.deliverList.loadUserTeams",
      code: "ProviderRejected",
      message: "The team provider rejected the user teams read",
    };
    expect(isTeamSheetWorkflowName(workflow.name)).toBe(true);
    expect(materializeTeamWorkflowFailure(workflow, Cause.fail(declared))).toEqual({
      _tag: "Declared",
      error: declared,
    });
    expect(materializeTeamWorkflowFailure(workflow, Cause.die("provider-secret"))).toEqual({
      _tag: "System",
      code: "UnexpectedFailure",
      retryable: false,
    });
  });
});
