import { makeOAuthResourceTokenAuthorizer } from "sheet-auth/oauth-resource-authorization";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { makeSheetIngressServiceAuthorizationLayer } from "sheet-ingress-api/internal";
import { config } from "@/config";

export const SheetIngressServiceAuthorizationLive = makeSheetIngressServiceAuthorizationLayer({
  config,
  makeAuthorizer: makeOAuthResourceTokenAuthorizer,
  delegatedScope: "workflow.dispatch",
  serviceUserId: DISCORD_SERVICE_USER_ID_SENTINEL,
});
