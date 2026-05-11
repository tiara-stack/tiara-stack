import { DiscordREST, Ix } from "dfx";
import { MessageFlags } from "discord-api-types/v10";
import { CommandHelper } from "dfx/Interactions/commandHelper";
import { Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { WrappedCommandHelper, makeCommand, makeForkedCommandHandler } from "./commandHelper";
import { makeButton, makeForkedMessageComponentHandler } from "./messageComponentHelper";
import {
  InteractionResponse,
  MessageComponentInteractionResponse,
  makeInteractionResponse,
  provideInteractionResponse,
} from "./interactionResponse";
import { provideInteractionToken } from "./interaction";

const application = { id: "application-1" };

const makeInteraction = (id: string, token: string) =>
  ({
    application_id: application.id,
    id,
    token,
  }) as never;

const makeRest = (
  calls: Array<{
    readonly method: string;
    readonly applicationId: string;
    readonly token: string;
    readonly response?: unknown;
  }>,
) =>
  ({
    updateOriginalWebhookMessage: (applicationId: string, token: string, response: unknown) =>
      Effect.sync(() => {
        calls.push({ method: "edit", applicationId, token, response });
        return {};
      }),
    executeWebhook: (applicationId: string, token: string, response: unknown) =>
      Effect.sync(() => {
        calls.push({ method: "followUp", applicationId, token, response });
        return {};
      }),
    withFiles:
      () =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect,
  }) as never;

const makeCommandHelper = () =>
  new WrappedCommandHelper({ data: {}, target: undefined } as never, Option.none(), []);

const provideDiscord = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  calls: Array<{
    readonly method: string;
    readonly applicationId: string;
    readonly token: string;
    readonly response?: unknown;
  }>,
) => effect.pipe(Effect.provideService(DiscordREST, makeRest(calls)));

const provideInteraction = <A, E, R>(effect: Effect.Effect<A, E, R>, id: string, token: string) =>
  effect.pipe(
    provideInteractionToken,
    Effect.provideService(Ix.Interaction, makeInteraction(id, token)),
  );

describe("interaction response service", () => {
  it("propagates the current interaction token through forked command handlers", async () => {
    const calls: Array<{
      readonly method: string;
      readonly applicationId: string;
      readonly token: string;
    }> = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const forkedHandler = yield* makeForkedCommandHandler(() =>
          Effect.gen(function* () {
            const response = yield* InteractionResponse;
            yield* response.editReply({ payload: {} });
          }),
        );

        yield* Effect.all(
          [
            provideInteraction(
              provideInteractionResponse("command", forkedHandler(makeCommandHelper())),
              "interaction-1",
              "token-1",
            ),
            provideInteraction(
              provideInteractionResponse("command", forkedHandler(makeCommandHelper())),
              "interaction-2",
              "token-2",
            ),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );

    await Effect.runPromise(provideDiscord(program, calls) as Effect.Effect<void, never, never>);

    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ applicationId: "application-1", token: "token-1" }),
        expect.objectContaining({ applicationId: "application-1", token: "token-2" }),
      ]),
    );
  });

  it("propagates the current interaction token through forked message component handlers", async () => {
    const calls: Array<{
      readonly method: string;
      readonly applicationId: string;
      readonly token: string;
    }> = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const forkedHandler = yield* makeForkedMessageComponentHandler(
          Effect.gen(function* () {
            const response = yield* MessageComponentInteractionResponse;
            yield* response.editReply({ payload: {} });
          }),
        );

        yield* Effect.all(
          [
            provideInteraction(
              provideInteractionResponse("message-component", forkedHandler()),
              "interaction-1",
              "token-1",
            ),
            provideInteraction(
              provideInteractionResponse("message-component", forkedHandler()),
              "interaction-2",
              "token-2",
            ),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );

    await Effect.runPromise(provideDiscord(program, calls) as Effect.Effect<void, never, never>);

    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ applicationId: "application-1", token: "token-1" }),
        expect.objectContaining({ applicationId: "application-1", token: "token-2" }),
      ]),
    );
  });

  it("tracks acknowledgement state with a shared Ref", async () => {
    const calls: Array<{
      readonly method: string;
      readonly applicationId: string;
      readonly token: string;
      readonly response?: unknown;
    }> = [];

    const program = Effect.gen(function* () {
      const response = yield* makeInteractionResponse("command");
      yield* response.deferReply();
      expect(yield* response.getAcknowledgementState).toBe("deferred-reply");
      yield* response.respondWithError(new Error("boom"));
    });

    await Effect.runPromise(
      provideDiscord(
        provideInteraction(program, "interaction-1", "token-1"),
        calls,
      ) as Effect.Effect<void, never, never>,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "edit", token: "token-1" });
  });

  it("edits then follows up when a deferred component update fails", async () => {
    const calls: Array<{
      readonly method: string;
      readonly applicationId: string;
      readonly token: string;
      readonly response?: unknown;
    }> = [];

    const program = provideInteractionResponse(
      "message-component",
      Effect.gen(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferUpdate();
        yield* response.respondWithError(new Error("boom"));
      }),
    );

    await Effect.runPromise(
      provideDiscord(
        provideInteraction(program, "interaction-1", "token-1"),
        calls,
      ) as Effect.Effect<void, never, never>,
    );

    expect(calls.map((call) => call.method)).toEqual(["edit", "followUp"]);
  });

  it("does not overwrite acknowledgement state when a fallback reply loses", async () => {
    const calls: Array<{
      readonly method: string;
      readonly applicationId: string;
      readonly token: string;
      readonly response?: unknown;
    }> = [];

    const program = provideInteractionResponse(
      "message-component",
      Effect.gen(function* () {
        const response = yield* MessageComponentInteractionResponse;
        yield* response.deferUpdate();
        const sent = yield* response.reply({ content: "fallback" });
        expect(sent).toBe(false);
        expect(yield* response.getAcknowledgementState).toBe("deferred-update");
        yield* response.respondWithError(new Error("boom"));
      }),
    );

    await Effect.runPromise(
      provideDiscord(
        provideInteraction(program, "interaction-1", "token-1"),
        calls,
      ) as Effect.Effect<void, never, never>,
    );

    expect(calls.map((call) => call.method)).toEqual(["edit", "followUp"]);
  });

  it("falls back when a button handler does not set a response", async () => {
    const calls: Array<{
      readonly method: string;
      readonly applicationId: string;
      readonly token: string;
    }> = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const button = yield* makeButton({ custom_id: "test" }, Effect.void);
        return yield* button.handler;
      }),
    );

    const result = await Effect.runPromise(
      provideDiscord(
        provideInteraction(
          provideInteractionResponse("message-component", program),
          "interaction-1",
          "token-1",
        ),
        calls,
      ) as Effect.Effect<any, never, never>,
    );

    expect(result.data).toMatchObject({
      content: "The button did not set a response.",
      flags: MessageFlags.Ephemeral,
    });
  });

  it("falls back when a command handler does not set a response", async () => {
    const calls: Array<{
      readonly method: string;
      readonly applicationId: string;
      readonly token: string;
    }> = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const command = yield* makeCommand(
          (builder) => builder.setName("test").setDescription("test"),
          () => Effect.void,
        );
        const fiber = yield* command
          .handler({
            data: command.data,
            target: undefined,
          } as unknown as CommandHelper<typeof command.data>)
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust(Duration.millis(2500));
        return yield* Fiber.join(fiber);
      }),
    );

    const result = await Effect.runPromise(
      provideDiscord(
        provideInteraction(
          provideInteractionResponse("command", program),
          "interaction-1",
          "token-1",
        ),
        calls,
      ).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<any, never, never>,
    );

    expect(result.data).toMatchObject({
      content: "The command did not set a response in time.",
      flags: MessageFlags.Ephemeral,
    });
  });
});
