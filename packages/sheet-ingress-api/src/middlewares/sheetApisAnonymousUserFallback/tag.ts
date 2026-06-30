import { HttpApiMiddleware } from "effect/unstable/httpapi";
export class SheetApisAnonymousUserFallback extends HttpApiMiddleware.Service<
  SheetApisAnonymousUserFallback,
  {
    provides: never;
    requires: never;
  }
>()("SheetApisAnonymousUserFallback", {
  requiredForClient: false,
}) {}
