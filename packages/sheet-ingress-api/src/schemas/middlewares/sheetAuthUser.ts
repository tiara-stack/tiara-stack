import { Redacted, Context } from "effect";
import type { PermissionSet, SheetAuthOAuthScope } from "../permissions";

type SheetAuthUserType = {
  // Discord user ID from the linked auth account.
  accountId: string;
  // Better Auth user ID for the auth-system user record.
  userId: string;
  permissions: PermissionSet;
  scopes: ReadonlySet<SheetAuthOAuthScope>;
  token: Redacted.Redacted<string>;
};

export class SheetAuthUser extends Context.Service<SheetAuthUser, SheetAuthUserType>()(
  "SheetAuthUser",
) {}
