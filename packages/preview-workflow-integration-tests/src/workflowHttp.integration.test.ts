import { ConfigProvider, Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  InvocationId,
  makeRunReference,
  type AnyWorkflowContract,
  type WorkflowRun,
} from "effect-zero-workflow/contract";
import type { WorkflowHttpServerExecutor } from "effect-zero-workflow/contract/http/server";
import { workflowContractRoutes } from "effect-zero-workflow/contract/transport";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import { sheetDbMigrationArtifactDigest } from "sheet-db-schema/migrations";
import type { SheetWorkflowZeroContext } from "sheet-zero-server";
import {
  makePreviewSessionController,
  makePreviewWorkflowApiWorkflowRequestRunner,
  previewSharedWorkflowTarget,
  type PreviewSharedWorkflowGroup,
} from "developer-launcher";
import { sheetWorkflowContractCatalogDigest } from "@/workflows/catalogIdentity";
import { sheetWorkflowsRuntimePolicy } from "@/config/runtimePolicy";
import { makeWorkflowHttpRoutesLayer } from "@/handlers/workflowHttp";
import type { WorkflowHttpAuthorizer } from "@/handlers/workflowHttp";

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

const routeRequest = (method: string, path: string, body?: string) =>
  new Request(`http://localhost${path.replace(":invocationId", "not-an-invocation-id")}`, {
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

describe("public workflow HTTP and preview admission integration", () => {
  it.effect(
    "composes the published preview admission callback with the public workflow enqueue and observation routes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stalePolicy = yield* Effect.exit(
            sheetWorkflowsRuntimePolicy.pipe(
              Effect.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    SHEET_WORKFLOWS_ROLE: "producer",
                    WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
                    WORKFLOWS_PREVIEW_CATALOG_DIGEST: `sha256:${"e".repeat(64)}`,
                  }),
                ),
              ),
            ),
          );
          expect(stalePolicy._tag).toBe("Failure");

          const now = { value: 1_000_000 };
          const controller = yield* makePreviewSessionController(() => now.value);
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
          const oauthClientId = "preview-workflow-api-client";
          const apiArtifactDigest = `sha256:${"a".repeat(64)}`;
          const manifestDigest = `sha256:${"b".repeat(64)}`;
          const catalogDigest = sheetWorkflowContractCatalogDigest;
          const schemaArtifactDigest = sheetDbMigrationArtifactDigest;
          const sessionApiEndpoint = "https://session-api.dev.tiara-stack.moe";
          const group: PreviewSharedWorkflowGroup = {
            sessionId: "123e4567-e89b-42d3-a456-426614174001",
            generation: 1,
            groupId: "workflow-execution",
            endpoint: "https://workflow-execution.dev.tiara-stack.moe",
            databaseEndpointIdentity: `sha256:${"e".repeat(64)}`,
            stateIdentity: "shared-workflow-state",
            deployedManifestDigest: manifestDigest,
            schemaArtifactDigest,
            apiArtifactDigest,
            workflowContractCatalogDigest: catalogDigest,
          };
          const target = previewSharedWorkflowTarget(
            group,
            contract.identity,
            contract.wireVersion,
          );
          const created = yield* controller.create({
            owner: "owner",
            checkout: "/checkout",
            manifests: {
              "sheet-workflows-api": apiArtifactDigest,
              "deployed-manifest": manifestDigest,
              "schema-artifact": schemaArtifactDigest,
            },
            requestedRevision: `sha256:${"d".repeat(64)}`,
            groups: ["workflow-execution"],
            endpoints: [group.endpoint, sessionApiEndpoint],
            targets: [target],
          });
          const reservation = yield* controller.authorizeCredentialIssue(
            created.session.id,
            created.session.generation,
            "sheet-workflows-api",
          );
          yield* controller.registerCredentialIdentity({
            id: created.session.id,
            generation: created.session.generation,
            role: "sheet-workflows-api",
            reservationId: reservation.reservationId,
            credentialName: "workload-identity",
            serviceAccount: "tiara-stack-dev/preview-api",
            oauthClientId,
            credentialFile: "/private/session/api/token",
          });
          yield* controller.authorizeWorkEndpoint(
            created.session.id,
            created.session.generation,
            created.supervisorIdentity,
            sessionApiEndpoint,
          );
          yield* controller.activate(
            created.session.id,
            created.session.generation,
            created.supervisorIdentity,
            created.session.requestedRevision,
          );

          const acceptedInvocationIds = new Set<string>();
          const submittedAt = new Date("2026-10-09T00:00:00.000Z");
          const completedAt = new Date("2026-10-09T00:00:01.000Z");
          const executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, never> = {
            enqueue: <Contract extends AnyWorkflowContract>(
              selected: Contract,
              _context: SheetWorkflowZeroContext,
              request: { readonly invocationId: InvocationId; readonly input: unknown },
            ) => {
              acceptedInvocationIds.add(`${selected.identity}:${request.invocationId}`);
              return Effect.succeed(makeRunReference(selected, request.invocationId));
            },
            get: <Contract extends AnyWorkflowContract>(
              selected: Contract,
              _context: SheetWorkflowZeroContext,
              requested: InvocationId,
            ) => {
              if (!acceptedInvocationIds.has(`${selected.identity}:${requested}`))
                return Stream.succeed(Option.none());
              const run = {
                reference: makeRunReference(selected, requested),
                result: {
                  _tag: "Failure",
                  failure: { _tag: "System", code: "UnexpectedFailure", retryable: false },
                  completedAt,
                },
                submittedAt,
                updatedAt: completedAt,
              } satisfies WorkflowRun<Contract>;
              return Stream.succeed(Option.some(run));
            },
            list: () => Stream.succeed([]),
          };
          const httpHandler = yield* HttpRouter.toHttpEffect(
            makeWorkflowHttpRoutesLayer(authorized, authorized, executor).pipe(
              Layer.provide(HttpRouter.layer),
            ),
          );
          const admitWorkflowRequest = makePreviewWorkflowApiWorkflowRequestRunner({
            controller,
            group: {
              ...group,
              sessionId: created.session.id,
              generation: created.session.generation,
            },
            oauthClientId,
            endpoint: () => sessionApiEndpoint,
          });
          const enqueuePath = workflowContractRoutes(contract).enqueue;
          const getPath = workflowContractRoutes(contract).get.replace(
            ":invocationId",
            invocationId,
          );
          const requestBody = new TextEncoder().encode(
            JSON.stringify({ invocationId, input: { platform: "discord" } }),
          );
          const enqueue = yield* admitWorkflowRequest({
            method: "POST",
            path: enqueuePath,
            body: requestBody,
            forward: httpHandler.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  routeRequest("POST", enqueuePath, new TextDecoder().decode(requestBody)),
                ),
              ),
              Effect.map((response) => ({ status: response.status })),
            ),
          });
          const observation = yield* admitWorkflowRequest({
            method: "GET",
            path: getPath,
            forward: Effect.gen(function* () {
              const response = yield* httpHandler.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(routeRequest("GET", getPath)),
                ),
              );
              const eventData = yield* readSseBody(response);
              const observed: unknown = JSON.parse(eventData.slice("data: ".length).trim());
              return observed;
            }),
          });

          expect(enqueue.value.status).toBe(202);
          expect(observation.value).toMatchObject({
            reference: {
              invocationId,
              contractIdentity: contract.identity,
              wireVersion: contract.wireVersion,
            },
            result: { _tag: "Failure" },
          });
          expect(enqueue.group).toMatchObject({
            sessionId: created.session.id,
            generation: created.session.generation,
            stateIdentity: group.stateIdentity,
          });
          expect(observation.group).toEqual(enqueue.group);
          expect((yield* controller.status(created.session.id)).unsettled).toBe(0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
          ),
        ),
      ),
  );
});
