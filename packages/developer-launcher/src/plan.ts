import {
  type ComposeModeConfig,
  type FastModeConfig,
  type KubernetesModeConfig,
  type ModeConfig,
} from "./config";
import type {
  ComposeAction,
  FastAction,
  KubernetesAction,
  ModeAction,
  PlannedProcess,
  FastService,
  ChangedSurface,
  ParityGate,
} from "./types";
import { selectParityGates } from "./parity";

export interface ModePlan {
  readonly selectedServices: readonly string[];
  readonly plannedProcesses: readonly PlannedProcess[];
  readonly urls: ModeConfig["urls"];
  readonly parityGates: readonly ParityGate[];
}

const processPlan = (
  id: string,
  packageName: string | null,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  longLived = false,
  readOnly = false,
): PlannedProcess => ({
  id,
  packageName,
  command,
  args,
  environment,
  longLived,
  readOnly,
});

const parityProcess = (id: string, config: KubernetesModeConfig) =>
  processPlan(
    `kubernetes-${id}`,
    null,
    "pnpm",
    ["kubernetes:parity-gate", "--gate", id, "--development-only"],
    {
      KUBE_CONTEXT: config.environment.KUBE_CONTEXT,
      KUBE_NAMESPACE: config.environment.KUBE_NAMESPACE,
      ...(config.environment.KUBECONFIG === undefined
        ? {}
        : { KUBECONFIG: config.environment.KUBECONFIG }),
    },
    false,
    true,
  );

const helmLintProcess = (values: readonly string[]) =>
  processPlan(
    "helm-lint",
    null,
    "helm",
    [
      "lint",
      "--strict",
      "charts/tiara-stack",
      ...values,
      "--values",
      "charts/tiara-stack/values-development.yaml",
    ],
    {},
    false,
    true,
  );

const helmRenderProcess = (config: KubernetesModeConfig, values: readonly string[]) =>
  processPlan(
    "helm-render",
    null,
    "helm",
    [
      "template",
      config.environment.KUBE_RELEASE,
      "charts/tiara-stack",
      "--namespace",
      config.environment.KUBE_NAMESPACE,
      ...values,
      "--values",
      "charts/tiara-stack/values-development.yaml",
    ],
    {},
    false,
    true,
  );

const composePrefix = (config: ComposeModeConfig) =>
  config.envFile === null
    ? ["compose", "--project-name", config.projectName]
    : ["compose", "--project-name", config.projectName, "--env-file", config.envFile];

const fastPlan = (config: FastModeConfig, selectedServices: readonly string[]): ModePlan => ({
  selectedServices,
  plannedProcesses: selectedServices.map((service) => {
    const fastService = service as FastService;
    if (fastService === "sheet-web") {
      return processPlan(
        fastService,
        fastService,
        "vp",
        ["dev", "--port", String(config.servicePorts[fastService])],
        config.serviceEnvironments[fastService],
        true,
      );
    }
    const entrypoint =
      fastService === "sheet-auth"
        ? "src/server.ts"
        : fastService === "sheet-bot"
          ? "src/main.ts"
          : "src/index.ts";
    return processPlan(
      fastService,
      fastService,
      "pnpm",
      ["exec", "tsx", "watch", "--tsconfig", "tsconfig.json", entrypoint],
      {
        ...config.serviceEnvironments[fastService],
        PORT: String(config.servicePorts[fastService]),
      },
      true,
    );
  }),
  urls: [
    ...config.urls,
    ...selectedServices
      .filter((service) => service !== "sheet-web")
      .map((service) => ({
        name: service,
        url: `http://localhost:${config.servicePorts[service as FastService]}`,
      })),
  ],
  parityGates: [],
});

// fallow-ignore-next-line complexity
const composePlan = (
  config: ComposeModeConfig,
  action: ComposeAction,
  selectedServices: readonly string[],
  serviceSelectionExplicit: boolean,
): ModePlan => {
  const envFile = config.envFile ?? "deploy/compose/.env";
  const prefix = composePrefix(config);
  if (action === "up") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan("compose-docker-check", null, "docker", ["version"], {}, false, true),
        processPlan("compose-dependencies", null, "docker", [
          ...prefix,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "150",
          "postgres",
          "redis",
          "local-jwks",
          "local-otel-sink",
        ]),
        processPlan("compose-migrations", null, "pnpm", [
          "compose:migrate-sheet-db",
          "--",
          "--env-file",
          envFile,
        ]),
        processPlan(
          "compose-applications",
          null,
          "docker",
          [...prefix, "up", "--no-build", ...selectedServices],
          {},
          true,
        ),
      ],
      urls: config.urls,
      parityGates: [],
    };
  }
  if (action === "build") {
    return {
      selectedServices,
      plannedProcesses: [
        ...selectedServices.map((service) =>
          processPlan(`compose-build-artifact-${service}`, service, "pnpm", [
            "--filter",
            service,
            "build",
          ]),
        ),
        processPlan("compose-build", null, "docker", [...prefix, "build", ...selectedServices]),
      ],
      urls: config.urls,
      parityGates: [],
    };
  }
  if (action === "down") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan(
          "compose-down",
          null,
          "docker",
          serviceSelectionExplicit ? [...prefix, "stop", ...selectedServices] : [...prefix, "down"],
        ),
      ],
      urls: config.urls,
      parityGates: [],
    };
  }
  if (action === "seed") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan("compose-seed", null, "pnpm", [
          "tsx",
          "deploy/compose/scripts/seed.ts",
          "--env-file",
          envFile,
        ]),
      ],
      urls: config.urls,
      parityGates: [],
    };
  }
  if (action === "reset") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan("compose-reset", null, "docker", [...prefix, "down", "--volumes"]),
      ],
      urls: config.urls,
      parityGates: [],
    };
  }
  throw new Error("Unsupported Compose action");
};

// fallow-ignore-next-line complexity
const kubernetesPlan = (
  config: KubernetesModeConfig,
  action: KubernetesAction,
  selectedServices: readonly string[],
  imageTag: string | null,
  surfaces: readonly ChangedSurface[],
): ModePlan => {
  const parityGates = selectParityGates(surfaces);
  const values = ["--values", "charts/tiara-stack/values.yaml"];
  if (action === "validate") {
    return {
      selectedServices,
      plannedProcesses: [helmLintProcess(values), helmRenderProcess(config, values)],
      urls: config.urls,
      parityGates: parityGates.filter(({ id }) => id === "helm-lint" || id === "helm-render"),
    };
  }
  if (action !== "preview") throw new Error("Unsupported Kubernetes action");
  const requiredGates = parityGates.filter(({ status }) => status === "required");
  const beforePreview = requiredGates.filter(({ id }) => id === "compose-evidence");
  const afterPreview = requiredGates.filter(
    ({ id }) => !["compose-evidence", "helm-lint", "helm-render"].includes(id),
  );
  return {
    selectedServices,
    plannedProcesses: [
      ...beforePreview.map(({ id }) => parityProcess(id, config)),
      helmLintProcess(values),
      helmRenderProcess(config, values),
      processPlan(
        "kubernetes-preview",
        null,
        "helm",
        [
          "upgrade",
          "--install",
          config.environment.KUBE_RELEASE,
          "charts/tiara-stack",
          "--namespace",
          config.environment.KUBE_NAMESPACE,
          "--kube-context",
          config.environment.KUBE_CONTEXT,
          "--create-namespace",
          ...values,
          "--values",
          "charts/tiara-stack/values-development.yaml",
          "--set-string",
          `global.appImage.registry=${config.environment.DEV_IMAGE_REGISTRY}`,
          "--set-string",
          `global.appImage.tag=${imageTag ?? ""}`,
          "--wait",
          "--timeout",
          "10m",
        ],
        config.environment,
        false,
      ),
      ...afterPreview.map(({ id }) => parityProcess(id, config)),
    ],
    urls: config.urls,
    parityGates,
  };
};

export function buildModePlan(
  config: FastModeConfig,
  action: FastAction,
  selectedServices: readonly string[],
  imageTag?: string | null,
  serviceSelectionExplicit?: boolean,
): ModePlan;
export function buildModePlan(
  config: ComposeModeConfig,
  action: ComposeAction,
  selectedServices: readonly string[],
  imageTag?: string | null,
  serviceSelectionExplicit?: boolean,
): ModePlan;
export function buildModePlan(
  config: KubernetesModeConfig,
  action: KubernetesAction,
  selectedServices: readonly string[],
  imageTag?: string | null,
  serviceSelectionExplicit?: boolean,
  changedSurfaces?: readonly ChangedSurface[],
): ModePlan;
export function buildModePlan(
  config: ModeConfig,
  action: ModeAction,
  selectedServices: readonly string[],
  imageTag: string | null = null,
  serviceSelectionExplicit = false,
  changedSurfaces: readonly ChangedSurface[] = [],
): ModePlan {
  if (config.mode === "fast") {
    if (action !== "up") throw new Error(`Unsupported Fast action ${action}`);
    return fastPlan(config, selectedServices);
  }
  if (config.mode === "compose") {
    return composePlan(config, action as ComposeAction, selectedServices, serviceSelectionExplicit);
  }
  if (action === "preview" && (imageTag === null || imageTag.trim() === "")) {
    throw new Error("Kubernetes preview requires an image tag");
  }
  return kubernetesPlan(
    config,
    action as KubernetesAction,
    selectedServices,
    imageTag,
    changedSurfaces,
  );
}
