import { Schema } from "effect";

export * from "./configuration";
export * from "./configurationFile";
export * from "./scheduleTime";

export const TeamSubmissionStatus = Schema.Literals([
  "pending",
  "registered",
  "updated",
  "empty",
  "failed",
  "applying",
  "reverting",
  "confirmed",
  "rejected",
  "rollbackFailed",
]);
export type TeamSubmissionStatus = Schema.Schema.Type<typeof TeamSubmissionStatus>;
