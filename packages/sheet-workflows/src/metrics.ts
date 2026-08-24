import { Metric } from "effect";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

export const sheetWorkflowsHttpEnqueues = Metric.counter("sheet_workflows_http_enqueues_total", {
  description: "Workflow HTTP enqueue outcomes by contract and result",
  incremental: true,
});

export const sheetWorkflowsRolloutGateEvaluations = Metric.counter(
  "sheet_workflows_rollout_gate_evaluations_total",
  {
    description: "Rollout Gate evaluations by selected execution path and match result",
    incremental: true,
  },
);

export const sheetWorkflowsRolloutGateChanges = Metric.counter(
  "sheet_workflows_rollout_gate_changes_total",
  {
    description: "Rollout Gate control changes by selected execution path",
    incremental: true,
  },
);

export const MetricsLive = NodeSdk.layer(() => ({
  resource: { serviceName: "sheet-workflows" },
  metricReader: new PrometheusExporter(),
}));
