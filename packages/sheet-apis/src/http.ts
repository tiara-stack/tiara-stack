import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Layer } from "effect";
import { createServer } from "http";
import { SheetApisRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { calcLayer } from "./handlers/calc";
import { checkinLayer } from "./handlers/checkin";
import { discordLayer } from "./handlers/discord";
import { workspaceConfigLayer } from "./handlers/workspaceConfig";
import { healthLayer } from "./handlers/health";
import { messageCheckinLayer } from "./handlers/messageCheckin";
import { messageRoomOrderLayer } from "./handlers/messageRoomOrder";
import { messageSlotLayer } from "./handlers/messageSlot";
import { monitorLayer } from "./handlers/monitor";
import { SheetAuthTokenAuthorizationLive } from "./middlewares/sheetAuthTokenAuthorization/live";
import { permissionsLayer } from "./handlers/permissions";
import { playerLayer } from "./handlers/player";
import { roomOrderLayer } from "./handlers/roomOrder";
import { scheduleLayer } from "./handlers/schedule";
import { screenshotLayer } from "./handlers/screenshot";
import { sheetLayer } from "./handlers/sheet";
import { statusLayer } from "./handlers/status";
import { discordLayer as discordServiceLayer } from "./services/discord";

const rpcHandlersLayer = Layer.mergeAll(
  calcLayer,
  checkinLayer,
  healthLayer,
  workspaceConfigLayer,
  messageCheckinLayer,
  messageRoomOrderLayer,
  messageSlotLayer,
  permissionsLayer,
  sheetLayer,
  monitorLayer,
  playerLayer,
  roomOrderLayer,
  screenshotLayer,
  scheduleLayer,
  discordLayer,
  statusLayer,
);

const rpcRoutesLayer = RpcServer.layerHttp({
  group: SheetApisRpcs,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(rpcHandlersLayer),
  Layer.provide(SheetAuthTokenAuthorizationLive),
  Layer.provide(RpcSerialization.layerJson),
  Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
  Layer.merge(HttpRouter.add("GET", "/ready", HttpServerResponse.empty({ status: 200 }))),
  Layer.provideMerge(HttpRouter.layer),
);

export const httpLayer = HttpRouter.serve(rpcRoutesLayer).pipe(
  Layer.provide(discordServiceLayer),
  Layer.provide(NodeFileSystem.layer),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);
