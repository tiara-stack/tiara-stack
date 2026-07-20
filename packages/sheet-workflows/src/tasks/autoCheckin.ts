import { Cron, Effect, Layer, Schedule } from "effect";
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
    const autoKickTask = Effect.fn("autoKickTask", { attributes: { task: "autoKick" } })(
      function* () {
        yield* Effect.log("running automatic lockdown-role cleanup task...");
        const count = yield* autoCheckinService.runDueKicks();
        yield* Effect.annotateCurrentSpan({ processedConversationCount: count });
        yield* Effect.log(`processed ${count} automatic lockdown-role cleanup(s)`);
      },
    );

    yield* autoCheckinTask().pipe(
      Effect.annotateLogs({ task: "autoCheckin" }),
      Effect.withSpan("sheet-workflows.task.autoCheckin", {
        attributes: { task: "autoCheckin" },
      }),
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
    yield* autoKickTask().pipe(
      Effect.annotateLogs({ task: "autoKick" }),
      Effect.withSpan("sheet-workflows.task.autoKick", {
        attributes: { task: "autoKick" },
      }),
      Effect.schedule(
        Schedule.cron(
          Cron.make({
            seconds: [0],
            minutes: [15],
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
