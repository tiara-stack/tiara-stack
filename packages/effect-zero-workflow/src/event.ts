import { Effect, Predicate, Schema } from "effect";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { ReadonlyJSONValue } from "typhoon-zero/schema";

// This prefix is persisted inside durable event tokens. Keep it stable across
// the package extraction so active workflows can still decode existing IDs.
const eventDeferredPrefix = "effect-zero/workflow/event";

export const WorkflowEventId = DurableDeferred.Token;

export type WorkflowEventId = DurableDeferred.Token;

export const WorkflowEventCommandPayload = Schema.Struct({
  eventId: WorkflowEventId,
  value: ReadonlyJSONValue,
});

export type WorkflowEventCommandPayload = typeof WorkflowEventCommandPayload.Type;

export class WorkflowEventIdError extends Schema.TaggedErrorClass<WorkflowEventIdError>()(
  "WorkflowEventIdError",
  {
    message: Schema.String,
  },
) {}

export type ParsedWorkflowEventId = {
  readonly workflowName: string;
  readonly executionId: string;
  readonly eventName: string;
  readonly deferredName: string;
};

const eventPrefix = (eventName: string) =>
  `${eventDeferredPrefix}/${encodeURIComponent(eventName)}/`;

export const parseWorkflowEventId = (
  eventId: WorkflowEventId,
): Effect.Effect<ParsedWorkflowEventId, WorkflowEventIdError> =>
  Effect.try({
    try: () => {
      const parsed = DurableDeferred.TokenParsed.fromString(eventId);
      const prefix = `${eventDeferredPrefix}/`;
      if (!parsed.deferredName.startsWith(prefix)) {
        throw new Error("Event ID does not identify an effect-zero workflow event");
      }
      const encodedName = parsed.deferredName.slice(prefix.length).split("/", 1)[0];
      if (!encodedName) {
        throw new Error("Event ID is missing its event name");
      }
      return {
        workflowName: parsed.workflowName,
        executionId: parsed.executionId,
        eventName: decodeURIComponent(encodedName),
        deferredName: parsed.deferredName,
      };
    },
    catch: (cause) =>
      new WorkflowEventIdError({
        message: Predicate.isError(cause) ? cause.message : String(cause),
      }),
  });

type EventSchema = Schema.Codec<unknown, unknown, never, never>;

export interface AnyWorkflowEvent {
  readonly name: string;
  readonly valueSchema: EventSchema;
  readonly errorSchema: EventSchema;
  readonly sendUnknown: (
    eventId: WorkflowEventId,
    value: unknown,
  ) => Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine>;
}

/**
 * Defines a shared, typed workflow event. The event name is embedded in
 * persisted identifiers and must remain stable. The event key must be unique
 * within a workflow execution because repeated keys address the same one-shot
 * mailbox. Sending may happen before or after `await`; the Effect workflow
 * engine durably stores the first completion and resumes the matching execution.
 */
export const defineEvent = <
  const Name extends string,
  Value extends EventSchema,
  Error extends EventSchema = typeof Schema.Never,
>(options: {
  readonly name: Name;
  readonly value: Value;
  readonly error?: Error | undefined;
}) => {
  const errorSchema = options.error ?? (Schema.Never as unknown as Error);

  const deferred = (deferredName: string) =>
    DurableDeferred.make(deferredName, {
      success: options.value,
      error: errorSchema,
    });

  const eventDeferred = (eventId: WorkflowEventId) =>
    parseWorkflowEventId(eventId).pipe(
      Effect.flatMap((parsed) =>
        parsed.eventName === options.name
          ? Effect.succeed(deferred(parsed.deferredName))
          : Effect.fail(
              new WorkflowEventIdError({
                message: `Expected workflow event ${options.name}, received ${parsed.eventName}`,
              }),
            ),
      ),
    );

  const deferredNameFor = (eventKey: string) =>
    `${eventPrefix(options.name)}${encodeURIComponent(eventKey)}`;

  const create = (input: {
    readonly workflow: Workflow.Any;
    readonly executionId: string;
    readonly eventKey: string;
  }): WorkflowEventId => {
    const event = deferred(deferredNameFor(input.eventKey));
    return DurableDeferred.tokenFromExecutionId(event, input);
  };

  const createCurrent = (
    eventKey: string,
  ): Effect.Effect<WorkflowEventId, never, WorkflowEngine.WorkflowInstance> => {
    const event = deferred(deferredNameFor(eventKey));
    return DurableDeferred.token(event);
  };

  const awaitEvent = (
    eventId: WorkflowEventId,
  ): Effect.Effect<
    Value["Type"],
    Error["Type"] | WorkflowEventIdError,
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  > => Effect.flatMap(eventDeferred(eventId), DurableDeferred.await);

  const send = (
    eventId: WorkflowEventId,
    value: Value["Type"],
  ): Effect.Effect<void, WorkflowEventIdError, WorkflowEngine.WorkflowEngine> =>
    Effect.flatMap(eventDeferred(eventId), (mailbox) =>
      DurableDeferred.succeed(mailbox, {
        token: eventId,
        value,
      }),
    );

  const sendUnknown = (
    eventId: WorkflowEventId,
    value: unknown,
  ): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
    Schema.decodeUnknownEffect(options.value)(value).pipe(
      Effect.flatMap((decoded) => send(eventId, decoded)),
    );

  return {
    name: options.name,
    valueSchema: options.value,
    errorSchema,
    create,
    createCurrent,
    await: awaitEvent,
    send,
    sendUnknown,
  };
};
