import { Chunk, HashSet, Option, Order } from "effect";

type TeamFields = {
  readonly type: string;
  readonly playerId: Option.Option<string>;
  readonly playerName: Option.Option<string>;
  readonly teamName: Option.Option<string>;
  readonly tags: ReadonlyArray<string>;
  readonly lead: number;
  readonly backline: number;
  readonly talent: Option.Option<number>;
};

export class Team {
  readonly type: string;
  readonly playerId: Option.Option<string>;
  readonly playerName: Option.Option<string>;
  readonly teamName: Option.Option<string>;
  readonly tags: ReadonlyArray<string>;
  readonly lead: number;
  readonly backline: number;
  readonly talent: Option.Option<number>;

  constructor(fields: TeamFields) {
    this.type = fields.type;
    this.playerId = fields.playerId;
    this.playerName = fields.playerName;
    this.teamName = fields.teamName;
    this.tags = fields.tags;
    this.lead = fields.lead;
    this.backline = fields.backline;
    this.talent = fields.talent;
  }
}

export class PlayerTeam {
  readonly type: string;
  readonly playerId: Option.Option<string>;
  readonly playerName: Option.Option<string>;
  readonly teamName: string;
  readonly lead: number;
  readonly backline: number;
  readonly talent: number;
  readonly tags: HashSet.HashSet<string>;

  constructor(fields: {
    readonly type: string;
    readonly playerId: Option.Option<string>;
    readonly playerName: Option.Option<string>;
    readonly teamName: string;
    readonly lead: number;
    readonly backline: number;
    readonly talent: number;
    readonly tags: HashSet.HashSet<string>;
  }) {
    this.type = fields.type;
    this.playerId = fields.playerId;
    this.playerName = fields.playerName;
    this.teamName = fields.teamName;
    this.lead = fields.lead;
    this.backline = fields.backline;
    this.talent = fields.talent;
    this.tags = fields.tags;
  }

  static getEffectValue = (playerTeam: PlayerTeam): number =>
    playerTeam.lead + (playerTeam.backline - playerTeam.lead) / 5;

  static byTalent = Order.mapInput(Order.Number, ({ talent }: PlayerTeam) => talent);

  static addTags(tags: HashSet.HashSet<string>) {
    return (playerTeam: PlayerTeam) =>
      new PlayerTeam({
        type: playerTeam.type,
        playerId: playerTeam.playerId,
        playerName: playerTeam.playerName,
        teamName: playerTeam.teamName,
        lead: playerTeam.lead,
        backline: playerTeam.backline,
        talent: playerTeam.talent,
        tags: HashSet.union(playerTeam.tags, tags),
      });
  }

  static fromTeam(cc: boolean, team: Team): Option.Option<PlayerTeam> {
    const talent = cc || Option.isSome(team.talent) ? team.talent : Option.some(0);
    if (Option.isNone(team.teamName) || Option.isNone(talent)) return Option.none();
    return Option.some(
      new PlayerTeam({
        type: team.type,
        playerId: team.playerId,
        playerName: team.playerName,
        teamName: team.teamName.value,
        lead: team.lead,
        backline: team.backline,
        talent: talent.value,
        tags: HashSet.fromIterable(team.tags.filter(Boolean)),
      }),
    );
  }
}

export class Room {
  readonly enced: boolean;
  readonly tiererEnced: boolean;
  readonly healed: number;
  readonly talent: number;
  readonly effectValue: number;
  readonly teams: Chunk.Chunk<PlayerTeam>;

  constructor(fields: {
    readonly enced: boolean;
    readonly tiererEnced: boolean;
    readonly healed: number;
    readonly talent: number;
    readonly effectValue: number;
    readonly teams: Chunk.Chunk<PlayerTeam>;
  }) {
    this.enced = fields.enced;
    this.tiererEnced = fields.tiererEnced;
    this.healed = fields.healed;
    this.talent = fields.talent;
    this.effectValue = fields.effectValue;
    this.teams = fields.teams;
  }

  static byTalent = Order.mapInput(Order.Number, ({ talent }: Room) => talent);
  static byEffectValue = Order.mapInput(Order.Number, ({ effectValue }: Room) => effectValue);
  static Order = Order.combine(Room.byTalent, Order.flip(Room.byEffectValue));
  static avgTalent = (room: Room): number => room.talent / room.teams.length;
  static avgEffectValue = (room: Room): number => room.effectValue / room.teams.length;
}
