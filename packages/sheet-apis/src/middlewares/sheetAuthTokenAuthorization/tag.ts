import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "@effect/platform";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";
import { Context } from "effect";

/**
 * SheetAuthUser context - contains user info from verified JWT token
 *
 * Includes the raw JWT token for service-to-service authentication using
 * Better Auth's bearer plugin.
 *
 * The JWT contains standard claims (sub, email, name). To get Discord-specific
 * info like discordUserId, use the Better Auth client:
 *
 * ```typescript
 * const { data: accounts } = await client.listAccounts({
 *   fetchOptions: { headers: { Authorization: `Bearer ${token}` } }
 * });
 * const discordAccount = accounts?.find(a => a.providerId === "discord");
 * ```
 */
export class SheetAuthUser extends Context.Tag("SheetAuthUser")<
  SheetAuthUser,
  {
    /** Internal user ID from JWT sub claim */
    userId: string;
    /** User email from JWT claims */
    email?: string;
    /** Raw JWT token for bearer authentication to other services */
    token: string;
  }
>() {}

export class SheetAuthTokenAuthorization extends HttpApiMiddleware.Tag<SheetAuthTokenAuthorization>()(
  "SheetAuthTokenAuthorization",
  {
    provides: SheetAuthUser,
    failure: Unauthorized,
    security: {
      sheetAuthToken: HttpApiSecurity.bearer.pipe(
        HttpApiSecurity.annotate(OpenApi.Description, "Require sheet-auth token for authorization"),
      ),
    },
  },
) {}
