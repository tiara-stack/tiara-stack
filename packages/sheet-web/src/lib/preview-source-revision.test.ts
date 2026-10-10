import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect } from "vitest";
import { makePreviewSourceRevisionReporter } from "./preview-source-revision";

it.effect("serializes authenticated create, update, and delete revision reports", () =>
  Effect.gen(function* () {
    const firstRequestStarted = yield* Deferred.make<void>();
    const releaseFirstRequest = yield* Deferred.make<void>();
    const requests: {
      readonly url: string;
      readonly method: string;
      readonly authorization: string | undefined;
      readonly body: unknown;
    }[] = [];
    const httpClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        requests.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.authorization,
          body: request.body.toJSON(),
        });
        if (requests.length === 1) {
          yield* Deferred.succeed(firstRequestStarted, undefined);
          yield* Deferred.await(releaseFirstRequest);
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }),
    );
    const httpLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
    const report = makePreviewSourceRevisionReporter({
      url: "https://preview.dev.tiara-stack.moe/revision",
      token: "preview-token",
      initialRevision: "revision-a",
    });
    const provideHttp = (event: Parameters<typeof report>[0]) =>
      report(event).pipe(Effect.provide(httpLayer));

    const create = yield* provideHttp({
      type: "create",
      file: "/workspace/new.ts",
      read: () => "created",
    }).pipe(Effect.forkChild);
    const update = yield* provideHttp({
      type: "update",
      file: "/workspace/existing.ts",
      read: () => "updated",
    }).pipe(Effect.forkChild);
    const remove = yield* provideHttp({
      type: "delete",
      file: "/workspace/removed.ts",
      read: () => {
        throw new Error("Deleted files must not be read");
      },
    }).pipe(Effect.forkChild);

    yield* Deferred.await(firstRequestStarted);
    expect(requests).toHaveLength(1);
    yield* Deferred.succeed(releaseFirstRequest, undefined);
    yield* Fiber.join(create);
    yield* Fiber.join(update);
    yield* Fiber.join(remove);

    expect(requests).toHaveLength(3);
    expect(
      requests.map(({ url, method, authorization }) => ({ url, method, authorization })),
    ).toEqual([
      {
        url: "https://preview.dev.tiara-stack.moe/revision",
        method: "POST",
        authorization: "Bearer preview-token",
      },
      {
        url: "https://preview.dev.tiara-stack.moe/revision",
        method: "POST",
        authorization: "Bearer preview-token",
      },
      {
        url: "https://preview.dev.tiara-stack.moe/revision",
        method: "POST",
        authorization: "Bearer preview-token",
      },
    ]);
    expect(
      requests.map(({ body }) =>
        typeof body === "object" && body !== null && "body" in body
          ? Reflect.get(body, "body")
          : undefined,
      ),
    ).toEqual([
      '{"revision":"3cbb601535e92106407e3c97734f5a05133fabd195fef4fe7dbf55377d270e43"}',
      '{"revision":"f9bd2f1809fd0a666a230c66c2abdde2e5c85ad9424bc6706d5c3117bbcebeed"}',
      '{"revision":"3247a90c89dcb944338948f7b91daa8c5c50da5faf5c7c5b771008c59696a157"}',
    ]);
  }),
);

it.effect("fails an unaccepted source revision within its 60-second deadline", () =>
  Effect.gen(function* () {
    const requestStarted = yield* Deferred.make<void>();
    const httpClient = HttpClient.make((_request) =>
      Deferred.succeed(requestStarted, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const report = makePreviewSourceRevisionReporter({
      url: "https://preview.dev.tiara-stack.moe/revision",
      token: "preview-token",
      initialRevision: "revision-a",
    });
    const pending = yield* report({
      type: "update",
      file: "/workspace/app.ts",
      read: () => "changed",
    })
      .pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient)))
      .pipe(Effect.forkChild);

    yield* Deferred.await(requestStarted);
    yield* TestClock.adjust(Duration.seconds(60));
    const result = yield* Effect.result(Fiber.join(pending));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toEqual(
        new Error("Connected preview could not activate the edited source revision"),
      );
  }),
);
