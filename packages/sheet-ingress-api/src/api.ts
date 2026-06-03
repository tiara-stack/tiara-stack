import { HttpApi, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { ApplicationApi, BotApi, CacheApi } from "dfx-discord-utils/discord/api";
import { SheetBotServiceAuthorization } from "./middlewares/sheetBotServiceAuthorization/tag";
import {
  CalcApi,
  CheckinApi,
  DispatchApi,
  DiscordApi as SheetApisDiscordApi,
  GuildConfigApi,
  IngressBotApi,
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
} from "./api-groups";
import { SheetApisApi } from "./sheet-apis";
import { SheetWorkflowsApi } from "./sheet-workflows";

const withIngressApiAnnotations = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
): HttpApi.HttpApi<Id, Groups> =>
  api
    .annotate(OpenApi.Title, "Sheet Ingress API")
    .annotate(
      OpenApi.Description,
      "Ingress API for sheet APIs and sheet bot HTTP routes",
    ) as HttpApi.HttpApi<Id, Groups>;

class SheetIngressSheetApisApi extends HttpApi.make("api")
  .add(CalcApi)
  .add(CheckinApi)
  .add(DispatchApi)
  .add(GuildConfigApi)
  .add(MessageCheckinApi)
  .add(MessageRoomOrderApi)
  .add(MessageSlotApi)
  .add(PermissionsApi)
  .add(SheetApi)
  .add(MonitorApi)
  .add(PlayerApi)
  .add(RoomOrderApi)
  .add(ScreenshotApi)
  .add(ScheduleApi)
  .add(SheetApisDiscordApi)
  .add(StatusApi)
  .annotate(OpenApi.Title, "Sheet APIs") {}

class SheetIngressDiscordApiBase extends HttpApi.make("discord")
  .add(ApplicationApi.middleware(SheetBotServiceAuthorization))
  .add(BotApi.middleware(SheetBotServiceAuthorization))
  .add(CacheApi.middleware(SheetBotServiceAuthorization))
  .add(IngressBotApi.middleware(SheetBotServiceAuthorization))
  .annotate(OpenApi.Title, "Discord API")
  .annotate(
    OpenApi.Description,
    "HTTP API for Discord application metadata, bot actions, and cache lookups",
  ) {}

// Effect's fluent HttpApi builder loses the concrete group union after annotate.
// Keep annotations in this helper so the addHttpApi chain remains the source of truth.
const ApiBase = withIngressApiAnnotations(
  HttpApi.make("sheet-ingress")
    .addHttpApi(SheetIngressSheetApisApi)
    .addHttpApi(SheetIngressDiscordApiBase),
);

export class Api extends ApiBase {}

export { SheetApisApi };
export { SheetWorkflowsApi };
export { SheetIngressDiscordApiBase as SheetIngressDiscordApi };
