import { Context } from "effect";
import type { Permission } from "sheet-auth/client";

export class SheetAuthUser extends Context.Tag("SheetAuthUser")<
  SheetAuthUser,
  {
    /** Internal user ID from JWT sub claim */
    userId: string;
    /** User email from JWT claims */
    email?: string;
    /** User permissions from JWT claims */
    permissions?: Permission[];
    /** Raw JWT token for bearer authentication to other services */
    token: string;
  }
>() {}
