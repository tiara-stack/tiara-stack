import { Schema } from "effect";

const AuditTimestamp = Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis);

export const AuditTimestampFields = {
  createdAt: AuditTimestamp,
  updatedAt: AuditTimestamp,
  deletedAt: AuditTimestamp,
} as const;
