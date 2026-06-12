import { Context, Option } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import type { SheetAuthOAuthScope } from "../schemas/permissions";

export type PublicSheetAuthOAuthScope = Extract<
  SheetAuthOAuthScope,
  "sheet.read" | "sheet.write" | "sheet.manage" | "workflow.dispatch"
>;

export type SheetRpcScopePolicy =
  | { readonly _tag: "none" }
  | { readonly _tag: "service" }
  | { readonly _tag: "oauth"; readonly scope: PublicSheetAuthOAuthScope };

export const SheetRpcScopePolicyAnnotation =
  Context.Service<SheetRpcScopePolicy>("SheetRpcScopePolicy");

export const SheetRpcScopePolicies = {
  none: { _tag: "none" } as const,
  service: { _tag: "service" } as const,
  oauth: <const Scope extends PublicSheetAuthOAuthScope>(scope: Scope) =>
    ({ _tag: "oauth", scope }) as const,
};

declare const SheetRpcScopePolicyTypeId: unique symbol;

export type WithSheetRpcScopePolicy<Policy extends SheetRpcScopePolicy> = {
  readonly [SheetRpcScopePolicyTypeId]: Policy;
};

export type SheetRpcScopePolicyOf<T> =
  T extends WithSheetRpcScopePolicy<infer Policy> ? Policy : never;

export type SheetRpcOAuthScopeOf<T> =
  SheetRpcScopePolicyOf<T> extends { readonly _tag: "oauth"; readonly scope: infer Scope }
    ? Scope
    : never;

export type SheetRpcCredentialKindOf<T> =
  SheetRpcScopePolicyOf<T> extends { readonly _tag: "service" }
    ? "service"
    : SheetRpcScopePolicyOf<T> extends { readonly _tag: "oauth" }
      ? "oauth"
      : "none";

export type SheetRpcByTag<Group, Tag extends string> = Extract<
  RpcGroup.Rpcs<Group>,
  { readonly _tag: Tag }
>;

export type SheetRpcOAuthScopeForTag<Group, Tag extends string> = SheetRpcOAuthScopeOf<
  SheetRpcByTag<Group, Tag>
>;

type AnnotatableRpc = Rpc.Any & {
  annotate<I, S>(tag: Context.Key<I, S>, value: S): Rpc.Any;
};

export const annotateRpcScopePolicy = <
  const Policy extends SheetRpcScopePolicy,
  R extends AnnotatableRpc,
>(
  rpc: R,
  policy: Policy,
): R & WithSheetRpcScopePolicy<Policy> =>
  rpc.annotate(SheetRpcScopePolicyAnnotation, policy) as R & WithSheetRpcScopePolicy<Policy>;

export const getRpcScopePolicy = (rpc: unknown): SheetRpcScopePolicy | undefined =>
  Rpc.isRpc(rpc)
    ? Option.getOrUndefined(Context.getOption(rpc.annotations, SheetRpcScopePolicyAnnotation))
    : undefined;
