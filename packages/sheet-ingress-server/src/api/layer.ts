import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiSwagger } from "effect/unstable/httpapi";
import { Api } from "sheet-ingress-api/api";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { corsMiddlewareLayer } from "../cors";
import { config } from "../config";
import { healthRoutesLayer } from "../health";
import { withKnownRequestServices } from "../httpApiAdapter";
import {
  SheetApisAnonymousUserFallbackLive,
  SheetApisServiceUserFallbackLive,
  SheetBotServiceAuthorizationLive,
} from "../middlewares/proxyAuthorization";
import { SheetAuthUserResolver } from "../services/authResolver";
import { AuthorizationService, SheetAuthTokenAuthorizationLive } from "../services/authorization";
import { ClientDeliveryForwardingClient } from "../services/clientDeliveryForwardingClient";
import { MessageLookup } from "../services/messageLookup";
import { ServiceStatusService } from "../services/serviceStatus";
import { SheetApisForwardingClient } from "../services/sheetApisForwardingClient";
import { SheetApisRpcTokens } from "../services/sheetApisRpcTokens";
import { SheetBotForwardingClient } from "../services/sheetBotForwardingClient";
import { SheetWorkflowsForwardingClient } from "../services/sheetWorkflowsForwardingClient";
import { botHandlers } from "./handlers/bot";
import { clientDeliveryHandlers } from "./handlers/clientDelivery";
import { coreHandlers } from "./handlers/core";
import { dispatchHandlers } from "./handlers/dispatch";
import { messageHandlers } from "./handlers/messages";
import { sheetHandlers } from "./handlers/sheet";
import { workspaceHandlers } from "./handlers/workspace";
import type { IngressHandlerTable, IngressRequestServices } from "./types";

const SwaggerLayer = Layer.unwrap(
  Effect.map(config.environment, (environment) =>
    environment === "production" ? Layer.empty : HttpApiSwagger.layer(Api),
  ),
);

export const makeApiLayer = () => {
  const ingressHandlerTable = {
    ...coreHandlers,
    ...dispatchHandlers,
    ...workspaceHandlers,
    ...messageHandlers,
    ...sheetHandlers,
    ...clientDeliveryHandlers,
    ...botHandlers,
  } satisfies IngressHandlerTable;

  const ProxyLayers = Layer.mergeAll(
    HttpApiBuilder.group(Api, "calc", ingressHandlerTable.calc),
    HttpApiBuilder.group(Api, "checkin", ingressHandlerTable.checkin),
    HttpApiBuilder.group(Api, "dispatch", ingressHandlerTable.dispatch),
    HttpApiBuilder.group(Api, "discord", ingressHandlerTable.discord),
    HttpApiBuilder.group(Api, "userConfig", ingressHandlerTable.userConfig),
    HttpApiBuilder.group(Api, "status", ingressHandlerTable.status),
    HttpApiBuilder.group(Api, "teamSubmission", ingressHandlerTable.teamSubmission),
    HttpApiBuilder.group(Api, "workspaceConfig", ingressHandlerTable.workspaceConfig),
    HttpApiBuilder.group(Api, "messageCheckin", ingressHandlerTable.messageCheckin),
    HttpApiBuilder.group(Api, "messageRoomOrder", ingressHandlerTable.messageRoomOrder),
    HttpApiBuilder.group(Api, "messageSlot", ingressHandlerTable.messageSlot),
    HttpApiBuilder.group(Api, "monitor", ingressHandlerTable.monitor),
    HttpApiBuilder.group(Api, "permissions", ingressHandlerTable.permissions),
    HttpApiBuilder.group(Api, "player", ingressHandlerTable.player),
    HttpApiBuilder.group(Api, "roomOrder", ingressHandlerTable.roomOrder),
    HttpApiBuilder.group(Api, "schedule", ingressHandlerTable.schedule),
    HttpApiBuilder.group(Api, "screenshot", ingressHandlerTable.screenshot),
    HttpApiBuilder.group(Api, "sheet", ingressHandlerTable.sheet),
    HttpApiBuilder.group(Api, "application", ingressHandlerTable.application),
    HttpApiBuilder.group(Api, "clientDelivery", ingressHandlerTable.clientDelivery),
    HttpApiBuilder.group(Api, "bot", ingressHandlerTable.bot),
    HttpApiBuilder.group(Api, "ingressBot", ingressHandlerTable.ingressBot),
    HttpApiBuilder.group(Api, "cache", ingressHandlerTable.cache),
  );

  const RequestServicesLive = Layer.mergeAll(
    AuthorizationService.layer,
    MessageLookup.layer,
    SheetApisForwardingClient.layer,
    SheetApisRpcTokens.layer,
    SheetWorkflowsForwardingClient.layer,
    SheetBotForwardingClient.layer,
    ClientDeliveryForwardingClient.layer,
    ServiceStatusService.layer,
  );

  return withKnownRequestServices<IngressRequestServices, SheetAuthUser>()(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ProxyLayers),
      Layer.provide(
        SheetBotServiceAuthorizationLive.pipe(Layer.provide(SheetAuthUserResolver.layer)),
      ),
      Layer.provide(SheetApisServiceUserFallbackLive.pipe(Layer.provide(SheetApisRpcTokens.layer))),
      Layer.provide(SheetApisAnonymousUserFallbackLive),
      Layer.provide(SheetAuthTokenAuthorizationLive),
      Layer.merge(SwaggerLayer),
      Layer.merge(healthRoutesLayer),
    ),
  ).pipe(HttpRouter.provideRequest(RequestServicesLive), Layer.provide(corsMiddlewareLayer));
};
