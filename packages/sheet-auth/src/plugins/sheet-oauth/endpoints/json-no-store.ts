import type { SheetOAuthEndpointContext } from "../types";

const NoStoreHeaders = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export const jsonNoStore = <Body>(ctx: SheetOAuthEndpointContext, body: Body) =>
  ctx.json(body, {
    headers: NoStoreHeaders,
  });
