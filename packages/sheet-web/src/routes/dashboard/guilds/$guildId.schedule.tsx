import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { Atom, Result } from "@effect-atom/atom-react";
import { Effect, Schema } from "effect";
import { SheetApisClient } from "#/lib/sheetApis";
import {
  catchParseErrorAsValidationError,
  QueryResultError,
  ValidationError,
} from "typhoon-core/error";
import { RequestError, ResponseError } from "#/lib/error";
import { Sheet, Google, SheetConfig, Middlewares } from "sheet-apis/schema";

// Private atom for fetching all schedules to get channels
const _guildScheduleAtom = (guildId: string) =>
  SheetApisClient.query("schedule", "getAllPopulatedSchedules", {
    urlParams: { guildId },
  });

// Serializable atom for guild schedule
const guildScheduleAtom = (guildId: string) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      return yield* get.result(_guildScheduleAtom(guildId)).pipe(
        catchParseErrorAsValidationError,
        Effect.catchTags({
          RequestError: (error) => Effect.fail(RequestError.make(error)),
          ResponseError: (error) => Effect.fail(ResponseError.make(error)),
        }),
      );
    }),
  ).pipe(
    Atom.serializable({
      key: `schedule.redirect.getAllPopulatedSchedules.${guildId}`,
      schema: Result.Schema({
        success: Schema.Array(Sheet.PopulatedScheduleResult),
        error: Schema.Union(
          ValidationError,
          QueryResultError,
          Google.GoogleSheetsError,
          Sheet.ParserFieldError,
          SheetConfig.SheetConfigError,
          Middlewares.Unauthorized,
          RequestError,
          ResponseError,
        ),
      }),
    }),
  );

// Extract unique channels from schedules
const getChannelsFromSchedules = (
  schedules: readonly Sheet.PopulatedScheduleResult[],
): string[] => {
  const channelSet = new Set<string>();
  schedules.forEach((schedule) => {
    if (schedule._tag === "PopulatedSchedule") {
      channelSet.add(schedule.channel);
    }
  });
  return Array.from(channelSet).sort();
};

export const Route = createFileRoute("/dashboard/guilds/$guildId/schedule")({
  component: ScheduleRedirect,
  loader: async ({ params, context }) => {
    const { guildId } = params;
    const atom = guildScheduleAtom(guildId);
    const registry = context.atomRegistry;

    // Load the schedule data to get channels
    const result = await registry.get(atom);

    if (result._tag === "Success") {
      const channels = getChannelsFromSchedules(result.value);
      return { channels, defaultChannel: channels[0] ?? null };
    }

    return { channels: [], defaultChannel: null };
  },
});

function ScheduleRedirect() {
  const { guildId } = Route.useParams();
  const { defaultChannel } = Route.useLoaderData();

  // If no channel available, show error or redirect to a default
  if (!defaultChannel) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-white/60 font-medium tracking-wide">NO CHANNELS AVAILABLE</div>
      </div>
    );
  }

  // Redirect to first channel with calendar view as default
  return (
    <Suspense fallback={null}>
      <Navigate
        to="/dashboard/guilds/$guildId/schedule/$channel/calendar"
        params={{ guildId, channel: defaultChannel }}
        search={{ month: getCurrentMonth(), day: getCurrentDay() }}
        replace
      />
    </Suspense>
  );
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getCurrentDay(): string {
  const now = new Date();
  return now.toISOString().split("T")[0];
}
