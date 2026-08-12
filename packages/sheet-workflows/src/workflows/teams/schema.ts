import { Schema } from "effect";

const TeamIdentity = Schema.Struct({
  accountId: Schema.String,
  name: Schema.String,
});

const UserTeam = Schema.Struct({
  playerName: Schema.String,
  teamName: Schema.String,
  tags: Schema.Array(Schema.String),
  lead: Schema.Finite,
  backline: Schema.Finite,
  talent: Schema.NullOr(Schema.Finite),
});

export const UserTeamsView = Schema.Struct({
  players: Schema.Array(TeamIdentity),
  teams: Schema.Array(UserTeam),
});
export type UserTeamsView = typeof UserTeamsView.Type;
