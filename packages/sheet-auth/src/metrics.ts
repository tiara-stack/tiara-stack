import { NodeSdk } from "@effect/opentelemetry";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

export const MetricsLive = NodeSdk.layer(() => ({
  resource: { serviceName: "sheet-auth" },
  metricReader: new PrometheusExporter({ port: Number(process.env.PROMETHEUS_PORT ?? 9464) }),
}));
