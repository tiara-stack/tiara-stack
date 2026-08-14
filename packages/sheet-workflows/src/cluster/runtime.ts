import { NodeHttpServer } from "@effect/platform-node";
import { Duration, Effect, Layer, Option } from "effect";
import {
  K8sHttpClient,
  RunnerAddress,
  RunnerHealth,
  Sharding,
  ShardingConfig,
} from "effect/unstable/cluster";
import { HttpRouter } from "effect/unstable/http";
import {
  clientOnlyShardingConfig,
  clusterWorkflowEngineClientLayer as makeClusterWorkflowEngineClientLayer,
  clusterWorkflowEngineRunnerLayer,
  clusterWorkflowStorageLayer,
} from "effect-zero-workflow";
import { createServer } from "node:http";
import { config } from "@/config";
import {
  AutoCheckinService,
  DispatchService,
  ClientDeliveryClient,
  SheetApisClient,
  sheetBotCacheClientLayer,
  sheetBotDeliveryClientLayer,
  trustedSheetPersistenceLayer,
} from "@/services";
import { autoCheckinWorkflowLayer } from "@/workflows/autoCheckin";
import { getClusterRunnerReadinessSnapshot, postgresSqlLayer } from "@/services";
import { dispatchButtonEntityLayer, dispatchWorkflowLayer } from "@/workflows/dispatch";
import { smokeWorkflowLayer } from "@/workflows/smoke";
import {
  readOnlyWorkflowAuthorizationLayer,
  readOnlyWorkflowDataSourceLayer,
  readOnlySheetWorkflowLayers,
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
import { slotSheetWorkflowLayers, slotWorkflowOperationsLayer } from "@/workflows/slots";
import { slotListWorkflowOperationsLayer } from "@/workflows/slots/slotListOperations";
import { slotListProviderLayer } from "@/workflows/slots/slotListProvider";
import { slotOpenWorkflowOperationsLayer } from "@/workflows/slots/slotOpenOperations";
import { scheduleSheetWorkflowLayers } from "@/workflows/schedules";
import { scheduleWorkflowOperationsLayer } from "@/workflows/schedules/operations";
import { userScheduleProviderLayer } from "@/workflows/schedules/provider";
import { teamSheetWorkflowLayers } from "@/workflows/teams";
import { teamWorkflowOperationsLayer } from "@/workflows/teams/operations";
import { userTeamsProviderLayer } from "@/workflows/teams/provider";
import { checkinSheetWorkflowLayers, checkinWorkflowOperationsLayer } from "@/workflows/checkins";
import { roomOrderCreateProviderLayer } from "@/workflows/roomOrders/createProvider";
import {
  roomOrderNavigationOperationsLayer,
  roomOrderNavigationProviderLayer,
  roomOrderCreateOperationsLayer,
  roomOrderSendOperationsLayer,
  roomOrderSheetWorkflowLayers,
} from "@/workflows/roomOrders";

const shardGroups = ["dispatch", "autoCheckin"] as const;

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

    return ShardingConfig.layer({
      runnerAddress: Option.some(runnerAddress),
      runnerListenAddress: Option.some(RunnerAddress.make(runnerListenHost, runnerListenPort)),
      assignedShardGroups: shardGroups,
      availableShardGroups: shardGroups,
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

const dispatchClientsLayer = Layer.mergeAll(
  ClientDeliveryClient.layer,
  SheetApisClient.layer,
  sheetBotCacheClientLayer,
  sheetBotDeliveryClientLayer,
);

const workflowDefinitionServicesLayer = Layer.mergeAll(
  readOnlyWorkflowDataSourceLayer.pipe(Layer.provideMerge(readOnlyWorkflowAuthorizationLayer)),
  preferencesWorkflowOperationsLayer,
  configurationWorkflowOperationsLayer,
  slotWorkflowOperationsLayer,
  slotListWorkflowOperationsLayer.pipe(Layer.provide(slotListProviderLayer)),
  slotOpenWorkflowOperationsLayer.pipe(Layer.provide(slotListProviderLayer)),
  scheduleWorkflowOperationsLayer.pipe(Layer.provide(userScheduleProviderLayer)),
  teamWorkflowOperationsLayer.pipe(Layer.provide(userTeamsProviderLayer)),
  checkinWorkflowOperationsLayer,
  roomOrderNavigationOperationsLayer.pipe(Layer.provide(roomOrderNavigationProviderLayer)),
  roomOrderSendOperationsLayer.pipe(Layer.provide(roomOrderNavigationProviderLayer)),
  roomOrderCreateOperationsLayer.pipe(Layer.provide(roomOrderCreateProviderLayer)),
).pipe(Layer.provideMerge(dispatchClientsLayer), Layer.provideMerge(trustedSheetPersistenceLayer));

const dispatchServicesLayer = Layer.effect(DispatchService, DispatchService.make).pipe(
  Layer.provideMerge(dispatchClientsLayer),
  Layer.provideMerge(trustedSheetPersistenceLayer),
);

const clusterLayer = Layer.mergeAll(
  dispatchButtonEntityLayer,
  dispatchWorkflowLayer,
  autoCheckinWorkflowLayer,
  smokeWorkflowLayer,
  readOnlySheetWorkflowLayers,
  preferencesSheetWorkflowLayers,
  configurationSheetWorkflowLayers,
  slotSheetWorkflowLayers,
  scheduleSheetWorkflowLayers,
  teamSheetWorkflowLayers,
  checkinSheetWorkflowLayers,
  roomOrderSheetWorkflowLayers,
  selectedSheetWorkflowRegistrationValidationLayer,
  clusterStartupLayer,
).pipe(
  Layer.provide(AutoCheckinService.layer),
  Layer.provide(dispatchServicesLayer),
  Layer.provide(workflowDefinitionServicesLayer),
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

export const clusterHttpLayer = HttpRouter.serve(
  clusterLayer.pipe(Layer.provideMerge(HttpRouter.layer)),
).pipe(Layer.provide(clusterHttpServerLayer), Layer.withSpan("sheet-workflows.clusterHttp"));
