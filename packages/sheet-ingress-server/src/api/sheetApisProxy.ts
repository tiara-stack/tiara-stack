import { Effect, Predicate } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { adaptTableHandlerArgument, invokeTableHandler } from "../httpApiAdapter";
import { ServiceStatusService } from "../services/serviceStatus";
import { SheetApisForwardingClient } from "../services/sheetApisForwardingClient";
import { sheetApisRpcArgsFromHttpArgs } from "../services/sheetApisProxy";
import { normalizeServicesStatusResponse } from "../services/statusResponse";
import type {
  SheetApisEndpointName,
  SheetApisGroupName,
  SheetApisHandlerTable,
  SheetApisProxyHandler,
  SheetApisProxyRequest,
} from "./types";

const forwardSheetApis =
  <GroupName extends SheetApisGroupName, EndpointName extends SheetApisEndpointName<GroupName>>(
    group: GroupName,
    endpoint: EndpointName,
  ): SheetApisProxyHandler<GroupName, EndpointName, never> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetApisProxyRequest<GroupName, EndpointName>;
      const client = yield* SheetApisForwardingClient;
      const handlerTable: SheetApisHandlerTable = client satisfies SheetApisHandlerTable;
      return yield* invokeTableHandler(
        handlerTable[group],
        endpoint,
        adaptTableHandlerArgument(
          handlerTable[group],
          endpoint,
          sheetApisRpcArgsFromHttpArgs(args),
        ),
      );
    }) as ReturnType<SheetApisProxyHandler<GroupName, EndpointName, never>>;

export const authorizedSheetApis =
  <GroupName extends SheetApisGroupName, EndpointName extends SheetApisEndpointName<GroupName>, R>(
    group: GroupName,
    endpoint: EndpointName,
    authorize: (
      args: SheetApisProxyRequest<GroupName, EndpointName>,
    ) => Effect.Effect<void, unknown, R>,
  ): SheetApisProxyHandler<GroupName, EndpointName, R> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetApisProxyRequest<GroupName, EndpointName>;
      yield* authorize(args).pipe(
        Effect.mapError((cause) =>
          Predicate.or(
            Predicate.isTagged("ArgumentError"),
            Predicate.isTagged("Unauthorized"),
          )(cause)
            ? cause
            : makeArgumentError(`Cannot authorize ${group}.${endpoint}`, cause),
        ),
      );
      return yield* forwardSheetApis(group, endpoint)(rawArgs);
    }) as ReturnType<SheetApisProxyHandler<GroupName, EndpointName, R>>;

export const statusGetServices: SheetApisProxyHandler<
  "status",
  "getServices",
  ServiceStatusService
> = () =>
  Effect.gen(function* () {
    const serviceStatusService = yield* ServiceStatusService;
    return yield* serviceStatusService.getServicesStatus();
  }).pipe(Effect.map((response) => normalizeServicesStatusResponse(response))) as ReturnType<
    SheetApisProxyHandler<"status", "getServices", ServiceStatusService>
  >;
