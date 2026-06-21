import { Cron, Effect, Layer, Schedule, pipe } from "effect";
import { AutoCheckinService } from "@/services";

export const autoCheckinTaskLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const autoCheckinService = yield* AutoCheckinService;
    const autoCheckinTask = Effect.fn("autoCheckinTask", { attributes: { task: "autoCheckin" } })(
      function* () {
        yield* Effect.log("running auto check-in task...");
        const count = yield* autoCheckinService.enqueueDueConversations();
        yield* Effect.annotateCurrentSpan({ enqueuedConversationCount: count });
        yield* Effect.log(`enqueued ${count} auto check-in conversation workflow(s)`);
      },
    );

    yield* pipe(
      autoCheckinTask().pipe(
        Effect.annotateLogs({ task: "autoCheckin" }),
        Effect.withSpan("sheet-workflows.task.autoCheckin", {
          attributes: { task: "autoCheckin" },
        }),
      ),
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
