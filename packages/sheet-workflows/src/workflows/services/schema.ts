import { Schema } from "effect";

export const serviceStatusTargetNames = [
  "sheet-auth",
  "sheet-bot",
  "sheet-workflows",
  "sheet-db-server",
  "sheet-web",
] as const;

const ServiceStatusTargetName = Schema.Literals(serviceStatusTargetNames);

const BoundedPrivateDetail = Schema.String.check(Schema.isMaxLength(512));

const ServiceReadinessDisposition = Schema.Struct({
  service: ServiceStatusTargetName,
  url: Schema.String,
  status: Schema.Literals(["ok", "down"]),
  httpStatus: Schema.NullOr(Schema.Int),
  latencyMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  checkedAt: Schema.DateTimeUtcFromMillis,
  error: Schema.NullOr(BoundedPrivateDetail),
});
export const ServiceReadinessSnapshot = Schema.Struct({
  overallStatus: Schema.Literals(["ok", "degraded"]),
  checkedAt: Schema.DateTimeUtcFromMillis,
  services: Schema.Array(ServiceReadinessDisposition),
});
export type ServiceReadinessSnapshot = typeof ServiceReadinessSnapshot.Type;
