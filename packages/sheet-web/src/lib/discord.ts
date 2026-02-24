import { SheetApisClient } from "#/lib/sheetApis";

export const currentUserGuildsAtom = SheetApisClient.query("discord", "getCurrentUserGuilds", {});
