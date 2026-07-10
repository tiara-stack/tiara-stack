import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class WorkspaceMonitorRole extends Schema.TaggedClass<WorkspaceMonitorRole>()(
  "WorkspaceMonitorRole",
  {
    workspaceId: Schema.String,
    roleId: Schema.String,
    ...AuditTimestampFields,
  },
) {}
