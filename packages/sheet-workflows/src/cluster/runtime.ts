import { NodeHttpServer } from "@effect/platform-node";
import { Duration, Effect, FileSystem, Layer, Option, Ref } from "effect";
import type { ConfigError } from "effect/Config";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  K8sHttpClient,
  RunnerAddress,
  RunnerHealth,
  Runners,
  Sharding,
  ShardingConfig,
} from "effect/unstable/cluster";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import {
  clientOnlyShardingConfig,
  clusterWorkflowEngineClientLayer as makeClusterWorkflowEngineClientLayer,
  clusterWorkflowEngineRunnerLayer,
  clusterWorkflowStorageLayer,
  reconcileWorkflowRuns,
  runWorkflowCommandDispatcher,
  WorkflowStore,
  workflowRuntimeCommandExecutorLayer,
  workflowRuntimeLayer,
} from "effect-zero-workflow";
import type { WorkflowContractRegistrationError } from "effect-zero-workflow/contract-server";
import type { WorkflowRunCursor } from "effect-zero-workflow";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { config } from "@/config";
import {
  AutonomousTriggerService,
  sheetBotCacheClientLayer,
  sheetBotDeliveryClientLayer,
  sheetDataProviderLayer,
  trustedSheetPersistenceLayer,
} from "@/services";
import { autonomousTriggerWorkflowLayer } from "@/workflows/autoCheckin";
import type { AutonomousTriggerProviderError } from "@/workflows/autonomous/provider";
import type { AutoCheckinTestProviderError } from "@/workflows/checkins/autoTestProvider";
import type { CalculationProviderError } from "@/workflows/calculations/provider";
import { getClusterRunnerReadinessSnapshot, postgresSqlLayer } from "@/services";
import { smokeWorkflowLayer } from "@/workflows/smoke";
import {
  readOnlyWorkflowAuthorizationLayer,
  readOnlyWorkflowDataSourceLayer,
  readOnlySheetWorkflowLayers,
  sheetSnapshotProviderLayer,
} from "@/workflows/readOnly";
import {
  preferencesSheetWorkflowLayers,
  preferencesWorkflowOperationsLayer,
} from "@/workflows/preferences";
import { selectedSheetWorkflowRegistrationValidationLayer } from "@/workflows/selected";
import {
  configurationSheetWorkflowLayers,
  configurationWorkflowOperationsLayer,
} from "@/workflows/configuration";
import {
  sheetConfigurationWorkflowLayers,
  sheetConfigurationWorkflowOperationsLayer,
} from "@/workflows/sheetConfiguration";
import { slotSheetWorkflowLayers, slotWorkflowOperationsLayer } from "@/workflows/slots";
import { slotListWorkflowOperationsLayer } from "@/workflows/slots/slotListOperations";
import { slotListProviderLayer } from "@/workflows/slots/slotListProvider";
import { slotOpenWorkflowOperationsLayer } from "@/workflows/slots/slotOpenOperations";
import { scheduleSheetWorkflowLayers } from "@/workflows/schedules";
import { scheduleWorkflowOperationsLayer } from "@/workflows/schedules/operations";
import { userScheduleProviderLayer } from "@/workflows/schedules/provider";
import type { UserScheduleProviderError } from "@/workflows/schedules/provider";
import { teamSheetWorkflowLayers } from "@/workflows/teams";
import { teamWorkflowOperationsLayer } from "@/workflows/teams/operations";
import { userTeamsProviderLayer } from "@/workflows/teams/provider";
import type { UserTeamsProviderError } from "@/workflows/teams/provider";
import {
  teamSubmissionProviderLayer,
  teamSubmissionsSheetWorkflowLayers,
  teamSubmissionsWorkflowOperationsLayer,
} from "@/workflows/teamSubmissions";
import type { TeamSubmissionProviderError } from "@/workflows/teamSubmissions/provider";
import {
  serviceSheetWorkflowLayers,
  serviceStatusWorkflowOperationsLayer,
} from "@/workflows/services";
import {
  workspaceSheetWorkflowLayers,
  workspaceFeatureFlagWorkflowOperationsLayer,
  workspaceWelcomeWorkflowOperationsLayer,
} from "@/workflows/workspaces";
import {
  announcementSheetWorkflowLayers,
  updateAnnouncementWorkflowOperationsLayer,
} from "@/workflows/announcements";
import {
  autoCheckinTestProviderLayer,
  autoCheckinTestWorkflowOperationsLayer,
  checkinSheetWorkflowLayers,
  checkinWorkflowOperationsLayer,
  checkinsOpenWorkflowOperationsLayer,
} from "@/workflows/checkins";
import {
  memberKickProviderLayer,
  memberKickWorkflowOperationsLayer,
  memberSheetWorkflowLayers,
} from "@/workflows/members";
import type { MemberKickProviderError } from "@/workflows/members/provider";
import { roomOrderCreateProviderLayer } from "@/workflows/roomOrders/createProvider";
import type { RoomOrderCreateProviderError } from "@/workflows/roomOrders/createProvider";
import {
  roomOrderNavigationOperationsLayer,
  roomOrderNavigationProviderLayer,
  roomOrderCreateOperationsLayer,
  roomOrderTentativePinOperationsLayer,
  roomOrderSendOperationsLayer,
  roomOrderSheetWorkflowLayers,
} from "@/workflows/roomOrders";
import type { RoomOrderNavigationProviderError } from "@/workflows/roomOrders/provider";
import {
  screenshotBrowserLayer,
  screenshotBrowserWorkflowLayers,
  screenshotCaptureOperationsLayer,
  screenshotOrdinaryWorkflowLayers,
  screenshotSourceOperationsLayer,
  screenshotSourceProviderLayer,
} from "@/workflows/screenshots";
import type { ScreenshotSourceProviderError } from "@/workflows/screenshots/sourceProvider";
import type { SheetSnapshotProviderError } from "@/workflows/readOnly/sheetSnapshotProvider";
import type { SlotListProviderError } from "@/workflows/slots/slotListProvider";
import {
  calculationProviderLayer,
  calculationSheetWorkflowLayers,
  calculationWorkflowOperationsLayer,
} from "@/workflows/calculations";
import {
  sheetWorkflowRuntimeDefinitionVersion,
  sheetWorkflowRuntimeDefinitions,
} from "@/workflows/runtimeDefinitions";

const availableSheetWorkflowShardGroups = ["dispatch", "autoCheckin", "browser"] as const;

export const assignedSheetWorkflowShardGroups = (
  role: "combined" | "api" | "runner" | "browser-runner",
): ReadonlyArray<(typeof availableSheetWorkflowShardGroups)[number]> =>
  role === "browser-runner" ? ["browser"] : ["dispatch", "autoCheckin"];

const configuredRunnerAddress = Effect.gen(function* () {
  const runnerHost = yield* config.workflowsRunnerHost;
  const runnerPort = yield* config.workflowsRunnerPort;
  return RunnerAddress.make(runnerHost, runnerPort);
});

export const shardingConfigLayer = Layer.unwrap(
  Effect.gen(function* () {
    const runnerAddress = yield* configuredRunnerAddress;
    const runnerListenHost = yield* config.workflowsRunnerListenHost;
    const runnerListenPort = yield* config.workflowsRunnerListenPort;
    const role = yield* config.sheetWorkflowsRole;

    return ShardingConfig.layer({
      runnerAddress: Option.some(runnerAddress),
      runnerListenAddress: Option.some(RunnerAddress.make(runnerListenHost, runnerListenPort)),
      assignedShardGroups: assignedSheetWorkflowShardGroups(role),
      availableShardGroups: availableSheetWorkflowShardGroups,
      shardsPerGroup: 300,
      // Production PostgreSQL can sit behind a managed connection pool. Session-level
      // advisory locks can then outlive a runner connection and strand its shards.
      // Expiry-aware lock rows let another healthy runner recover those shards.
      shardLockDisableAdvisory: true,
      entityMailboxCapacity: 4096,
      entityMaxIdleTime: Duration.minutes(5),
      simulateRemoteSerialization: false,
    });
  }),
).pipe(Layer.withSpan("sheet-workflows.shardingConfig"));

export const clusterStorageLayer = clusterWorkflowStorageLayer({
  prefix: "sheet_workflows",
}).pipe(Layer.withSpan("sheet-workflows.clusterStorage"));

const runnerHealthLayer = Layer.unwrap(
  Effect.gen(function* () {
    const namespace = yield* config.podNamespace;
    const labelSelector = yield* config.workflowsRunnerHealthLabelSelector;
    return RunnerHealth.layerK8s({ namespace, labelSelector });
  }),
).pipe(Layer.withSpan("sheet-workflows.runnerHealth"));

export const clientOnlyWorkflowShardingConfig = (
  current: ShardingConfig.ShardingConfig["Service"],
): ShardingConfig.ShardingConfig["Service"] => clientOnlyShardingConfig(current);

export const clusterWorkflowEngineClientLayer = makeClusterWorkflowEngineClientLayer({
  storage: clusterStorageLayer,
  shardingConfig: shardingConfigLayer,
  path: "/cluster/rpc",
}).pipe(Layer.withSpan("sheet-workflows.workflowEngineClient"));

const workflowsRunnerLayer = clusterWorkflowEngineRunnerLayer({
  storage: clusterStorageLayer,
  shardingConfig: shardingConfigLayer,
  runnerHealth: runnerHealthLayer,
  path: "/cluster/rpc",
}).pipe(Layer.provide(K8sHttpClient.layer));

const sheetWorkflowRuntimeLayer = workflowRuntimeLayer({
  workflows: sheetWorkflowRuntimeDefinitions,
  definitionVersion: sheetWorkflowRuntimeDefinitionVersion,
});

const workflowReconciliationBatchSize = 100;

const workflowCommandDispatcherLayer: Layer.Layer<
  never,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowStore
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const workflowReconciliationCursor = yield* Ref.make<WorkflowRunCursor | undefined>(undefined);
    yield* runWorkflowCommandDispatcher({
      workerId: `sheet-workflows:${randomUUID()}`,
    }).pipe(Effect.forkScoped);
    yield* reconcileWorkflowRuns({
      batchSize: workflowReconciliationBatchSize,
      concurrency: 10,
      cursor: workflowReconciliationCursor,
    }).pipe(
      Effect.flatMap((batchSize) =>
        batchSize < workflowReconciliationBatchSize
          ? Effect.sleep(Duration.seconds(1))
          : Effect.sleep(Duration.millis(50)),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
).pipe(
  Layer.provide(workflowRuntimeCommandExecutorLayer),
  Layer.provide(sheetWorkflowRuntimeLayer),
);

const runnerReadinessProbeTimeout = Duration.seconds(15);

const clusterStartupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Sharding.Sharding;
    yield* Effect.logInfo("Started sheet-workflows sharding runtime");
    yield* getClusterRunnerReadinessSnapshot.pipe(
      Effect.delay(Duration.seconds(5)),
      Effect.flatMap((snapshot) => {
        const log = snapshot.hasRecentHealthyRunner ? Effect.logInfo : Effect.logWarning;
        return log("Checked sheet-workflows runner registration", snapshot);
      }),
      Effect.timeoutOrElse({
        duration: runnerReadinessProbeTimeout,
        orElse: () =>
          Effect.logWarning("sheet-workflows runner readiness probe timed out", {
            timeoutMillis: Duration.toMillis(runnerReadinessProbeTimeout),
          }),
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect sheet-workflows runner registration", cause),
      ),
      Effect.forkScoped,
    );
    yield* Effect.never.pipe(Effect.forkScoped);
  }),
);

const workflowCapabilityClientsLayer = Layer.mergeAll(
  sheetBotCacheClientLayer,
  sheetBotDeliveryClientLayer,
  sheetDataProviderLayer,
  sheetSnapshotProviderLayer,
);

const workflowDefinitionServicesLayer = Layer.mergeAll(
  readOnlyWorkflowDataSourceLayer.pipe(Layer.provideMerge(readOnlyWorkflowAuthorizationLayer)),
  preferencesWorkflowOperationsLayer,
  configurationWorkflowOperationsLayer,
  sheetConfigurationWorkflowOperationsLayer,
  slotWorkflowOperationsLayer,
  slotListWorkflowOperationsLayer.pipe(Layer.provide(slotListProviderLayer)),
  slotOpenWorkflowOperationsLayer.pipe(Layer.provide(slotListProviderLayer)),
  scheduleWorkflowOperationsLayer.pipe(Layer.provide(userScheduleProviderLayer)),
  teamWorkflowOperationsLayer.pipe(Layer.provide(userTeamsProviderLayer)),
  teamSubmissionsWorkflowOperationsLayer.pipe(
    Layer.provide(teamSubmissionProviderLayer),
    Layer.provide(readOnlyWorkflowAuthorizationLayer),
  ),
  checkinWorkflowOperationsLayer,
  checkinsOpenWorkflowOperationsLayer.pipe(Layer.provide(readOnlyWorkflowAuthorizationLayer)),
  autoCheckinTestWorkflowOperationsLayer.pipe(
    Layer.provide(autoCheckinTestProviderLayer),
    Layer.provide(readOnlyWorkflowAuthorizationLayer),
  ),
  roomOrderNavigationOperationsLayer.pipe(Layer.provide(roomOrderNavigationProviderLayer)),
  roomOrderSendOperationsLayer.pipe(Layer.provide(roomOrderNavigationProviderLayer)),
  roomOrderCreateOperationsLayer.pipe(Layer.provide(roomOrderCreateProviderLayer)),
  roomOrderTentativePinOperationsLayer.pipe(Layer.provide(roomOrderNavigationProviderLayer)),
  serviceStatusWorkflowOperationsLayer,
  workspaceWelcomeWorkflowOperationsLayer,
  workspaceFeatureFlagWorkflowOperationsLayer,
  updateAnnouncementWorkflowOperationsLayer.pipe(Layer.provide(readOnlyWorkflowAuthorizationLayer)),
  memberKickWorkflowOperationsLayer.pipe(
    Layer.provide(memberKickProviderLayer),
    Layer.provide(readOnlyWorkflowAuthorizationLayer),
  ),
  screenshotSourceOperationsLayer.pipe(
    Layer.provide(screenshotSourceProviderLayer),
    Layer.provide(readOnlyWorkflowAuthorizationLayer),
  ),
  calculationWorkflowOperationsLayer.pipe(
    Layer.provide(calculationProviderLayer),
    Layer.provide(readOnlyWorkflowAuthorizationLayer),
  ),
).pipe(
  Layer.provideMerge(workflowCapabilityClientsLayer),
  Layer.provideMerge(trustedSheetPersistenceLayer),
);

const browserWorkflowDefinitionServicesLayer = screenshotCaptureOperationsLayer.pipe(
  Layer.provide(screenshotBrowserLayer),
  Layer.provide(readOnlyWorkflowAuthorizationLayer),
  Layer.provideMerge(workflowCapabilityClientsLayer),
  Layer.provideMerge(trustedSheetPersistenceLayer),
);

type ClusterLayerOutput = WorkflowEngine.WorkflowEngine | Sharding.Sharding | Runners.Runners;

type ClusterLayerError =
  | AutonomousTriggerProviderError
  | AutoCheckinTestProviderError
  | CalculationProviderError
  | ConfigError
  | MemberKickProviderError
  | RoomOrderCreateProviderError
  | RoomOrderNavigationProviderError
  | ScreenshotSourceProviderError
  | SheetSnapshotProviderError
  | SlotListProviderError
  | SqlError
  | TeamSubmissionProviderError
  | UserScheduleProviderError
  | UserTeamsProviderError
  | WorkflowContractRegistrationError;

const clusterLayer: Layer.Layer<
  ClusterLayerOutput,
  ClusterLayerError,
  HttpClient.HttpClient | HttpRouter.HttpRouter | FileSystem.FileSystem | WorkflowStore
> = Layer.mergeAll(
  autonomousTriggerWorkflowLayer,
  smokeWorkflowLayer,
  readOnlySheetWorkflowLayers,
  preferencesSheetWorkflowLayers,
  configurationSheetWorkflowLayers,
  sheetConfigurationWorkflowLayers,
  slotSheetWorkflowLayers,
  scheduleSheetWorkflowLayers,
  teamSheetWorkflowLayers,
  teamSubmissionsSheetWorkflowLayers,
  checkinSheetWorkflowLayers,
  roomOrderSheetWorkflowLayers,
  serviceSheetWorkflowLayers,
  workspaceSheetWorkflowLayers,
  announcementSheetWorkflowLayers,
  memberSheetWorkflowLayers,
  screenshotOrdinaryWorkflowLayers,
  calculationSheetWorkflowLayers,
  selectedSheetWorkflowRegistrationValidationLayer,
  clusterStartupLayer,
  workflowCommandDispatcherLayer,
).pipe(
  Layer.provide(AutonomousTriggerService.layer),
  Layer.provide(workflowDefinitionServicesLayer),
  Layer.provideMerge(workflowsRunnerLayer),
  Layer.provide(postgresSqlLayer),
);

const browserClusterLayer = Layer.mergeAll(
  screenshotBrowserWorkflowLayers,
  clusterStartupLayer,
).pipe(
  Layer.provide(browserWorkflowDefinitionServicesLayer),
  Layer.provideMerge(workflowsRunnerLayer),
  Layer.provide(postgresSqlLayer),
);

const clusterHttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* config.workflowsRunnerListenHost;
    const port = yield* config.workflowsRunnerListenPort;
    return NodeHttpServer.layer(createServer, { host, port });
  }),
);

type ClusterHttpLayer = Layer.Layer<
  ClusterLayerOutput | HttpRouter.HttpRouter,
  ClusterLayerError | Layer.Error<typeof clusterHttpServerLayer>,
  HttpClient.HttpClient | WorkflowStore
>;

export const clusterHttpLayer: ClusterHttpLayer = HttpRouter.serve(
  clusterLayer.pipe(Layer.provideMerge(HttpRouter.layer)),
).pipe(Layer.provide(clusterHttpServerLayer), Layer.withSpan("sheet-workflows.clusterHttp"));

export const browserClusterHttpLayer = HttpRouter.serve(
  browserClusterLayer.pipe(Layer.provideMerge(HttpRouter.layer)),
).pipe(Layer.provide(clusterHttpServerLayer), Layer.withSpan("sheet-workflows.browserClusterHttp"));
