import { Schema } from "effect";
import { changedSurfaces } from "./types";
import type { ParityGate, ChangedSurface } from "./types";

export { changedSurfaces };

export const ChangedSurfaceSchema = Schema.Literals(changedSurfaces);

export const isChangedSurface = (value: string): value is ChangedSurface =>
  Schema.is(ChangedSurfaceSchema)(value);

const surfaceSet = (surfaces: readonly ChangedSurface[]) => new Set(surfaces);
const includesAny = (surfaces: ReadonlySet<ChangedSurface>, values: readonly ChangedSurface[]) =>
  values.some((surface) => surfaces.has(surface));

const gate = (id: ParityGate["id"], required: boolean, reason: string): ParityGate => ({
  id,
  status: required ? "required" : "not-affected",
  reason,
});

export const selectParityGates = (surfaces: readonly ChangedSurface[]): readonly ParityGate[] => {
  const changed = surfaceSet(surfaces);
  const contractCrossing = includesAny(changed, [
    "http",
    "backend-runtime",
    "packaging",
    "environment-contract",
    "secret-contract",
    "database-schema",
    "zero-schema",
    "authentication",
    "workflow-api",
    "workflow-storage",
    "workflow-actions",
    "workflow-runner",
    "cross-service",
    "persistence",
    "discord",
    "google-sheets",
  ]);
  const api = includesAny(changed, ["http", "authentication", "workflow-api"]);
  const workflow = includesAny(changed, [
    "workflow-storage",
    "workflow-actions",
    "workflow-runner",
  ]);
  const browser = includesAny(changed, [
    "browser-runner",
    "chromium",
    "screenshot",
    "browser-credentials",
  ]);
  const invariant = includesAny(changed, [
    "helm",
    "ingress",
    "network-policy",
    "secret-contract",
    "persistence",
  ]);

  return [
    gate(
      "compose-evidence",
      contractCrossing,
      contractCrossing
        ? "Contract-crossing changes require Compose evidence before preview promotion."
        : "No backend, packaging, contract, state, or external-integration surface changed.",
    ),
    gate("api-evidence", true, "Every Kubernetes preview requires API-level evidence."),
    gate("helm-lint", true, "Every Kubernetes preview requires strict Helm lint evidence."),
    gate("helm-render", true, "Every Kubernetes preview requires Helm render evidence."),
    gate("workload-readiness", true, "Every Kubernetes preview requires rollout readiness."),
    gate(
      "api-smoke",
      api,
      api
        ? "HTTP, authentication, or Workflow API changes require API smoke."
        : "No HTTP, authentication, or Workflow API surface changed.",
    ),
    gate(
      "ordinary-runner-smoke",
      api,
      api
        ? "HTTP, authentication, or Workflow API changes require ordinary-runner smoke."
        : "No HTTP, authentication, or Workflow API surface changed.",
    ),
    gate(
      "workflow-contract-smoke",
      workflow,
      workflow
        ? "Workflow storage, actions, or runner changes require terminal workflow contract smoke."
        : "No workflow storage, action, or runner surface changed.",
    ),
    gate(
      "browser-runner-smoke",
      browser,
      browser
        ? "Browser-runner, Chromium, screenshot, or browser-credential changes require controlled browser smoke."
        : "No browser-runner, Chromium, screenshot, or browser-credential surface changed.",
    ),
    gate(
      "kubernetes-invariants",
      invariant,
      invariant
        ? "Helm, ingress, network policy, secret wiring, or persistence changes require Kubernetes invariants."
        : "No Helm, ingress, network-policy, secret-wiring, or persistence surface changed.",
    ),
    gate(
      "discord-development-check",
      changed.has("discord"),
      changed.has("discord")
        ? "Discord changes require an explicit development-only check against dedicated resources."
        : "No Discord surface changed.",
    ),
    gate(
      "google-sheets-development-check",
      changed.has("google-sheets"),
      changed.has("google-sheets")
        ? "Google Sheets changes require an explicit development-only check against dedicated resources."
        : "No Google Sheets surface changed.",
    ),
  ];
};
