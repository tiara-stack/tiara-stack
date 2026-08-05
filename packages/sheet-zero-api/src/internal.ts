import { ZeroFunctionReference } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";

/** Trusted service-to-service functions, omitted from public client catalogs. */
export const service: ZeroFunctionReference.References<typeof SheetZeroApi, "service"> =
  ZeroFunctionReference.makeReferences(SheetZeroApi, ["service"]);

/** Runtime-only functions. Never expose this catalog to an application client. */
export const internal: ZeroFunctionReference.References<typeof SheetZeroApi, "internal"> =
  ZeroFunctionReference.makeReferences(SheetZeroApi, ["internal"]);
