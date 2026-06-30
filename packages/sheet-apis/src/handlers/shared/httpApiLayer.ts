import { Effect } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { SheetApisInternalApi } from "sheet-ingress-api/sheet-apis-internal";

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
> = (
  request: HttpApiEndpoint.Request<
    HttpApiEndpoint.WithName<SheetApisInternalEndpoint<GroupName>, EndpointName>
  >,
) => Effect.Effect<unknown, unknown, unknown>;

export type HandlerMap<GroupName extends SheetApisInternalGroupName> = Partial<{
  [EndpointName in SheetApisInternalEndpointName<GroupName> as
    | EndpointName
    | `${GroupName}.${EndpointName}`]: SheetApisInternalEndpointHandler<GroupName, EndpointName>;
}>;

type MutableHandlers = {
  readonly handle: (name: never, handler: never) => MutableHandlers;
};

const endpointNameFromKey = (groupName: string, key: string) =>
  key.startsWith(`${groupName}.`) ? key.slice(groupName.length + 1) : key;

export const sheetApisGroupLayer = <const GroupName extends SheetApisInternalGroupName, E, R>(
  groupName: GroupName,
  build: Effect.Effect<HandlerMap<GroupName>, E, R> | HandlerMap<GroupName>,
) =>
  HttpApiBuilder.group(SheetApisInternalApi, groupName, ((handlers: unknown) =>
    Effect.gen(function* () {
      const handlerMap = Effect.isEffect(build) ? yield* build : build;
      let current = handlers as unknown as MutableHandlers;

      for (const [key, handler] of Object.entries(handlerMap)) {
        current = current.handle(endpointNameFromKey(groupName, key) as never, handler as never);
      }

      return current as never;
    })) as never);
