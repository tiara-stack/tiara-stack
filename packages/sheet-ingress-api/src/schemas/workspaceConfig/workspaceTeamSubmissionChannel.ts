import { Schema } from "effect";

export const TeamSubmissionWriteMode = Schema.Literals(["upsert"]);
export type TeamSubmissionWriteMode = Schema.Schema.Type<typeof TeamSubmissionWriteMode>;

export const TeamSubmissionRemovedRowStrategy = Schema.Literals(["blank"]);
export type TeamSubmissionRemovedRowStrategy = Schema.Schema.Type<
  typeof TeamSubmissionRemovedRowStrategy
>;

export class WorkspaceTeamSubmissionChannel extends Schema.TaggedClass<WorkspaceTeamSubmissionChannel>()(
  "WorkspaceTeamSubmissionChannel",
  {
    workspaceId: Schema.String,
    conversationId: Schema.String,
    destinationTeamConfigName: Schema.OptionFromNullOr(Schema.String),
    writeMode: TeamSubmissionWriteMode,
    removedRowStrategy: TeamSubmissionRemovedRowStrategy,
    requireValidOshi: Schema.Boolean,
    createdAt: Schema.DateTimeUtcFromMillis,
    updatedAt: Schema.DateTimeUtcFromMillis,
    deletedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  },
) {}
