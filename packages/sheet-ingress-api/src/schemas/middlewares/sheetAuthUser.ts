import { HashSet, Redacted, Context } from "effect";
import type { PermissionSet } from "../permissions";

type SheetAuthUserType = {
  // Discord user ID from the linked auth account.
  accountId: string;
  // Better Auth user ID for the auth-system user record.
  userId: string;
  // OAuth client ID when request is resolved from OAuth client credentials.
  clientId?: string;
  // Indicates a trusted OAuth service client with service-level authorization intent.
  trustedClient?: boolean;
  // OAuth services this client is allowed to act as a service actor for.
  allowedServices?: HashSet.HashSet<string>;
  // Scope aliases from OAuth tokens for potential non-breaking downstream checks.
  allowedScopes?: HashSet.HashSet<string>;
  permissions: PermissionSet;
  token: Redacted.Redacted<string>;
};

export class SheetAuthUser extends Context.Service<SheetAuthUser, SheetAuthUserType>()(
  "SheetAuthUser",
) {}
