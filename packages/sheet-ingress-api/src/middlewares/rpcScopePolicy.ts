import { Context, Option, Predicate } from "effect";
import { HttpApiEndpoint } from "effect/unstable/httpapi";
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

export const SheetScopePolicyAnnotation = SheetRpcScopePolicyAnnotation;
export const SheetScopePolicies = SheetRpcScopePolicies;
export type SheetScopePolicy = SheetRpcScopePolicy;

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

export type SheetRpcByTag<Group, Tag extends string> = Group extends {
  readonly requests: ReadonlyMap<string, infer Request>;
}
  ? Extract<Request, { readonly _tag: Tag }>
  : never;

export type SheetRpcOAuthScopeForTag<Group, Tag extends string> = SheetRpcOAuthScopeOf<
  SheetRpcByTag<Group, Tag>
>;

type AnnotatableEndpoint = HttpApiEndpoint.Any & {
  annotate<I, S>(tag: Context.Key<I, S>, value: S): HttpApiEndpoint.Any;
};

type AnnotatableTarget = {
  annotate<I, S>(tag: Context.Key<I, S>, value: S): unknown;
};

export const annotateRpcScopePolicy = <
  const Policy extends SheetRpcScopePolicy,
  Target extends AnnotatableTarget,
>(
  rpc: Target,
  policy: Policy,
): Target & WithSheetRpcScopePolicy<Policy> =>
  rpc.annotate(SheetRpcScopePolicyAnnotation, policy) as Target & WithSheetRpcScopePolicy<Policy>;

export const annotateSheetScopePolicy = <
  const Policy extends SheetScopePolicy,
  Endpoint extends AnnotatableEndpoint,
>(
  endpoint: Endpoint,
  policy: Policy,
): Endpoint & WithSheetRpcScopePolicy<Policy> =>
  endpoint.annotate(SheetScopePolicyAnnotation, policy) as Endpoint &
    WithSheetRpcScopePolicy<Policy>;

const hasAnnotations = (
  target: unknown,
): target is { readonly annotations: Context.Context<never> } =>
  Predicate.hasProperty(target, "annotations") && Context.isContext(target.annotations);

export const getRpcScopePolicy = (rpc: unknown): SheetRpcScopePolicy | undefined =>
  hasAnnotations(rpc)
    ? Option.getOrUndefined(Context.getOption(rpc.annotations, SheetRpcScopePolicyAnnotation))
    : undefined;

export const getSheetScopePolicy = (target: unknown): SheetScopePolicy | undefined =>
  HttpApiEndpoint.isHttpApiEndpoint(target)
    ? Option.getOrUndefined(Context.getOption(target.annotations, SheetScopePolicyAnnotation))
    : getRpcScopePolicy(target);
