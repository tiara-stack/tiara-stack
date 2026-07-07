import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Data from "effect/Data";

class SheetAuthWebForwarderError extends Data.TaggedError("SheetAuthWebForwarderError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type HandlerParams = {
  readonly request: HttpServerRequest.HttpServerRequest;
};

export const createForwarder =
  (webHandler: (req: Request) => Promise<Response>) =>
  ({ request }: HandlerParams) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed(
            HttpServerResponse.empty({
              status:
                error._tag === "RequestParseError"
                  ? 400
                  : error._tag === "RouteNotFound"
                    ? 404
                    : 500,
            }),
          ),
        onSuccess: (webRequest) =>
          Effect.tryPromise({
            try: () => webHandler(webRequest),
            catch: (error) =>
              new SheetAuthWebForwarderError({ message: String(error), cause: error }),
          }).pipe(
            Effect.match({
              onFailure: (error) => {
                console.error("Failed to forward web handler response", error);
                return HttpServerResponse.fromWeb(
                  new Response("Internal Server Error", { status: 500 }),
                );
              },
              onSuccess: HttpServerResponse.fromWeb,
            }),
          ),
      }),
    );
