import { Layer, Context } from "effect";
import { makeSheetAuthClient } from "sheet-auth/client";
import { config } from "@/config";

export class SheetAuthClient extends Context.Service<SheetAuthClient>()("SheetAuthClient", {
  make: makeSheetAuthClient(config.sheetAuthIssuer),
}) {
  static layer = Layer.effect(SheetAuthClient, this.make);
}
