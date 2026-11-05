import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import {
  defaultWorkflowRunListLimit,
  InvocationId,
  makeRunReference,
  type AnyWorkflowContract,
  type WorkflowRun,
  type WorkflowRunListFilter,
  workflowContractKey,
} from "effect-zero-workflow/contract";
import { workflowHttpRouteManifest } from "effect-zero-workflow/contract/http";
import {
  workflowHttpServerExecutorFromHandler,
  type WorkflowHttpServerExecutor,
} from "effect-zero-workflow/contract/http/server";
import {
  WorkflowObservationInvalidData,
  WorkflowEnqueueRequest,
  workflowContractRoutes,
} from "effect-zero-workflow/contract/transport";
import {
  ScreenshotsCaptureAndDeliver,
  SheetWorkflowContractCatalog,
} from "sheet-workflow-contracts";
import { getSheetDbMigrationArtifactDigest } from "sheet-zero-server/state-plane-admission";
import type { SheetWorkflowZeroContext } from "sheet-zero-server";
import { vi } from "vitest";
import { producerApiRoutesLayer } from "../http";
import { sheetWorkflowContractCatalogDigest } from "../workflows/catalogIdentity";
import {
  makeWorkflowHttpRoutesLayer,
  makeWorkflowInvocationStore,
  contextFromToken,
  workflowHttpRoutesLayer,
  type WorkflowHttpAuthorizer,
} from "./workflowHttp";
import { WorkflowStore } from "effect-zero-workflow";
import { ReadOnlyWorkflowAuthorization } from "@/workflows/readOnly/authorization";
import { screenshotShardGroups } from "@/workflows/screenshots/definition";
import { isBrowserRunnerFleetReady } from "../services/clusterReadiness";
import {
  browserRunnerCapabilityGroupFor,
  browserRunnerCapabilityIdentity,
} from "../services/browserRunnerCapability";

const sheetDbMigrationArtifactDigest = getSheetDbMigrationArtifactDigest();

const routeManifest = workflowHttpRouteManifest(SheetWorkflowContractCatalog);
const makeBrowserReadinessSqlClient = (
  isReady: (sql: string, parameters: ReadonlyArray<unknown>) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const rowsFor = (sql: string, parameters: ReadonlyArray<unknown>) =>
      Effect.succeed([{ ready: isReady(sql, parameters) }]);
    const connection: Connection = {
      execute: rowsFor,
      executeRaw: () => Effect.succeed(undefined),
      executeStream: () => Stream.empty,
      executeValues: () => Effect.succeed([]),
      executeUnprepared: rowsFor,
    };

    return yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer));
  });

const browserReadinessForGroups =
  (
    groups: ReadonlyArray<{
      readonly group: string;
      readonly count: number;
      readonly owner?: string;
    }>,
  ) =>
  (sql: string, parameters: ReadonlyArray<unknown>) => {
    const groupPatterns = parameters.filter(
      (parameter): parameter is string => typeof parameter === "string" && parameter.endsWith(":%"),
    );
    const requiredLockCounts = parameters.filter(
      (parameter): parameter is number => typeof parameter === "number" && parameter === 300,
    );
    const owners = new Set(groups.map(({ owner }) => owner ?? "browser-runner-a"));
    return (
      sql.includes("runner.healthy = TRUE") &&
      sql.includes("runner.last_heartbeat > NOW()") &&
      sql.split('"sheet_workflows_locks".address = runner.address').length - 1 === 2 &&
      (sql.match(/"sheet_workflows_locks"\.shard_id LIKE \?/g)?.length ?? 0) === 2 &&
      groupPatterns.length === 2 &&
      requiredLockCounts.length === 2 &&
      [...owners].some((owner) =>
        groupPatterns.every((pattern) => {
          const group = pattern.slice(0, -2);
          return (
            groups
              .filter((row) => (row.owner ?? "browser-runner-a") === owner)
              .filter((row) => row.group === group)
              .reduce((count, row) => count + row.count, 0) === 300
          );
        }),
      )
    );
  };

const requestPath = (path: string) => path.replace(":invocationId", "not-an-invocation-id");

const authorizedToken = {
  accountId: "account-1",
  actorClientId: undefined,
  actorSub: undefined,
  clientId: "test-client",
  exp: undefined,
  scopes: new Set(["workflow.enqueue", "workflow.observe"]),
  sub: "user-1",
} as const;

const authorized = {
  requireAuthorizedHeaders: () => Effect.succeed(authorizedToken),
  requireAuthorizedBearerToken: () => Effect.succeed(authorizedToken),
} satisfies WorkflowHttpAuthorizer;

const gatewayServiceToken = {
  accountId: undefined,
  actorClientId: undefined,
  actorSub: undefined,
  clientId: "sheet-bot-client",
  exp: undefined,
  scopes: new Set(["service", "workflow.enqueue"]),
  sub: undefined,
} as const;

const routeRequest = (method: string, path: string, body?: string) =>
  new Request(`http://localhost${requestPath(path)}`, {
    method,
    ...(body === undefined ? {} : { body }),
  });

const readSseBody = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    if (response.body._tag !== "Stream") {
      return yield* Effect.die("Expected an SSE stream response");
    }
    const chunks = yield* Stream.runCollect(response.body.stream);
    return Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join("");
  });

describe("sheet workflow HTTP contract boundary", () => {
  it.effect("maps the gateway OAuth client to the configured service identity", () =>
    Effect.gen(function* () {
      const context = yield* contextFromToken(gatewayServiceToken, {
        serviceId: "sheet-bot.gateway",
        oauthClientId: "sheet-bot-client",
      });

      expect(context).toMatchObject({
        ownerKey: "service:sheet-bot.gateway",
        principal: {
          kind: "service",
          serviceId: "sheet-bot.gateway",
          oauthClientId: "sheet-bot-client",
        },
      });
    }),
  );

  it.effect("mounts every generated enqueue and observation route exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(routeManifest).toHaveLength(SheetWorkflowContractCatalog.length * 3);
        const routeKeys = routeManifest.map(({ method, path }) => `${method} ${path}`);
        expect(new Set(routeKeys).size).toBe(routeKeys.length);
        const browserReadinessSqlClient = yield* makeBrowserReadinessSqlClient();

        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ issuer: "https://issuer.example.com" }), {
            headers: { "content-type": "application/json" },
          }),
        );

        try {
          const handler = yield* HttpRouter.toHttpEffect(
            workflowHttpRoutesLayer.pipe(
              Layer.provide(Layer.mock(WorkflowStore)({})),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, browserReadinessSqlClient)),
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    SHEET_AUTH_ISSUER: "https://issuer.example.com",
                    SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "sheet-bot-client",
                  }),
                ),
              ),
              Layer.provide(HttpRouter.layer),
            ),
          ).pipe(Effect.provideService(SqlClient.SqlClient, browserReadinessSqlClient));
          const responses = yield* Effect.forEach(routeManifest, ({ method, path }) =>
            handler.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(routeRequest(method, path)),
              ),
              Effect.provideService(SqlClient.SqlClient, browserReadinessSqlClient),
              Effect.provide(Layer.mock(ReadOnlyWorkflowAuthorization)({})),
            ),
          );

          expect(responses.map(({ status }) => status)).toEqual(routeManifest.map(() => 401));
        } finally {
          fetchMock.mockRestore();
        }
      }),
    ),
  );

  it.effect("producer API exposes workflow routes but denies rollout-gate mutation routes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* HttpRouter.toHttpEffect(
          producerApiRoutesLayer.pipe(
            Layer.provide(Layer.mock(WorkflowStore)({})),
            Layer.provide(Layer.mock(ReadOnlyWorkflowAuthorization)({})),
            Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
            Layer.provide(NodeServices.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  SHEET_AUTH_ISSUER: "https://auth.dev.tiara-stack.moe",
                  SHEET_AUTH_WORKFLOW_HTTP_AUDIENCE: "sheet-workflows-http",
                  SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
                  SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
                  SHEET_BOT_GATEWAY_SERVICE_ID: "sheet-bot.gateway",
                  SHEET_WEB_BASE_URL: "https://sheet-web.dev.tiara-stack.moe",
                  SHEET_WORKFLOWS_ROLE: "producer",
                  WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
                  WORKFLOWS_SOURCE_REVISION: `sha256:${"a".repeat(64)}`,
                  WORKFLOWS_PREVIEW_SESSION_ID: "123e4567-e89b-42d3-a456-426614174000",
                  WORKFLOWS_PREVIEW_API_ENDPOINT: "https://workflow-api.dev.tiara-stack.moe",
                  WORKFLOWS_PREVIEW_GENERATION: "1",
                  WORKFLOWS_PREVIEW_GROUP_TARGET: "workflow-execution:shared-state",
                  WORKFLOWS_PREVIEW_API_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
                  WORKFLOWS_PREVIEW_MANIFEST_DIGEST: `sha256:${"c".repeat(64)}`,
                  WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: sheetDbMigrationArtifactDigest,
                  WORKFLOWS_PREVIEW_CATALOG_DIGEST: sheetWorkflowContractCatalogDigest,
                }),
              ),
            ),
          ),
        );
        const selected = SheetWorkflowContractCatalog.find(
          ({ identity }) => identity === "notifications.loadSupportedClients",
        );
        expect(selected).toBeDefined();
        if (selected === undefined) return yield* Effect.die("workflow test contract missing");
        const routeServices = Layer.mergeAll(
          Layer.mock(ReadOnlyWorkflowAuthorization)({}),
          SqliteClient.layer({ filename: ":memory:" }),
          NodeServices.layer,
        );
        const enqueue = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              routeRequest("POST", workflowContractRoutes(selected).enqueue, "{}"),
            ),
          ),
          Effect.provide(routeServices),
        );
        const mutation = yield* Effect.exit(
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(routeRequest("POST", "/rollout-gate/change", "{}")),
            ),
            Effect.provide(routeServices),
          ),
        );

        expect(enqueue.status).toBe(401);
        expect(Exit.isFailure(mutation)).toBe(true);
        if (Exit.isFailure(mutation)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(mutation.cause));
          expect(error).toMatchObject({ reason: { _tag: "RouteNotFound" } });
        }
      }),
    ),
  );

  it.effect("validates every generated route before invoking workflow business handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = workflowHttpServerExecutorFromHandler<SheetWorkflowZeroContext, never>({
          enqueue: () => Effect.die("HTTP route validation must not enqueue workflows"),
          get: () => Effect.die("HTTP route validation must not observe workflows"),
          list: () => Effect.die("HTTP route validation must not observe workflows"),
        });
        const handler = yield* HttpRouter.toHttpEffect(
          makeWorkflowHttpRoutesLayer(authorized, authorized, executor).pipe(
            Layer.provide(HttpRouter.layer),
          ),
        );
        const invalidRequests = routeManifest.map(({ method, path }) => {
          if (method === "POST") {
            return routeRequest(method, path, "not-json");
          }
          if (path.includes(":invocationId")) {
            return routeRequest(method, path);
          }
          return new Request(`http://localhost${path}?limit=0`, { method });
        });

        const responses = yield* Effect.forEach(invalidRequests, (request) =>
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
          ),
        );

        expect(responses.map(({ status }) => status)).toEqual(routeManifest.map(() => 400));
      }),
    ),
  );

  it.effect(
    "admits browser enqueue only when one owner holds the compatible and action shard groups",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const capabilityIdentity = yield* browserRunnerCapabilityIdentity;
          const selectedGroup = browserRunnerCapabilityGroupFor(capabilityIdentity);
          const wrongVersionGroup = browserRunnerCapabilityGroupFor({
            ...capabilityIdentity,
            playwrightVersion: `${capabilityIdentity.playwrightVersion}-old`,
          });
          const wrongScopeGroup = browserRunnerCapabilityGroupFor({
            ...capabilityIdentity,
            databaseEndpointIdentity: `${capabilityIdentity.databaseEndpointIdentity}/other`,
          });
          const wrongCatalogGroup = browserRunnerCapabilityGroupFor({
            ...capabilityIdentity,
            loadedCatalogDigest: `sha256:${"e".repeat(64)}`,
          });
          const wrongSchemaGroup = browserRunnerCapabilityGroupFor({
            ...capabilityIdentity,
            loadedSchemaArtifactDigest: `sha256:${"f".repeat(64)}`,
          });
          let enqueueCalls = 0;
          const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
            enqueue: (contract, _context, request) =>
              Effect.sync(() => {
                enqueueCalls += 1;
                return makeRunReference(contract, request.invocationId);
              }),
            get: () => Stream.die("unused"),
            list: () => Stream.die("unused"),
          };
          const handler = yield* HttpRouter.toHttpEffect(
            makeWorkflowHttpRoutesLayer(
              authorized,
              authorized,
              executor,
              undefined,
              undefined,
              undefined,
              () => isBrowserRunnerFleetReady,
            ).pipe(Layer.provide(HttpRouter.layer)),
          );
          const requestSchema = WorkflowEnqueueRequest(ScreenshotsCaptureAndDeliver);
          const body = Schema.encodeSync(requestSchema)(
            Schema.decodeUnknownSync(requestSchema)({
              invocationId: "123e4567-e89b-42d3-a456-426614174000",
              input: {
                workspaceId: "workspace-1",
                responseReference: "response-1",
                conversationName: "fixture",
                day: 1,
              },
            }),
          );
          const routes = workflowContractRoutes(ScreenshotsCaptureAndDeliver);
          const actionGroup = screenshotShardGroups.browser;
          const scenarios = [
            {
              label: "selected runtime owns both action and capability groups",
              groups: [
                { group: selectedGroup, count: 300 },
                { group: actionGroup, count: 300 },
              ],
              status: 202,
              enqueues: 1,
            },
            {
              label: "current capability owner cannot borrow action locks from another runner",
              groups: [
                { group: selectedGroup, count: 300, owner: "runner-a" },
                { group: actionGroup, count: 300, owner: "runner-b" },
              ],
              status: 503,
              enqueues: 0,
            },
            {
              label: "capability-only shard ownership",
              groups: [{ group: selectedGroup, count: 300 }],
              status: 503,
              enqueues: 0,
            },
            {
              label: "action-only shard ownership",
              groups: [{ group: actionGroup, count: 300 }],
              status: 503,
              enqueues: 0,
            },
            {
              label: "partial action group does not satisfy readiness",
              groups: [
                { group: selectedGroup, count: 300 },
                { group: actionGroup, count: 299 },
              ],
              status: 503,
              enqueues: 0,
            },
            {
              label: "ordinary-only shard ownership",
              groups: [
                { group: "dispatch", count: 300 },
                { group: actionGroup, count: 300 },
              ],
              status: 503,
              enqueues: 0,
            },
            {
              label: "wrong admitted Playwright version",
              groups: [
                { group: wrongVersionGroup, count: 300 },
                { group: actionGroup, count: 300 },
              ],
              status: 503,
              enqueues: 0,
            },
            {
              label: "selected store identity changed before guarded admission",
              groups: [
                { group: wrongScopeGroup, count: 300 },
                { group: actionGroup, count: 300 },
              ],
              status: 503,
              enqueues: 0,
            },
            {
              label: "mismatched declared workflow catalog",
              groups: [
                { group: wrongCatalogGroup, count: 300 },
                { group: actionGroup, count: 300 },
              ],
              status: 503,
              enqueues: 0,
            },
            {
              label: "mismatched admitted schema artifact",
              groups: [
                { group: wrongSchemaGroup, count: 300 },
                { group: actionGroup, count: 300 },
              ],
              status: 503,
              enqueues: 0,
            },
            {
              label: "browser capability lost before admission",
              groups: [],
              status: 503,
              enqueues: 0,
            },
          ] as const;

          for (const scenario of scenarios) {
            const enqueueCallsBeforeScenario = enqueueCalls;
            const readinessSqlClient = yield* makeBrowserReadinessSqlClient(
              browserReadinessForGroups(scenario.groups),
            );
            const response = yield* handler.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  routeRequest("POST", routes.enqueue, JSON.stringify(body)),
                ),
              ),
              Effect.provideService(SqlClient.SqlClient, readinessSqlClient),
            );
            expect(response.status, scenario.label).toBe(scenario.status);
            expect(enqueueCalls - enqueueCallsBeforeScenario, scenario.label).toBe(
              scenario.enqueues,
            );
          }
        }),
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              POSTGRES_URL: "postgres://workflows:test@127.0.0.1:5432/workflows",
            }),
          ),
        ),
      ),
  );

  it.effect("keeps service-only workflow routes on the service authorizer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serviceContract = Option.getOrThrow(
          Option.fromNullishOr(
            SheetWorkflowContractCatalog.find(
              ({ identity }) => identity === "announcements.deliverUpdate",
            ),
          ),
        );
        const userContract = Option.getOrThrow(
          Option.fromNullishOr(
            SheetWorkflowContractCatalog.find(
              ({ identity }) => identity === "workspaces.deliverConfig",
            ),
          ),
        );
        const calls: Array<string> = [];
        const authorizer = (name: string): WorkflowHttpAuthorizer => ({
          requireAuthorizedHeaders: () =>
            Effect.sync(() => {
              calls.push(name);
              return authorizedToken;
            }),
          requireAuthorizedBearerToken: () => Effect.succeed(authorizedToken),
        });
        const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
          enqueue: () => Effect.die("Invalid route bodies must not reach the executor"),
          get: () => Stream.die("Invalid route requests must not reach the executor"),
          list: () => Stream.die("Invalid route requests must not reach the executor"),
        };
        const handler = yield* HttpRouter.toHttpEffect(
          makeWorkflowHttpRoutesLayer(
            authorizer("browser"),
            authorizer("browser-observation"),
            executor,
            undefined,
            authorizer("service"),
            authorizer("service-observation"),
          ).pipe(Layer.provide(HttpRouter.layer)),
        );
        const requests = [serviceContract, userContract].flatMap((contract) => {
          const routes = workflowContractRoutes(contract);
          return [
            routeRequest("POST", routes.enqueue, "{}"),
            routeRequest("GET", routes.get),
            routeRequest("GET", `${routes.list}?limit=0`),
          ];
        });
        const responses = yield* Effect.forEach(requests, (request) =>
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
          ),
        );

        expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400, 400, 400]);
        expect(calls).toEqual([
          "service",
          "service-observation",
          "service-observation",
          "browser",
          "browser-observation",
          "browser-observation",
        ]);
      }),
    ),
  );

  it.effect("maps authorized observations to owner-scoped store reads", () =>
    Effect.gen(function* () {
      const contract = SheetWorkflowContractCatalog[0]!;
      const invocationId = Schema.decodeUnknownSync(InvocationId)(
        "123e4567-e89b-42d3-a456-426614174000",
      );
      const ownerKey = "user:user-1";
      const workflowName = workflowContractKey(contract);
      const submittedAt = new Date("2026-08-25T00:00:00.000Z");
      const updatedAt = new Date("2026-08-25T00:01:00.000Z");
      const cursorSubmittedAt = new Date("2026-08-24T23:59:00.000Z");
      const getCalls: Array<unknown> = [];
      const listCalls: Array<unknown> = [];
      const row = {
        runId: invocationId,
        workflowName,
        definitionVersion: "1",
        executionId: "execution-1",
        status: "running" as const,
        result: null,
        error: null,
        completedAt: null,
        createdAt: submittedAt,
        updatedAt,
      };
      const storeLayer = Layer.sync(WorkflowStore, (): typeof WorkflowStore.Service => {
        const unused = () => Effect.die("unused");
        return {
          enqueue: unused,
          enqueueCommand: unused,
          claim: unused,
          getRun: unused,
          listRuns: unused,
          getRunForOwner: (actualOwnerKey, actualWorkflowName, actualRunId) => {
            getCalls.push({ actualOwnerKey, actualWorkflowName, actualRunId });
            return Effect.succeed(row);
          },
          listRunsForOwner: (actualOwnerKey, actualWorkflowName, statuses, limit, cursor) => {
            listCalls.push({
              actualOwnerKey,
              actualWorkflowName,
              statuses,
              limit,
              cursor,
            });
            return Effect.succeed([row]);
          },
          markCommandDelivered: unused,
          retryCommand: unused,
          failCommand: unused,
          markRun: unused,
        };
      });
      const filter: WorkflowRunListFilter = {
        states: ["Pending", "Failure"],
        cursor: { submittedAt: cursorSubmittedAt, invocationId },
      };
      const expectedRun = {
        runId: invocationId,
        status: "running" as const,
        result: null,
        error: null,
        completedAt: null,
        createdAt: submittedAt,
        updatedAt,
      };
      const observation = yield* Effect.gen(function* () {
        const store = yield* WorkflowStore;
        const invocationStore = makeWorkflowInvocationStore(store);
        const getRun = yield* invocationStore.get(ownerKey, workflowName, invocationId);
        const listRuns = yield* invocationStore.list(ownerKey, workflowName, filter);
        return { getRun, listRuns };
      }).pipe(
        Effect.provide(storeLayer),
        Effect.provide(Layer.mock(ReadOnlyWorkflowAuthorization)({})),
      );

      expect(observation.getRun).toEqual(expectedRun);
      expect(observation.listRuns).toEqual([expectedRun]);
      expect(getCalls).toEqual([
        { actualOwnerKey: ownerKey, actualWorkflowName: workflowName, actualRunId: invocationId },
      ]);
      expect(listCalls).toEqual([
        {
          actualOwnerKey: ownerKey,
          actualWorkflowName: workflowName,
          statuses: ["pending", "running", "failed", "cancelled"],
          limit: defaultWorkflowRunListLimit,
          cursor: { createdAt: cursorSubmittedAt, runId: invocationId },
        },
      ]);
    }),
  );

  it.effect("serves authorized observation routes as streaming materialized runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const contract = SheetWorkflowContractCatalog[0]!;
        const invocationId = Schema.decodeUnknownSync(InvocationId)(
          "123e4567-e89b-42d3-a456-426614174000",
        );
        const submittedAt = new Date("2026-08-25T00:00:00.000Z");
        const updatedAt = new Date("2026-08-25T00:01:00.000Z");
        const observedGetInvocationIds: Array<string> = [];
        const observedListFilters: Array<WorkflowRunListFilter> = [];
        const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
          enqueue: () => Effect.die("Observation tests must not enqueue workflows"),
          get: <Contract extends AnyWorkflowContract>(
            contract: Contract,
            _context: SheetWorkflowZeroContext,
            requestedInvocationId: InvocationId,
          ) => {
            observedGetInvocationIds.push(requestedInvocationId);
            return Stream.succeed(
              Option.some({
                reference: makeRunReference(contract, requestedInvocationId),
                result: { _tag: "Pending" as const, phase: "Queued" as const },
                submittedAt,
                updatedAt,
              } satisfies WorkflowRun<Contract>),
            );
          },
          list: <Contract extends AnyWorkflowContract>(
            contract: Contract,
            _context: SheetWorkflowZeroContext,
            filter: WorkflowRunListFilter,
          ) => {
            observedListFilters.push(filter);
            return Stream.succeed([
              {
                reference: makeRunReference(contract, invocationId),
                result: { _tag: "Pending" as const, phase: "Queued" as const },
                submittedAt,
                updatedAt,
              } satisfies WorkflowRun<Contract>,
            ]);
          },
        };
        const httpHandler = yield* HttpRouter.toHttpEffect(
          makeWorkflowHttpRoutesLayer(authorized, authorized, executor).pipe(
            Layer.provide(HttpRouter.layer),
          ),
        );
        const routes = workflowContractRoutes(contract);
        const cursorSubmittedAt = "2026-08-24T23:59:00.000Z";
        const [getResponse, listResponse] = yield* Effect.all([
          httpHandler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                routeRequest("GET", routes.get.replace(":invocationId", invocationId)),
              ),
            ),
          ),
          httpHandler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(
                  `http://localhost${routes.list}?limit=2&cursorSubmittedAt=${encodeURIComponent(cursorSubmittedAt)}&cursorInvocationId=${invocationId}`,
                  { method: "GET" },
                ),
              ),
            ),
          ),
        ]);
        const [getBody, listBody] = yield* Effect.all([
          readSseBody(getResponse),
          readSseBody(listResponse),
        ]);
        const expectedRun = {
          reference: {
            invocationId,
            contractIdentity: contract.identity,
            wireVersion: contract.wireVersion,
          },
          result: { _tag: "Pending", phase: "Queued" },
          submittedAt: submittedAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        };

        expect(JSON.parse(getBody.slice("data: ".length).trim())).toEqual(expectedRun);
        expect(JSON.parse(listBody.slice("data: ".length).trim())).toEqual([expectedRun]);
        expect(observedGetInvocationIds).toEqual([invocationId]);
        expect(observedListFilters).toEqual([
          {
            cursor: { submittedAt: new Date(cursorSubmittedAt), invocationId },
            limit: 2,
          },
        ]);
      }),
    ),
  );

  it.effect("observes the terminal run enqueued by the same producer API invocation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const contract = Option.getOrThrow(
          Option.fromNullishOr(
            SheetWorkflowContractCatalog.find(
              ({ identity }) => identity === "notifications.loadSupportedClients",
            ),
          ),
        );
        const invocationId = Schema.decodeUnknownSync(InvocationId)(
          "123e4567-e89b-42d3-a456-426614174000",
        );
        const submittedAt = new Date("2026-10-09T00:00:00.000Z");
        const completedAt = new Date("2026-10-09T00:00:01.000Z");
        const acceptedInvocationIds = new Set<string>();
        const calls: Array<string> = [];
        const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
          enqueue: <Contract extends AnyWorkflowContract>(
            selected: Contract,
            _context: SheetWorkflowZeroContext,
            request: { readonly invocationId: InvocationId; readonly input: unknown },
          ) => {
            calls.push(`enqueue:${selected.identity}:${request.invocationId}`);
            const reference = makeRunReference(selected, request.invocationId);
            acceptedInvocationIds.add(`${selected.identity}:${request.invocationId}`);
            return Effect.succeed(reference);
          },
          get: <Contract extends AnyWorkflowContract>(
            selected: Contract,
            _context: SheetWorkflowZeroContext,
            requested: InvocationId,
          ) => {
            calls.push(`observe:${selected.identity}:${requested}`);
            if (!acceptedInvocationIds.has(`${selected.identity}:${requested}`))
              return Stream.succeed(Option.none());
            const run = {
              reference: makeRunReference(selected, requested),
              result: {
                _tag: "Failure",
                failure: {
                  _tag: "System",
                  code: "UnexpectedFailure",
                  retryable: false,
                },
                completedAt,
              },
              submittedAt,
              updatedAt: completedAt,
            } satisfies WorkflowRun<Contract>;
            return Stream.succeed(Option.some(run));
          },
          list: () => Stream.succeed([]),
        };
        const handler = yield* HttpRouter.toHttpEffect(
          makeWorkflowHttpRoutesLayer(authorized, authorized, executor).pipe(
            Layer.provide(HttpRouter.layer),
          ),
        );
        const routes = workflowContractRoutes(contract);
        const enqueueResponse = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              routeRequest(
                "POST",
                routes.enqueue,
                JSON.stringify({ invocationId, input: { platform: "discord" } }),
              ),
            ),
          ),
        );
        expect(enqueueResponse.status).toBe(202);

        const observationResponse = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              routeRequest("GET", routes.get.replace(":invocationId", invocationId)),
            ),
          ),
        );
        const observation = yield* readSseBody(observationResponse);
        const terminalRun: unknown = JSON.parse(observation.slice("data: ".length).trim());

        expect(terminalRun).toEqual({
          reference: {
            invocationId,
            contractIdentity: contract.identity,
            wireVersion: contract.wireVersion,
          },
          result: {
            _tag: "Failure",
            failure: {
              _tag: "System",
              code: "UnexpectedFailure",
              retryable: false,
            },
            completedAt: completedAt.toISOString(),
          },
          submittedAt: submittedAt.toISOString(),
          updatedAt: completedAt.toISOString(),
        });
        expect(calls).toEqual([
          `enqueue:${contract.identity}:${invocationId}`,
          `observe:${contract.identity}:${invocationId}`,
        ]);
      }),
    ),
  );

  it.effect("return 400 before opening an SSE response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const contract = SheetWorkflowContractCatalog[0]!;
        const invocationId = Schema.decodeUnknownSync(InvocationId)(
          "123e4567-e89b-42d3-a456-426614174000",
        );
        const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
          enqueue: () => Effect.die("Observation error tests must not enqueue workflows"),
          get: () =>
            Stream.fail(
              new WorkflowObservationInvalidData({
                message: "Stored workflow outcome does not match its published contract",
              }),
            ),
          list: () => Stream.fail(new WorkflowObservationInvalidData({ message: "invalid" })),
        };
        const httpHandler = yield* HttpRouter.toHttpEffect(
          makeWorkflowHttpRoutesLayer(authorized, authorized, executor).pipe(
            Layer.provide(HttpRouter.layer),
          ),
        );
        const response = yield* httpHandler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              routeRequest(
                "GET",
                workflowContractRoutes(contract).get.replace(":invocationId", invocationId),
              ),
            ),
          ),
        );

        expect(response.status).toBe(400);

        const listResponse = yield* httpHandler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(routeRequest("GET", workflowContractRoutes(contract).list)),
          ),
        );

        expect(listResponse.status).toBe(400);
      }),
    ),
  );

  it.live("streams the first observation event before later events are ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const contract = SheetWorkflowContractCatalog[0]!;
        const laterEvent = yield* Deferred.make<void>();
        const emptyRuns = <Contract extends AnyWorkflowContract>(): ReadonlyArray<
          WorkflowRun<Contract>
        > => [];
        const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
          enqueue: () => Effect.die("Streaming tests must not enqueue workflows"),
          get: () => Stream.succeed(Option.none()),
          list: <Contract extends AnyWorkflowContract>() =>
            Stream.concat(
              Stream.succeed(emptyRuns<Contract>()),
              Stream.fromEffect(Deferred.await(laterEvent).pipe(Effect.as(emptyRuns<Contract>()))),
            ).pipe(Stream.rechunk(1)),
        };
        const httpHandler = yield* HttpRouter.toHttpEffect(
          makeWorkflowHttpRoutesLayer(authorized, authorized, executor).pipe(
            Layer.provide(HttpRouter.layer),
          ),
        );
        const response = yield* httpHandler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(routeRequest("GET", workflowContractRoutes(contract).list)),
          ),
          Effect.timeout("1 second"),
        );

        if (response.body._tag !== "Stream") {
          return yield* Effect.die("Expected an SSE stream response");
        }
        const firstChunk = yield* Stream.runHead(response.body.stream).pipe(
          Effect.timeout("1 second"),
        );
        expect(Option.isSome(firstChunk)).toBe(true);
        if (Option.isSome(firstChunk)) {
          expect(new TextDecoder().decode(firstChunk.value)).toContain("data: []");
        }
      }),
    ),
  );

  it.effect("decodes repeated list-state query parameters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const contract = SheetWorkflowContractCatalog[0]!;
        const observedFilters: Array<WorkflowRunListFilter> = [];
        const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
          enqueue: () => Effect.die("Observation query tests must not enqueue workflows"),
          get: () => Stream.succeed(Option.none()),
          list: (_contract, _context, filter) => {
            observedFilters.push(filter);
            return Stream.succeed([]);
          },
        };
        const httpHandler = yield* HttpRouter.toHttpEffect(
          makeWorkflowHttpRoutesLayer(authorized, authorized, executor).pipe(
            Layer.provide(HttpRouter.layer),
          ),
        );
        const response = yield* httpHandler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(
                `http://localhost${workflowContractRoutes(contract).list}?state=Pending&state=Failure`,
                { method: "GET" },
              ),
            ),
          ),
        );

        yield* readSseBody(response);
        expect(observedFilters).toEqual([{ states: ["Pending", "Failure"] }]);
      }),
    ),
  );
});
