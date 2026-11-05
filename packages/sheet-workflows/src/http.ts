import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { Effect, Layer, Option } from "effect";
import { createServer } from "http";
import {
  isCurrentClusterRunnerReady,
  isWorkflowApiReady,
  postgresSqlLayer,
  rolloutGateControlLayer,
  sheetBotCacheClientLayer,
  trustedSheetPersistenceLayer,
} from "./services";
import { config } from "./config";
import { workflowHttpRoutesLayer } from "./handlers/workflowHttp";
import { rolloutGateRoutesLayer } from "./handlers/rolloutGate";
import { readOnlyWorkflowAuthorizationLayer } from "./workflows/readOnly";
import { sheetWorkflowsRuntimePolicy } from "./config/runtimePolicy";

const apiRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sheetWebBaseUrl = yield* config.sheetWebBaseUrl;
    const sourceRevision = yield* config.workflowsSourceRevision;
    const previewSessionId = yield* config.workflowsPreviewSessionId;
    const previewApiEndpoint = yield* config.workflowsPreviewApiEndpoint;
    const previewGeneration = yield* config.workflowsPreviewGeneration;
    const previewGroupTarget = yield* config.workflowsPreviewGroupTarget;
    const previewApiArtifactDigest = yield* config.workflowsPreviewApiArtifactDigest;
    const previewManifestDigest = yield* config.workflowsPreviewManifestDigest;
    const policy = yield* sheetWorkflowsRuntimePolicy;
    return workflowHttpRoutesLayer.pipe(
      Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
      Layer.merge(
        HttpRouter.add(
          "GET",
          "/ready",
          isWorkflowApiReady.pipe(
            Effect.map((ready) =>
              HttpServerResponse.empty({
                status: ready ? 200 : 503,
                headers:
                  sourceRevision.length === 0
                    ? {}
                    : {
                        "x-tiara-workflows-source-revision": sourceRevision,
                        "x-tiara-workflows-role": policy.role,
                        "x-tiara-workflows-producer-only": String(policy.producer),
                        "x-tiara-workflows-runner": String(policy.workflowRunner),
                        "x-tiara-workflows-reconciliation-consumer": String(
                          policy.reconciliationConsumer,
                        ),
                        "x-tiara-workflows-autonomous-triggers":
                          policy.autonomousTriggerNames.join(","),
                        "x-tiara-workflows-smoke-enqueue": String(policy.smokeEnqueue),
                        "x-tiara-preview-session": previewSessionId,
                        "x-tiara-preview-generation": String(previewGeneration),
                        "x-tiara-preview-api-endpoint": previewApiEndpoint,
                        "x-tiara-preview-workflow-group": previewGroupTarget,
                        "x-tiara-preview-api-artifact": previewApiArtifactDigest,
                        "x-tiara-preview-deployed-manifest": previewManifestDigest,
                        "x-tiara-preview-schema-artifact": policy.schemaArtifactDigest,
                        "x-tiara-preview-workflow-catalog": policy.workflowContractCatalogDigest,
                      },
              }),
            ),
          ),
        ),
      ),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provide(
        HttpRouter.cors({
          allowedOrigins: [sheetWebBaseUrl.origin],
        }),
      ),
    );
  }),
);

const workflowHttpAuthorizationLayer = readOnlyWorkflowAuthorizationLayer.pipe(
  Layer.provide(sheetBotCacheClientLayer),
  Layer.provide(trustedSheetPersistenceLayer),
);

const httpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* config.port;
    const host = yield* config.host;
    return NodeHttpServer.layer(
      createServer,
      Option.match(host, {
        onNone: () => ({ port }),
        onSome: (value) => ({ host: value, port }),
      }),
    );
  }),
);

/** Producer requests use only the catalogued workflow API and readiness routes. */
export const producerApiRoutesLayer = apiRoutesLayer;

export const producerHttpLayer = HttpRouter.serve(producerApiRoutesLayer).pipe(
  Layer.provide(workflowHttpAuthorizationLayer),
  Layer.provide(postgresSqlLayer),
  Layer.provide(NodeFileSystem.layer),
  HttpServer.withLogAddress,
  Layer.provide(httpServerLayer),
);

export const httpLayer = HttpRouter.serve(
  apiRoutesLayer.pipe(Layer.merge(rolloutGateRoutesLayer)),
).pipe(
  Layer.provide(workflowHttpAuthorizationLayer),
  Layer.provide(rolloutGateControlLayer),
  Layer.provide(postgresSqlLayer),
  Layer.provide(NodeFileSystem.layer),
  HttpServer.withLogAddress,
  Layer.provide(httpServerLayer),
);

const runnerHealthRoutesLayer = HttpRouter.add(
  "GET",
  "/live",
  HttpServerResponse.empty({ status: 200 }),
).pipe(
  Layer.merge(
    HttpRouter.add(
      "GET",
      "/ready",
      isCurrentClusterRunnerReady.pipe(
        Effect.map((ready) => HttpServerResponse.empty({ status: ready ? 200 : 503 })),
      ),
    ),
  ),
  Layer.provideMerge(HttpRouter.layer),
);

export const runnerHealthLayer = HttpRouter.serve(runnerHealthRoutesLayer).pipe(
  Layer.provide(postgresSqlLayer),
  HttpServer.withLogAddress,
  Layer.provide(httpServerLayer),
);
