import { createHash } from "node:crypto";
import { Duration, Effect, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

interface PreviewSourceRevisionEvent {
  readonly type: "create" | "update" | "delete";
  readonly file: string;
  readonly read: () => string | Promise<string>;
}

const revisionReportTimeout = Duration.seconds(60);
const revisionReportFailure = () =>
  new Error("Connected preview could not activate the edited source revision");

export const makePreviewSourceRevisionReporter = (options: {
  readonly url: string;
  readonly token: string;
  readonly initialRevision: string;
}) => {
  let currentRevision = createHash("sha256").update(options.initialRevision).digest("hex");
  const reportSemaphore = Semaphore.makeUnsafe(1);

  return (event: PreviewSourceRevisionEvent) =>
    reportSemaphore.withPermit(
      Effect.gen(function* () {
        const content =
          event.type === "delete"
            ? ""
            : yield* Effect.tryPromise({
                try: () => Promise.resolve(event.read()),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
        currentRevision = createHash("sha256")
          .update(currentRevision)
          .update(event.file)
          .update("\0")
          .update(content)
          .digest("hex");
        const request = HttpClientRequest.post(options.url).pipe(
          HttpClientRequest.bearerToken(options.token),
          HttpClientRequest.bodyJsonUnsafe({ revision: currentRevision }),
        );
        const httpClient = yield* HttpClient.HttpClient;
        const response = yield* httpClient
          .execute(request)
          .pipe(Effect.timeout(revisionReportTimeout), Effect.mapError(revisionReportFailure));
        yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.mapError(revisionReportFailure),
        );
      }),
    );
};
