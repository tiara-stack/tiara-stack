import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { ArgumentError, SchemaError, Unauthorized, UnknownError } from "typhoon-core/error";
import { MutatorResultError, QueryResultError } from "typhoon-zero/error";
import {
  TeamSubmissionConfirmFromDiscordPayload,
  TeamSubmissionConfirmResult,
  TeamSubmissionSetConfirmationPayload,
  TeamSubmissionRevertFromDiscordPayload,
  TeamSubmissionRevertResult,
  TeamSubmissionUpsertFromDiscordPayload,
  TeamSubmissionUpsertResult,
} from "../../schemas/teamSubmission";
import { GoogleSheetsError } from "../../schemas/google";
import { SheetConfigError } from "../../schemas/sheetConfig";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";

const TeamSubmissionErrors = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  MutatorResultError,
  ArgumentError,
  Unauthorized,
  UnknownError,
] as const;

export class TeamSubmissionApi extends HttpApiGroup.make("teamSubmission")
  .add(
    HttpApiEndpoint.post("upsertFromDiscord", "/team-submission/discord/upsert", {
      payload: TeamSubmissionUpsertFromDiscordPayload,
      success: TeamSubmissionUpsertResult,
      error: TeamSubmissionErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("setConfirmationMessage", "/team-submission/confirmation/set", {
      payload: TeamSubmissionSetConfirmationPayload,
      success: TeamSubmissionUpsertResult,
      error: TeamSubmissionErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("revertFromDiscord", "/team-submission/discord/revert", {
      payload: TeamSubmissionRevertFromDiscordPayload,
      success: TeamSubmissionRevertResult,
      error: TeamSubmissionErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("confirmFromDiscord", "/team-submission/discord/confirm", {
      payload: TeamSubmissionConfirmFromDiscordPayload,
      success: TeamSubmissionConfirmResult,
      error: TeamSubmissionErrors,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Team Submission")
  .annotate(OpenApi.Description, "Discord team submission parsing and sheet writes") {}
