import { Cron, Effect, Layer, Schedule, pipe } from "effect";
import { AutoCheckinService } from "@/services";

export const autoCheckinTaskLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const autoCheckinService = yield* AutoCheckinService;
    const autoCheckinTask = Effect.fn("autoCheckinTask", { attributes: { task: "autoCheckin" } })(
      function* () {
        yield* Effect.log("running auto check-in task...");
        const count = yield* autoCheckinService.enqueueDueChannels();
        yield* Effect.log(`enqueued ${count} auto check-in channel workflow(s)`);
      },
    );

    yield* pipe(
      autoCheckinTask().pipe(Effect.annotateLogs({ task: "autoCheckin" })),
      Effect.schedule(
        Schedule.cron(
          Cron.make({
            seconds: [0],
            minutes: [45],
            hours: [],
            days: [],
            months: [],
            weekdays: [],
          }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(AutoCheckinService.layer));
