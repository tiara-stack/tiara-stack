import { Schema } from "effect";

export const TeamSubmissionStatus = Schema.Literals([
  "registered",
  "updated",
  "empty",
  "failed",
  "confirmed",
  "rejected",
  "rollbackFailed",
]);
export type TeamSubmissionStatus = Schema.Schema.Type<typeof TeamSubmissionStatus>;
