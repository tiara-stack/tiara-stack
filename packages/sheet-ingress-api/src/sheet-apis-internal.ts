import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import {
  CalcApi,
  CheckinApi,
  DiscordApi,
  WorkspaceConfigApi,
  HealthApi,
  MessageCheckinApi,
  MessageRoomOrderApi,
  MessageSlotApi,
  MonitorApi,
  PermissionsApi,
  PlayerApi,
  RoomOrderApi,
  ScheduleApi,
  ScreenshotApi,
  SheetApi,
  StatusApi,
  UserConfigApi,
} from "./api-groups";
import { SheetIngressServiceAuthorization } from "./middlewares/sheetIngressServiceAuthorization/tag";

const internal = <
  Group extends {
    readonly middleware: (middleware: typeof SheetIngressServiceAuthorization) => unknown;
  },
>(
  group: Group,
): ReturnType<Group["middleware"]> =>
  group.middleware(SheetIngressServiceAuthorization) as ReturnType<Group["middleware"]>;

export class SheetApisInternalApi extends HttpApi.make("api")
  .add(internal(CalcApi))
  .add(internal(CheckinApi))
  .add(internal(HealthApi))
  .add(internal(WorkspaceConfigApi))
  .add(internal(MessageCheckinApi))
  .add(internal(MessageRoomOrderApi))
  .add(internal(MessageSlotApi))
  .add(internal(PermissionsApi))
  .add(internal(SheetApi))
  .add(internal(MonitorApi))
  .add(internal(PlayerApi))
  .add(internal(RoomOrderApi))
  .add(internal(ScreenshotApi))
  .add(internal(ScheduleApi))
  .add(internal(DiscordApi))
  .add(internal(StatusApi))
  .add(internal(UserConfigApi))
  .annotate(OpenApi.Title, "Sheet APIs Internal") {}
