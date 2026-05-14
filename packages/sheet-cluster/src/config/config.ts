import { Config, Schema } from "effect";

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const config = {
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  podNamespace: Config.string("POD_NAMESPACE"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetIngressKubernetesAudience: Config.string("SHEET_INGRESS_KUBERNETES_AUDIENCE").pipe(
    Config.withDefault("sheet-cluster"),
  ),
  postgresUrl: Config.schema(Schema.Redacted(Schema.String), "POSTGRES_URL"),
  clusterRunnerHost: Config.string("CLUSTER_RUNNER_HOST"),
  clusterRunnerPort: Config.port("CLUSTER_RUNNER_PORT").pipe(Config.withDefault(34431)),
  clusterRunnerListenHost: Config.string("CLUSTER_RUNNER_LISTEN_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  clusterRunnerListenPort: Config.port("CLUSTER_RUNNER_LISTEN_PORT").pipe(
    Config.withDefault(34431),
  ),
  // Tune this for large auto-check-in fleets to bound concurrent workflow enqueues.
  autoCheckinConcurrency: Config.schema(positiveInt, "AUTO_CHECKIN_CONCURRENCY").pipe(
    Config.withDefault(50),
  ),
};
