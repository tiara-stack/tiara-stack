import { NodeSdk } from "@effect/opentelemetry";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

export { discordGuildCacheFailures } from "@/metrics/discord";

export const MetricsLive = NodeSdk.layer(() => ({
  resource: { serviceName: "sheet-apis" },
  metricReader: new PrometheusExporter(),
}));
