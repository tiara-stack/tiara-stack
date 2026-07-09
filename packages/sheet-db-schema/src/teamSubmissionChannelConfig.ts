import { Schema } from "effect";

export const TeamSubmissionWriteMode = Schema.Literals(["upsert"]);
export type TeamSubmissionWriteMode = Schema.Schema.Type<typeof TeamSubmissionWriteMode>;

export const TeamSubmissionRemovedRowStrategy = Schema.Literals(["blank"]);
export type TeamSubmissionRemovedRowStrategy = Schema.Schema.Type<
  typeof TeamSubmissionRemovedRowStrategy
>;
