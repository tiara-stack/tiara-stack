import { Redacted, Context } from "effect";
import type { PermissionSet, SheetAuthOAuthScope } from "../permissions";

export type SheetAuthUserTokenType =
  | "session"
  | "oauth_access_token"
  | "delegated_oauth_access_token"
  | "service"
  | "unavailable";

type SheetAuthUserType = {
  // Discord user ID from the linked auth account.
  accountId: string;
  // Better Auth user ID for the auth-system user record.
  userId: string;
  permissions: PermissionSet;
  scopes: ReadonlySet<SheetAuthOAuthScope>;
  token: Redacted.Redacted<string>;
  tokenType: SheetAuthUserTokenType;
};

export class SheetAuthUser extends Context.Service<SheetAuthUser, SheetAuthUserType>()(
  "SheetAuthUser",
) {}
