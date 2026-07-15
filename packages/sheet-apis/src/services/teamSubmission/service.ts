import { Context, Effect, Layer } from "effect";
import { GoogleSheets } from "../google/sheets";
import { SheetConfigService } from "../sheetConfig";
import { SheetZeroClient } from "../sheetZeroClient";
import { WorkspaceConfigService } from "../workspaceConfig";
import type { TeamSubmissionDependencies } from "./dependencies";
import { makeSubmissionLocks } from "./locks";
import { makeTeamSubmissionPersistence } from "./persistence";
import { makeReviewOperations } from "./review";
import { makeTeamSubmissionSupport } from "./support";
import { makeUpsertFromDiscord } from "./upsert";

export class TeamSubmissionService extends Context.Service<TeamSubmissionService>()(
  "TeamSubmissionService",
  {
    make: Effect.gen(function* () {
      const dependencies = {
        googleSheets: yield* GoogleSheets,
        sheetConfigService: yield* SheetConfigService,
        workspaceConfigService: yield* WorkspaceConfigService,
        zero: yield* SheetZeroClient,
      } satisfies TeamSubmissionDependencies;
      const locks = makeSubmissionLocks();
      const support = makeTeamSubmissionSupport(dependencies);
      const persistence = makeTeamSubmissionPersistence(dependencies, locks);
      const upsertFromDiscord = makeUpsertFromDiscord(dependencies, locks, support, persistence);
      const { confirmFromDiscord, revertFromDiscord } = makeReviewOperations(
        dependencies,
        locks,
        persistence,
      );

      return {
        upsertFromDiscord,
        setConfirmationMessage: persistence.setConfirmationMessage,
        revertFromDiscord,
        confirmFromDiscord,
      };
    }),
  },
) {
  static layer = Layer.effect(TeamSubmissionService, this.make).pipe(
    Layer.provide([
      GoogleSheets.layer,
      SheetConfigService.layer,
      WorkspaceConfigService.layer,
      SheetZeroClient.layer,
    ]),
  );
}
