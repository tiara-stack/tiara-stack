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
} from "./types";

export interface ModePlan {
  readonly selectedServices: readonly string[];
  readonly plannedProcesses: readonly PlannedProcess[];
  readonly urls: ModeConfig["urls"];
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

const composePrefix = (config: ComposeModeConfig) =>
  config.envFile === null ? ["compose"] : ["compose", "--env-file", config.envFile];

const fastPlan = (config: FastModeConfig, selectedServices: readonly string[]): ModePlan => ({
  selectedServices,
  plannedProcesses: [
    processPlan(
      "sheet-web",
      "sheet-web",
      "vp",
      ["dev", "--port", String(config.ports["sheet-web"])],
      config.environment,
      true,
    ),
  ],
  urls: config.urls,
});

// fallow-ignore-next-line complexity
const composePlan = (
  config: ComposeModeConfig,
  action: ComposeAction,
  selectedServices: readonly string[],
  serviceSelectionExplicit: boolean,
): ModePlan => {
  const envFile = config.envFile ?? "deploy/compose/.env";
  const prefix =
    envFile === "deploy/compose/.env" ? composePrefix(config) : ["compose", "--env-file", envFile];
  if (action === "up") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan("compose-dependencies", null, "docker", [
          ...prefix,
          "up",
          "-d",
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
          [...prefix, "up", ...selectedServices],
          {},
          true,
        ),
      ],
      urls: config.urls,
    };
  }
  if (action === "build") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan("compose-build", null, "docker", [...prefix, "build", ...selectedServices]),
      ],
      urls: config.urls,
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
    };
  }
  if (action === "reset") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan("compose-reset", null, "docker", [...prefix, "down", "--volumes"]),
      ],
      urls: config.urls,
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
): ModePlan => {
  const values = ["--values", "charts/tiara-stack/values.yaml"];
  if (action === "validate") {
    return {
      selectedServices,
      plannedProcesses: [
        processPlan(
          "helm-lint",
          null,
          "helm",
          ["lint", "--strict", "charts/tiara-stack", ...values],
          {},
          false,
          true,
        ),
        processPlan(
          "helm-render",
          null,
          "helm",
          [
            "template",
            config.environment.KUBE_RELEASE,
            "charts/tiara-stack",
            ...values,
            "--values",
            "charts/tiara-stack/values-development.yaml",
          ],
          {},
          false,
          true,
        ),
      ],
      urls: config.urls,
    };
  }
  if (action !== "preview") throw new Error("Unsupported Kubernetes action");
  return {
    selectedServices,
    plannedProcesses: [
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
        {},
        false,
      ),
    ],
    urls: config.urls,
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
): ModePlan;
export function buildModePlan(
  config: ModeConfig,
  action: ModeAction,
  selectedServices: readonly string[],
  imageTag: string | null = null,
  serviceSelectionExplicit = false,
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
  return kubernetesPlan(config, action as KubernetesAction, selectedServices, imageTag);
}
