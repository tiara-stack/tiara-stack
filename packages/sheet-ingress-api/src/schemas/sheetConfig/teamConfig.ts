import { Schema } from "effect";

export class TeamTagsConstantsConfig extends Schema.TaggedClass<TeamTagsConstantsConfig>()(
  "TeamTagsConstantsConfig",
  {
    tags: Schema.Array(Schema.String),
  },
) {}

export class TeamTagsRangesConfig extends Schema.TaggedClass<TeamTagsRangesConfig>()(
  "TeamTagsRangesConfig",
  {
    tagsRange: Schema.String,
  },
) {}

export class TeamIsvSplitConfig extends Schema.TaggedClass<TeamIsvSplitConfig>()(
  "TeamIsvSplitConfig",
  {
    leadRange: Schema.String,
    backlineRange: Schema.String,
    talentRange: Schema.String,
  },
) {}

export class TeamIsvCombinedConfig extends Schema.TaggedClass<TeamIsvCombinedConfig>()(
  "TeamIsvCombinedConfig",
  {
    isvRange: Schema.String,
  },
) {}

export class TeamConfig extends Schema.TaggedClass<TeamConfig>()("TeamConfig", {
  name: Schema.OptionFromNullOr(Schema.String),
  sheet: Schema.OptionFromNullOr(Schema.String),
  playerNameRange: Schema.OptionFromNullOr(Schema.String),
  teamNameRange: Schema.OptionFromNullOr(Schema.String),
  isvConfig: Schema.OptionFromNullOr(Schema.Union([TeamIsvSplitConfig, TeamIsvCombinedConfig])),
  tagsConfig: Schema.OptionFromNullOr(
    Schema.Union([TeamTagsConstantsConfig, TeamTagsRangesConfig]),
  ),
  oshiRange: Schema.OptionFromNullOr(Schema.String),
}) {}
