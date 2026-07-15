import type { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Api } from "sheet-ingress-api/api";
import type { AuthorizationService } from "../services/authorization";
import type { ClientDeliveryForwardingClient } from "../services/clientDeliveryForwardingClient";
import type { MessageLookup } from "../services/messageLookup";
import type { ServiceStatusService } from "../services/serviceStatus";
import type { SheetApisForwardingClient } from "../services/sheetApisForwardingClient";
import type { SheetApisRpcTokens } from "../services/sheetApisRpcTokens";
import type { SheetBotForwardingClient } from "../services/sheetBotForwardingClient";
import type { SheetWorkflowsForwardingClient } from "../services/sheetWorkflowsForwardingClient";

export type SheetIngressGroups = (typeof Api)["groups"][keyof (typeof Api)["groups"]];
export type SheetIngressGroupName = HttpApiGroup.Name<SheetIngressGroups>;
type NamedGroup<GroupName extends SheetIngressGroupName> = HttpApiGroup.WithName<
  SheetIngressGroups,
  GroupName
>;
type NamedGroupEndpoints<GroupName extends SheetIngressGroupName> = HttpApiGroup.Endpoints<
  NamedGroup<GroupName>
>;
type NamedGroupEndpointName<GroupName extends SheetIngressGroupName> = Extract<
  HttpApiEndpoint.Name<NamedGroupEndpoints<GroupName>>,
  string
>;
type CompletedIngressHandlers = HttpApiBuilder.Handlers.ValidateReturn<
  HttpApiBuilder.Handlers<unknown>
>;
export type IngressHandlerTable = {
  readonly [GroupName in SheetIngressGroupName]: (
    handlers: HttpApiBuilder.Handlers.FromGroup<
      HttpApiGroup.WithName<SheetIngressGroups, GroupName>
    >,
  ) => CompletedIngressHandlers;
};
export type SheetApisForwardingClientService = typeof SheetApisForwardingClient.Service;
export type SheetWorkflowsForwardingClientService = typeof SheetWorkflowsForwardingClient.Service;
export type IngressRequestServices =
  | AuthorizationService
  | MessageLookup
  | SheetApisForwardingClient
  | SheetApisRpcTokens
  | SheetWorkflowsForwardingClient
  | SheetBotForwardingClient
  | ClientDeliveryForwardingClient
  | ServiceStatusService;
export type SheetApisGroupName = Extract<
  keyof SheetApisForwardingClientService,
  HttpApiGroup.Name<SheetIngressGroups>
>;
export type SheetApisEndpointName<GroupName extends SheetApisGroupName> =
  NamedGroupEndpointName<GroupName>;
export type SheetApisEndpoint<GroupName extends SheetApisGroupName> =
  NamedGroupEndpoints<GroupName>;
export type SheetApisProxyRequest<
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
> = HttpApiEndpoint.Request<HttpApiEndpoint.WithName<SheetApisEndpoint<GroupName>, EndpointName>>;
type ExtractClientHandler<Service, Key extends PropertyKey> = Key extends keyof Service
  ? Extract<Service[Key], (...args: never[]) => unknown>
  : never;
export type SheetApisClientHandler<
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
> = ExtractClientHandler<SheetApisForwardingClientService[GroupName], EndpointName>;
export type SheetApisHandlerTable = {
  readonly [GroupName in SheetApisGroupName]: {
    readonly [EndpointName in SheetApisEndpointName<GroupName>]: SheetApisClientHandler<
      GroupName,
      EndpointName
    >;
  };
};
export type SheetApisProxyError<
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
> = HttpApiEndpoint.ErrorsWithName<SheetApisEndpoint<GroupName>, EndpointName>;
export type SheetApisProxyHandler<
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
  R,
> = HttpApiEndpoint.HandlerWithName<
  SheetApisEndpoint<GroupName>,
  EndpointName,
  SheetApisProxyError<GroupName, EndpointName>,
  SheetApisForwardingClient | R
>;
export type SheetWorkflowsDispatchEndpoints = NamedGroupEndpoints<"dispatch">;
export type SheetWorkflowsDispatchEndpointName = NamedGroupEndpointName<"dispatch">;
export type SheetWorkflowsDispatchHandlerTable = {
  readonly [EndpointName in SheetWorkflowsDispatchEndpointName]: ExtractClientHandler<
    SheetWorkflowsForwardingClientService["dispatch"],
    EndpointName
  >;
};
export type SheetWorkflowsDispatchRequest<EndpointName extends SheetWorkflowsDispatchEndpointName> =
  HttpApiEndpoint.Request<HttpApiEndpoint.WithName<SheetWorkflowsDispatchEndpoints, EndpointName>>;
export type SheetWorkflowsDispatchError<EndpointName extends SheetWorkflowsDispatchEndpointName> =
  HttpApiEndpoint.ErrorsWithName<SheetWorkflowsDispatchEndpoints, EndpointName>;
export type SheetWorkflowsDispatchHandler<
  EndpointName extends SheetWorkflowsDispatchEndpointName,
  R,
> = HttpApiEndpoint.HandlerWithName<
  SheetWorkflowsDispatchEndpoints,
  EndpointName,
  SheetWorkflowsDispatchError<EndpointName>,
  SheetWorkflowsForwardingClient | R
>;
