import { createFileRoute, redirect } from "@tanstack/react-router";
import { Registry } from "@effect-atom/atom-react";
import { Array, Effect, Option } from "effect";
import { guildScheduleAtom, getChannelsFromSchedules } from "#/lib/schedule";
import { getCurrentMonth, getCurrentDay } from "#/lib/utils";

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule")({
  component: ScheduleRedirect,
  loader: async ({ params, context }) => {
    const schedules = await Effect.runPromise(
      Registry.getResult(context.atomRegistry, guildScheduleAtom(params.guildId)).pipe(
        Effect.catchAll(() => Effect.succeed([])),
      ),
    );

    const channels = getChannelsFromSchedules(schedules);
    const defaultChannel = Array.head(channels);

    return Option.match(defaultChannel, {
      onSome: (channel) => {
        throw redirect({
          to: "/dashboard/guilds/$guildId/schedule/$channel/calendar",
          params: { guildId: params.guildId, channel },
          search: { month: getCurrentMonth(), day: getCurrentDay() },
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
