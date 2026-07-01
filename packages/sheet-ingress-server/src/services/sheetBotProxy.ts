import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Api } from "sheet-ingress-api/api";
import { SheetBotForwardingClient } from "./sheetBotForwardingClient";

type SheetBotGroups = (typeof Api)["groups"][keyof (typeof Api)["groups"]];
type SheetBotGroupName = Extract<
  HttpApiGroup.Name<SheetBotGroups>,
  "application" | "bot" | "cache"
>;
type SheetBotGroup<GroupName extends SheetBotGroupName> = HttpApiGroup.WithName<
  SheetBotGroups,
  GroupName
>;
type SheetBotEndpointName<GroupName extends SheetBotGroupName> = Extract<
  HttpApiEndpoint.Name<HttpApiGroup.Endpoints<SheetBotGroup<GroupName>>>,
  string
>;
export type SheetBotProxyHandler<
  GroupName extends SheetBotGroupName,
  EndpointName extends SheetBotEndpointName<GroupName>,
> = HttpApiEndpoint.HandlerWithName<
  HttpApiGroup.Endpoints<SheetBotGroup<GroupName>>,
  EndpointName,
  never,
  SheetBotForwardingClient
>;
type SheetBotEndpointClient = (args: unknown) => Effect.Effect<unknown, unknown, never>;

const getSheetBotEndpoint = Effect.fnUntraced(function* (
  group: SheetBotGroupName,
  endpoint: string,
) {
  const client = yield* SheetBotForwardingClient;
  const groupClient = (client as unknown as Record<string, Record<string, SheetBotEndpointClient>>)[
    group
  ];
  const endpointClient = groupClient?.[endpoint];
  if (typeof endpointClient !== "function") {
    return yield* Effect.die(new Error(`Unknown sheet-bot proxy target: ${group}.${endpoint}`));
  }

  return endpointClient;
});

export const clientArgsFrom = (args: Record<string, unknown>) => {
  const { request: _request, ...clientArgs } = args;
  return Object.keys(clientArgs).length === 0 ? undefined : clientArgs;
};

export const forwardSheetBot =
  <GroupName extends SheetBotGroupName, EndpointName extends SheetBotEndpointName<GroupName>>(
    group: GroupName,
    endpoint: EndpointName,
  ): SheetBotProxyHandler<GroupName, EndpointName> =>
  (args) =>
    Effect.gen(function* () {
      const requestArgs = args as {
        readonly request: HttpServerRequest.HttpServerRequest;
      } & Record<string, unknown>;
      const endpointClient = yield* getSheetBotEndpoint(group, endpoint);

      return yield* endpointClient(clientArgsFrom(requestArgs));
    }) as ReturnType<SheetBotProxyHandler<GroupName, EndpointName>>;

export const forwardSheetBotPayload =
  <GroupName extends SheetBotGroupName, EndpointName extends SheetBotEndpointName<GroupName>>(
    group: GroupName,
    endpoint: EndpointName,
  ): SheetBotProxyHandler<GroupName, EndpointName> =>
  (args) =>
    Effect.gen(function* () {
      const requestArgs = args as {
        readonly payload: unknown;
      };
      const endpointClient = yield* getSheetBotEndpoint(group, endpoint);

      return yield* endpointClient(requestArgs.payload);
    }) as ReturnType<SheetBotProxyHandler<GroupName, EndpointName>>;
