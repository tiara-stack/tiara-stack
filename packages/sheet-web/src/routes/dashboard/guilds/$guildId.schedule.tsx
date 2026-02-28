import { createFileRoute, redirect } from "@tanstack/react-router";
import { Registry } from "@effect-atom/atom-react";
import { Array, Effect, Option } from "effect";
import { getAllChannelsAtom } from "#/lib/schedule";
import { getCurrentTimestamp } from "#/lib/utils";

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule")({
  component: ScheduleRedirect,
  loader: async ({ params, context }) => {
    const channels = await Effect.runPromise(
      Registry.getResult(context.atomRegistry, getAllChannelsAtom(params.guildId)).pipe(
        Effect.catchAll(() => Effect.succeed([])),
      ),
    );

    const defaultChannel = Array.head(channels);

    return Option.match(defaultChannel, {
      onSome: (channel) => {
        throw redirect({
          to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
          params: { guildId: params.guildId, channel },
          search: { timestamp: getCurrentTimestamp() },
        });
      },
      onNone: () => undefined,
    });
  },
});

function ScheduleRedirect() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-white/60 font-medium tracking-wide">NO CHANNELS AVAILABLE</div>
    </div>
  );
}
