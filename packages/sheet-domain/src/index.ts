import { Schema } from "effect";

export * from "./configuration";

export const TeamSubmissionStatus = Schema.Literals([
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
