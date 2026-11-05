#!/usr/bin/env node
import { NodeFileSystem, NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as Console from "effect/Console";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  executeDevelopmentPlan,
  renderLauncherOutput,
  renderLifecycleTerminal,
  runLauncherFromParsed,
  type DevelopmentPlanExecutionOptions,
} from "./index";
import type {
  ComposeLifecycleObservation,
  DevelopmentLifecycleObservation,
  KubernetesLifecycleObservation,
  LifecycleObservation,
} from "./execution";
import {
  developmentModes,
  modeActions,
  type DevelopmentMode,
  type LauncherResult,
  type ProcessExecutor,
} from "./types";
import {
  normalizeChangedSurfaces,
  parseCommand,
  parsePositionals,
  type CommandOptions,
} from "./commands";
import { makePreviewGatewaySessionLayer } from "./preview-gateway-session-layer";
import { PreviewGateway, PreviewGatewayError } from "./preview-gateway";
import {
  ConnectedWorkflowPreviewProvider,
  makeConnectedWorkflowPreviewRuntime,
  type ConnectedWorkflowPreviewProviderApi,
} from "./connected-preview";
import { PreviewSessionController, PreviewSessionControllerLive } from "./preview-sessions";
import {
  makePreviewWorkflowApiSupervisor,
  PreviewWorkflowApiSupervisor,
  type PreviewWorkflowApiSupervisorApi,
} from "./preview-workflow-api-supervisor";
import {
  makePreviewWorkflowApiSupervisorAdapters,
  PreviewWorkflowApiApplicationRoute,
  PreviewWorkflowApiCredentialProvider,
  PreviewWorkflowApiHostError,
} from "./preview-workflow-api-host";
import {
  loadPreviewWorkflowApiTrustedAuthority,
  loadPreviewWorkflowApiTrustedAuthorityWithKey,
  makePreviewWorkflowApiAuthorityExpiryAssertion,
  makePreviewWorkflowApiCredentialProvider,
  PreviewWorkflowApiTrustedAuthority,
} from "./preview-workflow-api-authority";
import {
  loadPreviewGatewayAdapters,
  PreviewGatewayRuntime,
  type PreviewGatewayRuntimeLoadResult,
} from "./preview-gateway-runtime";
import { CliLayerAcquisitionFailureForTesting } from "./cli-layer-test-support";
import {
  makeLocalFilesystemPreviewResourceAdapter,
  parsePreviewAllocationConfig,
  PreviewAllocationController,
  PreviewAllocationControllerLive,
  type PreviewAllocationConfigParseResult,
} from "./preview-allocations";
import {
  makePreviewRelayResourceAdapter,
  PreviewRelayProvider,
  PreviewRelayProviderLayer,
  PreviewRelayProviderUnavailable,
  makeConfiguredPreviewRelayPlatformClient,
  makePreviewRelayProvider,
  parsePreviewRelayProviderConfig,
} from "./preview-relay-provider";
import { makePreviewWebRuntime } from "./preview-web-runtime";
import { loadConfiguredWorkflowPreviewProvider } from "./workflow-preview-provider";

const commonFlags = {
  envFile: Flag.string("env-file").pipe(Flag.optional),
  configFile: Flag.string("config").pipe(Flag.optional),
  sessionId: Flag.string("session").pipe(Flag.optional),
  resource: Flag.string("resource").pipe(Flag.optional),
  generation: Flag.integer("generation").pipe(Flag.optional),
  service: Flag.string("service").pipe(Flag.optional),
  confirm: Flag.boolean("confirm").pipe(Flag.withDefault(false)),
  confirmDevelopment: Flag.boolean("confirm-development").pipe(Flag.withDefault(false)),
  tag: Flag.string("tag").pipe(Flag.optional),
  changedSurface: Flag.string("changed-surface").pipe(Flag.between(0, Number.MAX_SAFE_INTEGER)),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
  jsonStream: Flag.boolean("json-stream").pipe(Flag.withDefault(false)),
};

const launcherOptions = (config: {
  readonly operands: ReadonlyArray<string>;
  readonly envFile: Option.Option<string>;
  readonly configFile: Option.Option<string>;
  readonly sessionId: Option.Option<string>;
  readonly resource: Option.Option<string>;
  readonly generation: Option.Option<number>;
  readonly service: Option.Option<string>;
  readonly confirm: boolean;
  readonly confirmDevelopment: boolean;
  readonly tag: Option.Option<string>;
  readonly changedSurface: ReadonlyArray<string>;
  readonly json: boolean;
  readonly jsonStream: boolean;
}): CommandOptions => ({
  json: config.json,
  jsonStream: config.jsonStream,
  help: false,
  envFile: Option.getOrNull(config.envFile),
  configFile: Option.getOrNull(config.configFile),
  sessionId: Option.getOrNull(config.sessionId),
  resource: Option.getOrNull(config.resource),
  generation: Option.getOrNull(config.generation),
  service: Option.getOrNull(config.service),
  confirm: config.confirm,
  confirmDevelopment: config.confirmDevelopment,
  tag: Option.getOrNull(config.tag),
  changedSurfaces: config.changedSurface.flatMap(normalizeChangedSurfaces),
});

type ModePlanExecutionOptions<Observation extends DevelopmentLifecycleObservation> = Omit<
  DevelopmentPlanExecutionOptions,
  "onObservation"
> & {
  readonly onObservation?: (observation: Observation) => void;
};

export type ComposePlanExecutionOptions = ModePlanExecutionOptions<ComposeLifecycleObservation>;
export type KubernetesPlanExecutionOptions =
  ModePlanExecutionOptions<KubernetesLifecycleObservation>;
export type FastPlanExecutionOptions = ModePlanExecutionOptions<LifecycleObservation>;

const matchesModePlan = (result: LauncherResult, mode: DevelopmentMode) => {
  const actions: readonly string[] = modeActions[mode];
  return (
    result.output.mode === mode &&
    result.output.action !== null &&
    actions.includes(result.output.action)
  );
};

const isFastObservation = (
  observation: DevelopmentLifecycleObservation,
): observation is LifecycleObservation => observation.mode === "fast";

const isComposeObservation = (
  observation: DevelopmentLifecycleObservation,
): observation is ComposeLifecycleObservation => observation.mode === "compose";

const isKubernetesObservation = (
  observation: DevelopmentLifecycleObservation,
): observation is KubernetesLifecycleObservation => observation.mode === "kubernetes";

const executeExpectedModePlan = <Observation extends DevelopmentLifecycleObservation>(
  result: LauncherResult,
  json: boolean,
  mode: DevelopmentMode,
  options: ModePlanExecutionOptions<Observation>,
  isObservation: (observation: DevelopmentLifecycleObservation) => observation is Observation,
) => {
  if (!matchesModePlan(result, mode)) return result;
  const { onObservation, ...executionOptions } = options;
  return executeDevelopmentPlan(
    result,
    json,
    onObservation === undefined
      ? executionOptions
      : {
          ...executionOptions,
          onObservation: (observation) => {
            if (isObservation(observation)) onObservation(observation);
          },
        },
  );
};

export const executeComposePlan = (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  options: ComposePlanExecutionOptions = {},
) => executeExpectedModePlan(result, json, "compose", options, isComposeObservation);

export const executeKubernetesPlan = (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  executorOrOptions?: ProcessExecutor | KubernetesPlanExecutionOptions,
) =>
  executeExpectedModePlan(
    result,
    json,
    "kubernetes",
    typeof executorOrOptions === "function"
      ? { executor: executorOrOptions }
      : (executorOrOptions ?? {}),
    isKubernetesObservation,
  );

export const executeFastPlan = (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
  options: FastPlanExecutionOptions = {},
) => executeExpectedModePlan(result, json, "fast", options, isFastObservation);

export { executeDevelopmentPlan };
export type { DevelopmentPlanExecutionOptions };

const isExecutablePlan = (result: Awaited<ReturnType<typeof runLauncherFromParsed>>) =>
  result.output.ok &&
  result.output.plannedProcesses.length > 0 &&
  developmentModes.some((mode) => matchesModePlan(result, mode));

export type PreviewSupervisorEffect = import("effect/Effect").Effect<
  void,
  never,
  import("effect/FileSystem").FileSystem | import("effect/unstable/http").HttpClient.HttpClient
>;

export class PreviewSupervisorSchedulerService extends Context.Service<
  PreviewSupervisorSchedulerService,
  (sessionId: string, supervisor: PreviewSupervisorEffect) => void
>()("developer-launcher/PreviewSupervisorScheduler") {}

export const completeCommandOutput = (
  output: string | null,
  supervisor?: PreviewSupervisorEffect,
) =>
  Effect.gen(function* () {
    if (output !== null) yield* Console.log(output);
    if (supervisor !== undefined)
      yield* supervisor.pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide(FetchHttpClient.layer),
      );
  });

const runLauncherAndPlan = async (
  config: Parameters<typeof launcherOptions>[0],
  options: CommandOptions,
  launcherConfig: import("./types").LauncherOptions,
) => {
  let result = await runLauncherFromParsed(config.operands, options, launcherConfig);
  const shouldExecutePlan = isExecutablePlan(result);
  const lifecycleExecutionStarted = config.jsonStream && shouldExecutePlan;
  if (shouldExecutePlan)
    result = await executeDevelopmentPlan(result, config.json || config.jsonStream, {
      jsonStream: config.jsonStream,
    });
  return { result, lifecycleExecutionStarted };
};

const formatLauncherResult = (
  result: LauncherResult,
  config: Parameters<typeof launcherOptions>[0],
  supervisor: PreviewSupervisorEffect | undefined,
  lifecycleExecutionStarted: boolean,
) => {
  process.exitCode = result.exitCode;
  if (config.jsonStream) {
    if (result.stdout.trim().length > 0) process.stdout.write(result.stdout);
    if (result.output.ok && !lifecycleExecutionStarted)
      process.stdout.write(renderLifecycleTerminal(result.output, result.exitCode, 2));
    else if (!result.output.ok && !lifecycleExecutionStarted && result.stdout.trim().length === 0)
      process.stdout.write(renderLifecycleTerminal(result.output, result.exitCode, 1));
    return { output: null, supervisor };
  }
  const output = result.stdout.trimEnd();
  return {
    output: output.length === 0 ? null : output,
    supervisor,
  };
};

const resolvePreviewWorkflowApiCredentialConfiguration = Effect.gen(function* () {
  const configuredCredentials = yield* Effect.serviceOption(PreviewWorkflowApiCredentialProvider);
  const authorityState = yield* Effect.serviceOption(PreviewWorkflowApiTrustedAuthority);
  const authority =
    Option.isSome(authorityState) && Option.isSome(authorityState.value)
      ? authorityState.value.value
      : undefined;
  const configuredProvider = Option.isSome(configuredCredentials)
    ? configuredCredentials.value
    : undefined;
  const baseProvider =
    configuredProvider ??
    (authority === undefined
      ? undefined
      : makePreviewWorkflowApiCredentialProvider({
          authority,
          readEnvironment: (name) => process.env[name],
        }));
  if (baseProvider === undefined) return undefined;
  if (authority === undefined) return { credentialProvider: baseProvider };

  const assertAuthorityCurrent = makePreviewWorkflowApiAuthorityExpiryAssertion({
    expiresAt: authority.expiresAt,
  });
  const credentialProvider = {
    ...baseProvider,
    assertCurrent: assertAuthorityCurrent,
    resolveDatabaseTarget: (input: Parameters<typeof baseProvider.resolveDatabaseTarget>[0]) =>
      assertAuthorityCurrent().pipe(
        Effect.andThen(baseProvider.resolveDatabaseTarget(input)),
        Effect.tap(() => assertAuthorityCurrent()),
      ),
    resolve: (input: Parameters<typeof baseProvider.resolve>[0]) =>
      assertAuthorityCurrent().pipe(
        Effect.andThen(baseProvider.resolve(input)),
        Effect.tap(() => assertAuthorityCurrent()),
      ),
  };
  return {
    credentialProvider,
    trustedRuntimeArtifactAttestations: authority.runtimeArtifactAttestations,
  };
});

const resolvePreviewWorkflowApiSupervisor = Effect.gen(function* () {
  const configured = yield* Effect.serviceOption(PreviewWorkflowApiSupervisor);
  if (Option.isSome(configured)) return configured.value;
  const gatewayRuntime = yield* Effect.serviceOption(PreviewGatewayRuntime);
  if (Option.isNone(gatewayRuntime) || Option.isNone(gatewayRuntime.value.runtime))
    return undefined;
  const route = yield* Effect.serviceOption(PreviewWorkflowApiApplicationRoute);
  if (Option.isNone(route)) return undefined;
  const credentialConfiguration = yield* resolvePreviewWorkflowApiCredentialConfiguration;
  if (credentialConfiguration === undefined) return undefined;
  const adapters = yield* makePreviewWorkflowApiSupervisorAdapters({
    credentialProvider: credentialConfiguration.credentialProvider,
    route: route.value,
    ...(credentialConfiguration.trustedRuntimeArtifactAttestations === undefined
      ? {}
      : {
          trustedRuntimeArtifactAttestations:
            credentialConfiguration.trustedRuntimeArtifactAttestations,
        }),
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), Effect.provide(NodeFileSystem.layer));
  return makePreviewWorkflowApiSupervisor(adapters);
});

const previewGatewayUnavailableReasonFrom = (
  runtimeState: Option.Option<PreviewGatewayRuntimeLoadResult>,
) =>
  Option.isSome(runtimeState)
    ? Option.getOrUndefined(runtimeState.value.unavailableReason)
    : undefined;

const previewWorkflowApiSupervisorUnavailableReasonFrom = (input: {
  readonly supervisor: PreviewWorkflowApiSupervisorApi | undefined;
  readonly failure: PreviewWorkflowApiHostError | undefined;
  readonly runtimeState: Option.Option<PreviewGatewayRuntimeLoadResult>;
}): string | undefined => {
  if (input.supervisor !== undefined) return undefined;
  if (input.failure === undefined) return previewGatewayUnavailableReasonFrom(input.runtimeState);
  return [input.failure.reason, input.failure.phase].filter((part) => part !== undefined).join(":");
};

const runParsedCommand = (config: Parameters<typeof launcherOptions>[0]) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const gatewayRuntimeState = yield* Effect.serviceOption(PreviewGatewayRuntime);
    const workflowApiSupervisorResolution = yield* resolvePreviewWorkflowApiSupervisor.pipe(
      Effect.map((supervisor) => ({ supervisor, failure: undefined })),
      Effect.catch((failure: PreviewWorkflowApiHostError) =>
        Effect.succeed({ supervisor: undefined, failure }),
      ),
    );
    const workflowApiSupervisor = workflowApiSupervisorResolution.supervisor;
    const previewGatewayRuntimeUnavailableReason =
      previewGatewayUnavailableReasonFrom(gatewayRuntimeState);
    const workflowApiSupervisorUnavailableReason =
      previewWorkflowApiSupervisorUnavailableReasonFrom({
        supervisor: workflowApiSupervisor,
        failure: workflowApiSupervisorResolution.failure,
        runtimeState: gatewayRuntimeState,
      });
    const sessionController = yield* Effect.serviceOption(PreviewSessionController);
    const allocationController = yield* Effect.serviceOption(PreviewAllocationController);
    const relayProvider = yield* Effect.serviceOption(PreviewRelayProvider);
    const gateway = yield* Effect.serviceOption(PreviewGateway);
    const workflowProvider = yield* Effect.serviceOption(ConnectedWorkflowPreviewProvider);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const hostSupervisorScheduler = yield* Effect.serviceOption(PreviewSupervisorSchedulerService);
    const options = { ...launcherOptions(config), clock };
    let supervisorEffect: PreviewSupervisorEffect | undefined;
    const scheduleSupervisor = Option.match(hostSupervisorScheduler, {
      onNone: () => (_sessionId: string, supervisor: PreviewSupervisorEffect) => {
        supervisorEffect = supervisor;
      },
      onSome: (schedule) => schedule,
    });
    const workflowOptions = Option.match(workflowProvider, {
      onNone: () => options,
      onSome: (provider) =>
        Match.value(provider).pipe(
          Match.tag("Configured", (configuredProvider) =>
            Option.match(sessionController, {
              onNone: () => ({
                ...options,
                workflowPreviewUnavailableReason: "session-controller-unavailable",
              }),
              onSome: (sessionControllerValue) =>
                Option.match(fileSystem, {
                  onNone: () => options,
                  onSome: (fileSystemValue) =>
                    composeWorkflowPreviewLauncherOptions(options, {
                      provider: configuredProvider,
                      sessionController: sessionControllerValue,
                      fileSystem: fileSystemValue,
                      previewSupervisorScheduler: scheduleSupervisor,
                      clock,
                      environment: process.env,
                    }),
                }),
            }),
          ),
          Match.tag("Unavailable", () =>
            retainUnavailableWorkflowPreviewReason(options, workflowProvider),
          ),
          Match.orElse(() => options),
        ),
    });
    const launcherConfig = {
      ...workflowOptions,
      previewWebRuntime,
      previewSupervisorScheduler: scheduleSupervisor,
      ...(Option.isSome(sessionController)
        ? { previewSessionController: sessionController.value }
        : {}),
      ...(Option.isSome(allocationController)
        ? { previewAllocationController: allocationController.value }
        : {}),
      ...(Option.isSome(gateway) ? { previewGateway: gateway.value } : {}),
      ...(Option.isSome(relayProvider) ? { previewRelayProvider: relayProvider.value } : {}),
      ...(workflowApiSupervisor === undefined
        ? {}
        : {
            previewWorkflowApiSupervisor: workflowApiSupervisor,
            onPreviewSessionReady: (
              session: import("./preview-sessions").PreviewSession,
              applicationOrigin: string,
            ) =>
              process.stderr.write(
                `Connected workflow API preview ${session.id} is ready at ${applicationOrigin} for revision ${session.activeRevision ?? "unknown"} (generation ${session.generation}).\n`,
              ),
          }),
      ...(workflowApiSupervisorUnavailableReason === undefined
        ? {}
        : {
            previewWorkflowApiSupervisorUnavailableReason: workflowApiSupervisorUnavailableReason,
          }),
      ...(previewGatewayRuntimeUnavailableReason === undefined
        ? {}
        : { previewGatewayRuntimeUnavailableReason }),
    };
    const completed = yield* Effect.tryPromise({
      try: async () => {
        const completed = await runLauncherAndPlan(config, options, launcherConfig);
        return formatLauncherResult(
          completed.result,
          config,
          supervisorEffect,
          completed.lifecycleExecutionStarted,
        );
      },
      catch: (cause) => {
        process.exitCode = 1;
        return cause instanceof Error
          ? cause
          : new Error("The development launcher failed before it could produce a result.");
      },
    }).pipe(
      Effect.flatMap(({ output, supervisor }) => completeCommandOutput(output, supervisor)),
      Effect.catch((error: unknown) =>
        Console.error(error instanceof Error ? error.message : "The development launcher failed."),
      ),
    );
    return completed;
  });

const renderSessionLayerAcquisitionFailure = (
  config: Parameters<typeof launcherOptions>[0],
  failure: unknown,
) =>
  Effect.promise(() => runLauncherFromParsed(config.operands, launcherOptions(config))).pipe(
    Effect.map((result) => {
      if (!(failure instanceof PreviewGatewayError) || result.output.errors.length === 0)
        return result;
      const output = {
        ...result.output,
        errors: result.output.errors.map((diagnostic, index) =>
          index === 0
            ? {
                ...diagnostic,
                message: `${diagnostic.message} (PreviewGatewayError: ${failure.reason})`,
              }
            : diagnostic,
        ),
      };
      return {
        ...result,
        output,
        stdout: config.jsonStream
          ? renderLifecycleTerminal(output, result.exitCode)
          : renderLauncherOutput(output, config.json),
      };
    }),
    Effect.flatMap((result) => {
      const formatted = formatLauncherResult(result, config, undefined, false);
      return completeCommandOutput(formatted.output);
    }),
  );

const handleCliActionLayerFailure = <Failure>(
  config: Parameters<typeof launcherOptions>[0],
  failure: Failure,
) => {
  let action: string | undefined;
  try {
    const parsed = parsePositionals(config.operands, launcherOptions(config));
    action = parsed.kind === "preview" ? parsed.action : undefined;
  } catch {
    action = undefined;
  }
  return action !== undefined && sessionActions.has(action)
    ? renderSessionLayerAcquisitionFailure(config, failure)
    : Effect.fail(new Error("The CLI action layer could not be acquired.", { cause: failure }));
};

const runCommandWithActionLayer = (config: Parameters<typeof launcherOptions>[0]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const testFailure = yield* Effect.serviceOption(CliLayerAcquisitionFailureForTesting);
      if (Option.isSome(testFailure)) {
        return yield* Layer.build(
          Layer.fromBuild((_memoMap, layerScope) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                testFailure.value.onBuild();
              }),
              () => Effect.sync(() => testFailure.value.onRelease()),
            ).pipe(
              Effect.provideService(Scope.Scope, layerScope),
              Effect.andThen(Effect.fail(testFailure.value.error)),
            ),
          ),
        ).pipe(
          Effect.matchEffect({
            onFailure: (failure) => handleCliActionLayerFailure(config, failure),
            onSuccess: () =>
              Effect.die(new Error("The injected CLI layer failure unexpectedly succeeded")),
          }),
        );
      }
      return yield* Layer.build(cliActionLayer).pipe(
        Effect.matchEffect({
          onFailure: (failure) => handleCliActionLayerFailure(config, failure),
          onSuccess: (context) => Effect.provideContext(runParsedCommand(config), context),
        }),
      );
    }),
  );

export const command = Command.make(
  "dev",
  {
    operands: Argument.string("command").pipe(Argument.variadic()),
    ...commonFlags,
  },
  runCommandWithActionLayer,
).pipe(
  Command.withDescription(
    "Select a safe TiaraStack development mode, inspect connected preview admission, or run read-only prerequisite checks",
  ),
  Command.withExamples([
    { command: "pnpm dev", description: "Print the launcher help" },
    { command: "pnpm dev fast up", description: "Plan the Fast sheet-web slice" },
    {
      command: "pnpm dev preview plan --config ./preview.json",
      description: "Print a read-only connected preview plan",
    },
    {
      command: "pnpm dev preview doctor --config ./preview.json",
      description: "Check connected preview prerequisites",
    },
    {
      command: "pnpm dev preview baseline --config ./preview.json",
      description: "Import an operator-collected capacity baseline into the controller",
    },
    {
      command: "pnpm dev preview start --config ./preview.json",
      description: "Create a pending session; live runtime profiles remain unavailable",
    },
    {
      command:
        "pnpm dev preview recreate --config ./preview.json --session <id> --confirm-development",
      description:
        "Settle incompatible workflow work before replacing its session and staged source",
    },
    {
      command: "pnpm dev preview status --session <id>",
      description: "Read the durable session record without renewing its lease",
    },
    {
      command: "pnpm dev preview resume --session <id>",
      description: "Resume a live session and fence its previous supervisor",
    },
    {
      command: "pnpm dev preview heartbeat --session <id> --generation <n>",
      description: "Renew the current supervisor lease",
    },
    {
      command: "pnpm dev preview stop --session <id>",
      description: "Idempotently close ordinary session admission",
    },
    {
      command: "pnpm dev preview cleanup --session <id>",
      description: "Clean ended owned resources or inspect waiting/quarantined cleanup state",
    },
    {
      command: "pnpm dev preview resolve --session <id> --resource <key>",
      description: "Verify ownership of one quarantined allocation through its provider adapter",
    },
    { command: "pnpm dev doctor --json", description: "Run prerequisite checks as JSON" },
  ]),
);

const sessionDatabase = process.env.TIARA_PREVIEW_SESSION_DATABASE;
const resolvedSessionDatabase =
  sessionDatabase === undefined || sessionDatabase.trim() === ""
    ? undefined
    : path.resolve(sessionDatabase);
const previewWebRuntime = makePreviewWebRuntime(
  resolvedSessionDatabase === undefined
    ? {}
    : { registryDirectory: `${resolvedSessionDatabase}.credentials/web-processes` },
);

/** The shipped CLI composes provider operations with its durable session service here. */
export const composeWorkflowPreviewLauncherOptions = (
  options: import("./types").LauncherOptions,
  input: {
    readonly provider: Extract<
      ConnectedWorkflowPreviewProviderApi,
      { readonly _tag: "Configured" }
    >;
    readonly sessionController: import("./preview-sessions").PreviewSessionControllerApi;
    readonly fileSystem: FileSystem.FileSystem;
    readonly previewSupervisorScheduler: NonNullable<
      import("./types").LauncherOptions["previewSupervisorScheduler"]
    >;
    readonly clock?: Clock.Clock;
    readonly environment?: NodeJS.ProcessEnv;
  },
): import("./types").LauncherOptions => ({
  ...options,
  previewSessionController: input.sessionController,
  workflowPreviewRuntime: makeConnectedWorkflowPreviewRuntime({
    provider: input.provider,
    controller: input.sessionController,
    previewSupervisorScheduler: input.previewSupervisorScheduler,
    fileSystem: input.fileSystem,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    env: input.environment ?? process.env,
  }),
});

const retainUnavailableWorkflowPreviewReason = (
  options: import("./types").LauncherOptions,
  workflowProvider: Option.Option<ConnectedWorkflowPreviewProviderApi>,
): import("./types").LauncherOptions => {
  return Option.match(workflowProvider, {
    onNone: () => options,
    onSome: (provider) =>
      Match.value(provider).pipe(
        Match.tag("Unavailable", ({ reason }) => ({
          ...options,
          workflowPreviewUnavailableReason: reason,
        })),
        Match.tag("Configured", () => options),
        Match.orElse(() => options),
      ),
  });
};

const sessionActions = new Set([
  "start",
  "status",
  "heartbeat",
  "resume",
  "recreate",
  "stop",
  "cleanup",
  "resolve",
]);
const workflowApiSessionActions = new Set(["start", "resume", "recreate"]);
const args = process.argv.slice(2);
const previewActionFromArguments = (arguments_: readonly string[]) => {
  try {
    const parsed = parseCommand(arguments_);
    return parsed.kind === "preview" ? parsed.action : undefined;
  } catch {
    return undefined;
  }
};
const previewSessionIdFromArguments = (arguments_: readonly string[]) => {
  try {
    const parsed = parseCommand(arguments_);
    return parsed.kind === "preview" ? (parsed.options.sessionId ?? undefined) : undefined;
  } catch {
    return undefined;
  }
};
export const previewGatewayListenerSelectionForArguments = (arguments_: readonly string[]) => ({
  action: previewActionFromArguments(arguments_),
  sessionId: previewSessionIdFromArguments(arguments_),
});
export function previewWorkflowApiAuthorityLayerForArguments(
  arguments_: readonly string[],
  input: { readonly checkout: string; readonly environment: NodeJS.ProcessEnv },
  trustedPublicKeyPem?: string,
) {
  const action = previewActionFromArguments(arguments_);
  return action !== undefined && workflowApiSessionActions.has(action)
    ? Layer.effect(
        PreviewWorkflowApiTrustedAuthority,
        trustedPublicKeyPem === undefined
          ? loadPreviewWorkflowApiTrustedAuthority(input)
          : loadPreviewWorkflowApiTrustedAuthorityWithKey(input, trustedPublicKeyPem),
      ).pipe(Layer.provide(NodeFileSystem.layer))
    : Layer.succeed(PreviewWorkflowApiTrustedAuthority, Option.none());
}
type PreviewGatewayRuntimeLoader = (input: {
  readonly checkout: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly authority: import("./preview-workflow-api-authority").PreviewWorkflowApiAuthorityPayload;
}) => Effect.Effect<PreviewGatewayRuntimeLoadResult>;

const unavailablePreviewGatewayRuntime = (): PreviewGatewayRuntimeLoadResult => ({
  runtime: Option.none(),
  unavailableReason: Option.none(),
});

/** Builds the same signed-authority plus host-installed gateway runtime layer used by the CLI. */
export function previewGatewayRuntimeLayerForArguments(
  arguments_: readonly string[],
  input: { readonly checkout: string; readonly environment: NodeJS.ProcessEnv },
  options: {
    readonly trustedPublicKeyPem?: string;
    readonly loadRuntime?: PreviewGatewayRuntimeLoader;
  } = {},
) {
  const action = previewActionFromArguments(arguments_);
  if (action === undefined || !workflowApiSessionActions.has(action))
    return Layer.succeed(PreviewGatewayRuntime, unavailablePreviewGatewayRuntime());
  const authorityLayer = previewWorkflowApiAuthorityLayerForArguments(
    arguments_,
    input,
    options.trustedPublicKeyPem,
  );
  const loadRuntime = options.loadRuntime ?? loadPreviewGatewayAdapters;
  return Layer.effect(
    PreviewGatewayRuntime,
    Effect.gen(function* () {
      const authorityState = yield* PreviewWorkflowApiTrustedAuthority;
      if (Option.isNone(authorityState)) return unavailablePreviewGatewayRuntime();
      return yield* loadRuntime({
        checkout: input.checkout,
        environment: input.environment,
        authority: authorityState.value,
      });
    }),
  ).pipe(Layer.provideMerge(authorityLayer), Layer.provide(NodeFileSystem.layer));
}
const previewGatewayListenerSelection = previewGatewayListenerSelectionForArguments(args);
const previewAction = previewGatewayListenerSelection.action;
const previewSessionId = previewGatewayListenerSelection.sessionId;
const previewGatewayRuntimeLayer = previewGatewayRuntimeLayerForArguments(args, {
  checkout: process.cwd(),
  environment: process.env,
});
const isPreviewSessionAction =
  previewAction !== undefined &&
  (sessionActions.has(previewAction) || previewAction === "baseline");
const readOnlyCapacityDoctor = (() => {
  if (previewAction !== "doctor" || resolvedSessionDatabase === undefined) return false;
  try {
    return statSync(resolvedSessionDatabase).isFile();
  } catch {
    return false;
  }
})();
const allocationControllerNeeded =
  previewAction === "baseline" ||
  previewAction === "start" ||
  previewAction === "status" ||
  previewAction === "cleanup" ||
  previewAction === "resolve" ||
  readOnlyCapacityDoctor;
const sessionControllerNeeded = previewAction !== undefined && sessionActions.has(previewAction);
const previewAllocationConfig = parsePreviewAllocationConfig(
  process.env.TIARA_PREVIEW_MAX_MEASUREMENT_AGE_MS,
);
const previewRelayConfigPath = process.env.TIARA_PREVIEW_RELAY_CONFIG;
let previewRelayConfigDiagnostic: string | undefined;
const previewRelayConfig = (() => {
  if (previewRelayConfigPath === undefined) return undefined;
  try {
    const parsed = parsePreviewRelayProviderConfig(readFileSync(previewRelayConfigPath, "utf8"));
    if (parsed === undefined)
      previewRelayConfigDiagnostic =
        "TIARA_PREVIEW_RELAY_CONFIG points to invalid configuration; session relay profiles remain unavailable.";
    return parsed;
  } catch {
    previewRelayConfigDiagnostic =
      "TIARA_PREVIEW_RELAY_CONFIG could not be read; session relay profiles remain unavailable.";
    return undefined;
  }
})();
const previewRelayToken =
  previewRelayConfig === undefined
    ? undefined
    : process.env[previewRelayConfig.tokenEnvironmentName];
if (
  previewRelayConfig !== undefined &&
  (previewRelayToken === undefined || previewRelayToken.trim().length === 0)
)
  previewRelayConfigDiagnostic =
    "The configured session relay token is missing or empty; session relay profiles remain unavailable.";
if (previewAction !== undefined && previewRelayConfigDiagnostic !== undefined)
  process.stderr.write(`${previewRelayConfigDiagnostic}\n`);
const previewRelayProvider =
  previewRelayConfig === undefined ||
  previewRelayToken === undefined ||
  previewRelayToken.trim().length === 0
    ? PreviewRelayProviderUnavailable()
    : makePreviewRelayProvider(
        previewRelayConfig,
        makeConfiguredPreviewRelayPlatformClient(undefined, previewRelayConfig),
      );
export const previewAllocationConfigDiagnostic = (
  config: PreviewAllocationConfigParseResult,
  allocationBackedAction: boolean,
  controllerStoreConfigured: boolean,
) =>
  allocationBackedAction && controllerStoreConfigured && "error" in config
    ? config.error
    : undefined;
const previewAllocationLayer = (databasePath: string) =>
  "config" in previewAllocationConfig
    ? PreviewAllocationControllerLive(
        makePreviewRelayResourceAdapter(
          makeLocalFilesystemPreviewResourceAdapter(`${databasePath}.allocations`),
          previewRelayProvider,
        ),
        Date.now,
        previewAllocationConfig.config,
        !readOnlyCapacityDoctor,
      )
    : Layer.empty;
// Cleanup remains available without live gateway/authentication adapters. It never opens routes.
const previewSessionLayer = PreviewSessionControllerLive(Date.now);
const previewSessionWithGatewayCleanup = sessionControllerNeeded
  ? makePreviewGatewaySessionLayer({
      runtimeLayer: previewGatewayRuntimeLayer,
      sessionLayer: previewSessionLayer,
      now: Date.now,
      action: previewGatewayListenerSelection.action,
      listenerLeaseManagement: sessionControllerNeeded,
      ...(previewSessionId === undefined ? {} : { sessionId: previewSessionId }),
    })
  : previewSessionLayer;
const previewDatabaseLayer =
  resolvedSessionDatabase === undefined || (!allocationControllerNeeded && !sessionControllerNeeded)
    ? Layer.empty
    : Layer.provide(
        Layer.mergeAll(
          sessionControllerNeeded ? previewSessionWithGatewayCleanup : Layer.empty,
          allocationControllerNeeded
            ? previewAllocationLayer(resolvedSessionDatabase)
            : Layer.empty,
        ),
        Layer.mergeAll(
          SqliteClient.layer({
            filename: resolvedSessionDatabase,
            ...(readOnlyCapacityDoctor ? { readonly: true, disableWAL: true } : {}),
          }),
          NodeServices.layer,
        ),
      );
const workflowPreviewProviderLayerForAction = (
  action: string | undefined,
  input: { readonly checkout: string; readonly environment: NodeJS.ProcessEnv },
) =>
  action === "recreate"
    ? Layer.effect(
        ConnectedWorkflowPreviewProvider,
        loadConfiguredWorkflowPreviewProvider(input),
      ).pipe(Layer.provide(NodeServices.layer))
    : Layer.empty;
export const workflowPreviewProviderLayerForArguments = (
  arguments_: readonly string[],
  input: { readonly checkout: string; readonly environment: NodeJS.ProcessEnv },
) => workflowPreviewProviderLayerForAction(previewActionFromArguments(arguments_), input);
const workflowPreviewProviderLayer = workflowPreviewProviderLayerForArguments(args, {
  checkout: process.cwd(),
  environment: process.env,
});
const cliBaseLayer = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  PreviewRelayProviderLayer(previewRelayProvider),
);
const cliActionLayer = Layer.mergeAll(previewDatabaseLayer, workflowPreviewProviderLayer);

export const main = Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(cliBaseLayer));

export const runMain = () => NodeRuntime.runMain(main);

const isMain = () => {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return path.resolve(entryPath) === path.resolve(modulePath);
  }
};

const reportAllocationConfigDiagnostic = () => {
  const message = previewAllocationConfigDiagnostic(
    previewAllocationConfig,
    allocationControllerNeeded,
    resolvedSessionDatabase !== undefined,
  );
  if (message !== undefined) process.stderr.write(`${message}\n`);
};

// fallow-ignore-next-line code-duplication
if (isMain()) {
  if (isPreviewSessionAction && resolvedSessionDatabase !== undefined) {
    process.umask(0o077);
    let storageReady = true;
    try {
      const databaseDirectory = path.dirname(resolvedSessionDatabase);
      mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
      const directoryInfo = statSync(databaseDirectory);
      const directoryMode = directoryInfo.mode;
      const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        currentUid === undefined ||
        directoryInfo.uid !== currentUid ||
        (directoryMode & 0o022) !== 0
      ) {
        throw new Error("unsafe-database-directory");
      }
      let databaseFile: ReturnType<typeof lstatSync> | undefined;
      try {
        databaseFile = lstatSync(resolvedSessionDatabase);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
      if (databaseFile !== undefined) {
        if (!databaseFile.isFile()) throw new Error("unsafe-database-file");
        const descriptor = openSync(
          resolvedSessionDatabase,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const openedFile = fstatSync(descriptor);
          if (
            !openedFile.isFile() ||
            (typeof process.getuid === "function" && openedFile.uid !== process.getuid())
          ) {
            throw new Error("unsafe-database-file");
          }
          fchmodSync(descriptor, 0o600);
        } finally {
          closeSync(descriptor);
        }
      }
    } catch {
      process.stderr.write(
        "Unable to prepare protected preview session storage; use a current-user-owned parent directory without group or world write access and a regular database file owned by the current user.\n",
      );
      process.exitCode = 2;
      storageReady = false;
    }
    if (storageReady) {
      reportAllocationConfigDiagnostic();
      runMain();
    }
  } else {
    if (allocationControllerNeeded && readOnlyCapacityDoctor) reportAllocationConfigDiagnostic();
    runMain();
  }
}
