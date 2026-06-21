import { Option } from "effect";
import {
  PartialNamePlayer,
  Player,
  PopulatedSchedule,
  PopulatedSchedulePlayer,
} from "sheet-ingress-api/schemas/sheet";

export const makeResolvedFill = (id: string, name: string) =>
  new PopulatedSchedulePlayer({
    player: new Player({
      index: 0,
      id,
      name,
    }),
    enc: false,
  });

export const makePartialFill = (name: string) =>
  new PopulatedSchedulePlayer({
    player: new PartialNamePlayer({ name }),
    enc: false,
  });

export const makeSchedule = (fills: ReadonlyArray<PopulatedSchedulePlayer>) =>
  new PopulatedSchedule({
    channel: "room-1",
    day: 1,
    visible: true,
    hour: Option.some(1),
    hourWindow: Option.none(),
    fills: [0, 1, 2, 3, 4].map((index) =>
      index < fills.length ? Option.some(fills[index]!) : Option.none(),
    ),
    overfills: [],
    standbys: [],
    runners: [],
    monitor: Option.none(),
  });
