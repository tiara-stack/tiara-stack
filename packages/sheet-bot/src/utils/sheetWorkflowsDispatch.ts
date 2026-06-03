import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { Duration, Effect } from "effect";

const sheetWorkflowsDispatchTimeout = Duration.seconds(10);

export const runSheetWorkflowsDispatch = <A, E, R>(
  response: CommandInteractionResponseContext,
  operation: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.timeout(sheetWorkflowsDispatchTimeout),
    Effect.catchTag("TimeoutError", () =>
      response.editReply({
        payload: {
          content: `Timed out while dispatching ${operation}. Please try again.`,
        },
      }),
    ),
    Effect.asVoid,
  );
