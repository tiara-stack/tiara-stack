import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

export const TracesLive = NodeSdk.layer(() => ({
  resource: { serviceName: "sheet-workflows" },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
}));
