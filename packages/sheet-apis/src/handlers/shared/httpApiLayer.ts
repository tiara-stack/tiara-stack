import { Effect } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { SheetApisInternalApi } from "sheet-ingress-api/internal";

type SheetApisInternalGroup = (typeof SheetApisInternalApi)["groups"][string];
type SheetApisInternalGroupName = HttpApiGroup.Name<SheetApisInternalGroup>;
type SheetApisInternalGroupFor<Name extends SheetApisInternalGroupName> = HttpApiGroup.WithName<
  SheetApisInternalGroup,
  Name
>;
type SheetApisInternalEndpoint<Name extends SheetApisInternalGroupName> = HttpApiGroup.Endpoints<
  SheetApisInternalGroupFor<Name>
>;
type SheetApisInternalEndpointName<Name extends SheetApisInternalGroupName> = HttpApiEndpoint.Name<
  SheetApisInternalEndpoint<Name>
>;
type SheetApisInternalEndpointHandler<
  GroupName extends SheetApisInternalGroupName,
  EndpointName extends SheetApisInternalEndpointName<GroupName>,
> = HttpApiEndpoint.HandlerWithName<
  SheetApisInternalEndpoint<GroupName>,
  EndpointName,
  unknown,
  unknown
>;

export type HandlerMap<GroupName extends SheetApisInternalGroupName> = {
  [EndpointName in SheetApisInternalEndpointName<GroupName> as `${GroupName}.${EndpointName}`]: SheetApisInternalEndpointHandler<
    GroupName,
    EndpointName
  >;
};

type SheetApisHandlers<GroupName extends SheetApisInternalGroupName> =
  HttpApiBuilder.Handlers.FromGroup<SheetApisInternalGroupFor<GroupName>>;

type HandlerMapEntry<GroupName extends SheetApisInternalGroupName> = {
  [EndpointName in SheetApisInternalEndpointName<GroupName>]: readonly [
    `${GroupName}.${EndpointName}`,
    SheetApisInternalEndpointHandler<GroupName, EndpointName>,
  ];
}[SheetApisInternalEndpointName<GroupName>];

type DynamicSheetApisHandlers<GroupName extends SheetApisInternalGroupName> = {
  readonly handle: (
    name: SheetApisInternalEndpointName<GroupName>,
    handler: unknown,
  ) => SheetApisHandlers<GroupName>;
};

const handlerMapEntries = <GroupName extends SheetApisInternalGroupName>(
  handlerMap: HandlerMap<GroupName>,
) => Object.entries(handlerMap) as Array<HandlerMapEntry<GroupName>>;

const endpointNameFromKey = <const GroupName extends SheetApisInternalGroupName>(
  groupName: GroupName,
  key: `${GroupName}.${SheetApisInternalEndpointName<GroupName>}`,
): SheetApisInternalEndpointName<GroupName> =>
  key.slice(groupName.length + 1) as SheetApisInternalEndpointName<GroupName>;

const handleEndpoint = <const GroupName extends SheetApisInternalGroupName>(
  handlers: SheetApisHandlers<GroupName>,
  groupName: GroupName,
  [key, handler]: HandlerMapEntry<GroupName>,
): SheetApisHandlers<GroupName> => {
  const dynamicHandlers = handlers as unknown as DynamicSheetApisHandlers<GroupName>;
  return dynamicHandlers.handle(endpointNameFromKey(groupName, key), handler);
};

const completedHandlers = <const GroupName extends SheetApisInternalGroupName>(
  handlers: SheetApisHandlers<GroupName>,
) => handlers as unknown as HttpApiBuilder.Handlers<never, never>;

const resolveHandlerMap = <Handlers, E, R>(
  build: Effect.Effect<Handlers, E, R> | Handlers,
): Effect.Effect<Handlers, E, R> =>
  Effect.isEffect(build) ? (build as Effect.Effect<Handlers, E, R>) : Effect.succeed(build);

export const sheetApisGroupLayer = <
  const GroupName extends SheetApisInternalGroupName,
  const Handlers extends HandlerMap<GroupName>,
  E = never,
  R = never,
>(
  groupName: GroupName,
  build: Effect.Effect<Handlers, E, R> | Handlers,
) =>
  HttpApiBuilder.group(SheetApisInternalApi, groupName, (handlers) =>
    Effect.gen(function* () {
      const handlerMap = yield* resolveHandlerMap(build);
      let current = handlers;

      for (const entry of handlerMapEntries(handlerMap as HandlerMap<GroupName>)) {
        current = handleEndpoint(current, groupName, entry);
      }

      return completedHandlers(current);
    }),
  );
