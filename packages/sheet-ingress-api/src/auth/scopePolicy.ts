import { Effect, HashSet } from "effect";
import { Unauthorized } from "typhoon-core/error";
import { getSheetScopePolicy, type SheetScopePolicy } from "../middlewares/rpcScopePolicy";
import { getRpcTag } from "../middlewares/rpcTag";
import { SheetAuthUser } from "../schemas/middlewares/sheetAuthUser";
import type { Permission, SheetAuthOAuthScope } from "../schemas/permissions";

export type ForwardedSheetAuthUser = typeof SheetAuthUser.Service;

export type RequireWorkflowScopePolicyOptions = {
  readonly missingRpcTagMessage: string;
  readonly fallbackLogMessage: string;
};

export const hasPermission = (permissions: HashSet.HashSet<Permission>, permission: Permission) =>
  HashSet.has(permissions, permission);

const requireServicePolicy = (rpcTag: string, user: ForwardedSheetAuthUser) =>
  hasPermission(user.permissions, "service")
    ? Effect.void
    : Effect.fail(new Unauthorized({ message: `${rpcTag} requires service permission` }));

export const hasUserScopePolicy = (policy: SheetAuthOAuthScope, user: ForwardedSheetAuthUser) =>
  hasPermission(user.permissions, "service") ||
  hasPermission(user.permissions, "app_owner") ||
  user.scopes.has(policy);

const requireUserScopePolicy = (
  rpcTag: string,
  policy: SheetAuthOAuthScope,
  user: ForwardedSheetAuthUser,
) =>
  hasUserScopePolicy(policy, user)
    ? Effect.void
    : Effect.fail(new Unauthorized({ message: `${rpcTag} requires ${policy} scope` }));

export const requireKnownScopePolicy = (
  rpcTag: string,
  policy: SheetScopePolicy,
  user: ForwardedSheetAuthUser,
) => {
  if (policy._tag === "none") {
    return Effect.void;
  }
  if (policy._tag === "service") {
    return requireServicePolicy(rpcTag, user);
  }
  return requireUserScopePolicy(rpcTag, policy.scope, user);
};

export const requireWorkflowScopePolicy = (
  rpc: unknown,
  user: ForwardedSheetAuthUser,
  options: RequireWorkflowScopePolicyOptions,
) =>
  Effect.gen(function* () {
    const rpcTagResult = getRpcTag(rpc);
    if (!rpcTagResult) {
      return yield* Effect.fail(new Unauthorized({ message: options.missingRpcTagMessage }));
    }
    if (rpcTagResult.source !== "_tag") {
      yield* Effect.logWarning(options.fallbackLogMessage, {
        rpcTag: rpcTagResult.tag,
        source: rpcTagResult.source,
      });
    }
    const rpcTag = rpcTagResult.tag;

    const policy = getSheetScopePolicy(rpc);
    if (!policy) {
      return yield* Effect.fail(
        new Unauthorized({ message: `No OAuth scope policy configured for ${rpcTag}` }),
      );
    }

    return yield* requireKnownScopePolicy(rpcTag, policy, user);
  });

export const requireHttpEndpointScopePolicy = (
  endpoint: { readonly name: string },
  user: ForwardedSheetAuthUser,
  _options: Omit<RequireWorkflowScopePolicyOptions, "fallbackLogMessage">,
) =>
  Effect.gen(function* () {
    const policy = getSheetScopePolicy(endpoint);
    if (!policy) {
      return yield* Effect.fail(
        new Unauthorized({ message: `No OAuth scope policy configured for ${endpoint.name}` }),
      );
    }

    return yield* requireKnownScopePolicy(endpoint.name, policy, user);
  });
