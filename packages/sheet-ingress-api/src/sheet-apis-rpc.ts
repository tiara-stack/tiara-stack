import { Schema } from "effect";
import { SheetApisApi } from "./sheet-apis";

export * from "./handlers/dispatch/schema";
export { ServiceStatus, ServicesStatusResponse } from "./handlers/status/schema";

export const MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE =
  "Cannot get message room order, the message might not be registered";

type RequestDescriptor = {
  readonly _tag: string;
  readonly successSchema?: Schema.Top | undefined;
  readonly errorSchema?: Schema.Top | undefined;
  readonly errorSchemas: ReadonlySet<Schema.Top>;
};

const firstSchema = (schemas: ReadonlySet<Schema.Top>): Schema.Top | undefined =>
  schemas.values().next().value;

export const SheetApisRpcs = {
  requests: new Map<string, RequestDescriptor>(
    Object.values(SheetApisApi.groups).flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) => {
        const tag = `${group.identifier}.${endpoint.name}`;
        return [
          tag,
          {
            _tag: tag,
            successSchema: firstSchema(endpoint.success),
            errorSchema: firstSchema(endpoint.error),
            errorSchemas: endpoint.error,
          },
        ] as const;
      }),
    ),
  ),
};
