import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import { pipeArguments } from "effect/Pipeable";
import * as Cookies from "effect/unstable/http/Cookies";
import type * as Body from "effect/unstable/http/HttpBody";
import * as Client from "effect/unstable/http/HttpClient";
import * as Error from "effect/unstable/http/HttpClientError";
import type { HttpClientRequest } from "effect/unstable/http/HttpClientRequest";
import * as Response from "effect/unstable/http/HttpClientResponse";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import * as IncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import { AppsScriptHttpIncomingMessage } from "./AppsScriptHttpIncomingMessage";

// -----------------------------------------------------------------------------
// AppsScript Client
// -----------------------------------------------------------------------------

interface AppsScriptHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

class AppsScriptResponse
  extends AppsScriptHttpIncomingMessage<Error.HttpClientError>
  implements HttpClientResponse
{
  readonly [Response.TypeId]: typeof Response.TypeId;
  readonly request: HttpClientRequest;
  cachedCookies?: Cookies.Cookies;

  constructor(request: HttpClientRequest, source: GoogleAppsScript.URL_Fetch.HTTPResponse) {
    super(
      source,
      (cause) =>
        new Error.HttpClientError({
          reason: new Error.DecodeError({
            request,
            response: this,
            cause,
          }),
        }),
    );
    this[Response.TypeId] = Response.TypeId;
    this.request = request;
  }

  get status() {
    return this.source.getResponseCode();
  }

  get statusText() {
    return undefined;
  }

  get cookies(): Cookies.Cookies {
    if (this.cachedCookies !== undefined) {
      return this.cachedCookies;
    }
    const headerArray = this.source.getAllHeaders() as Record<string, string | string[]>;
    const header = headerArray["set-cookie"];
    return (this.cachedCookies = header ? Cookies.fromSetCookie(header) : Cookies.empty);
  }

  private formDataBody?: Effect.Effect<FormData, Error.HttpClientError>;
  get formData(): Effect.Effect<FormData, Error.HttpClientError> {
    return (this.formDataBody ??= Effect.tryPromise({
      try: async () => {
        const headers = new globalThis.Headers();
        const headerArray = this.source.getAllHeaders() as Record<string, string | string[]>;
        for (const key in headerArray) {
          const value = headerArray[key];
          if (value !== undefined) {
            if (Array.isArray(value)) {
              value.forEach((v) => headers.append(key, v));
            } else {
              headers.append(key, value);
            }
          }
        }
        const status = this.source.getResponseCode();
        const init: ResponseInit = status ? { headers, status } : { headers };
        const content = this.source.getContent();
        const uint8Array = Uint8Array.from(content);
        const contentType = headers.get("content-type");
        return new globalThis.Response(
          new globalThis.Blob(
            [uint8Array.buffer],
            contentType === null ? undefined : { type: contentType },
          ),
          init,
        ).formData();
      },
      catch: (cause) =>
        new Error.HttpClientError({
          reason: new Error.DecodeError({
            request: this.request,
            response: this,
            cause,
          }),
        }),
    }).pipe(Effect.cached, Effect.runSync));
  }

  toJSON(): unknown {
    return IncomingMessage.inspect(this, {
      _id: "effect/http/HttpClientResponse",
      request: this.request.toJSON(),
      status: this.status,
    });
  }

  pipe() {
    return pipeArguments(this, arguments);
  }
}

const sendBody = (
  request: HttpClientRequest,
  httpRequest: AppsScriptHttpRequest,
  body: Body.HttpBody,
): Effect.Effect<void, Error.HttpClientError> =>
  Effect.suspend(
    (): Effect.Effect<void, Error.HttpClientError> =>
      Match.value(body).pipe(
        Match.tagsExhaustive({
          Empty: () => {
            httpRequest.body = new Uint8Array(0);
            return Effect.void;
          },
          Uint8Array: (body) => {
            httpRequest.body = body.body as Uint8Array;
            return Effect.void;
          },
          Raw: (body) => {
            if (body.body instanceof Uint8Array || typeof body.body === "string") {
              httpRequest.body = body.body;
              return Effect.void;
            }
            return Effect.fail(
              new Error.HttpClientError({
                reason: new Error.EncodeError({
                  request,
                  cause: new globalThis.Error(
                    "Raw body must be a string or Uint8Array in Apps Script",
                  ),
                }),
              }),
            );
          },
          FormData: () =>
            Effect.fail(
              new Error.HttpClientError({
                reason: new Error.EncodeError({
                  request,
                  cause: new globalThis.Error("FormData not supported in Apps Script"),
                }),
              }),
            ),
          Stream: () =>
            Effect.fail(
              new Error.HttpClientError({
                reason: new Error.EncodeError({
                  request,
                  cause: new globalThis.Error("Stream body not supported in Apps Script"),
                }),
              }),
            ),
        }),
      ),
  );

const waitForResponse = (
  request: HttpClientRequest,
  httpRequest: AppsScriptHttpRequest,
): Effect.Effect<GoogleAppsScript.URL_Fetch.HTTPResponse, Error.HttpClientError> =>
  Effect.try({
    try: () => {
      const method = httpRequest.method.toLowerCase();
      const validMethods = ["get", "post", "put", "delete", "patch"] as const;
      const isValidMethod = (m: string): m is "get" | "post" | "put" | "delete" | "patch" =>
        validMethods.includes(m as "get" | "post" | "put" | "delete" | "patch");
      const validMethod = isValidMethod(method) ? method : "get";

      const headers: Record<string, string> = {};
      for (const key in httpRequest.headers) {
        if (key.toLowerCase() !== "content-length") {
          const value = httpRequest.headers[key];
          if (value !== undefined) {
            headers[key] = value;
          }
        }
      }

      const options: GoogleAppsScript.URL_Fetch.URLFetchRequest = {
        url: httpRequest.url,
        method: validMethod,
        headers,
        payload: httpRequest.body,
      };

      return UrlFetchApp.fetch(httpRequest.url, options);
    },
    catch: (cause) =>
      new Error.HttpClientError({
        reason: new Error.TransportError({
          request,
          cause,
        }),
      }),
  });

/**
 * @since 1.0.0
 * @category Constructors
 */
export const make: Effect.Effect<Client.HttpClient> = Effect.sync(() =>
  Client.make((request, url, _signal) => {
    const urlString = typeof url === "string" ? url : url.toString();

    const headersObj: Record<string, string> = {};
    for (const key in request.headers) {
      const value = request.headers[key];
      if (value !== undefined) {
        headersObj[key] = value;
      }
    }

    const httpRequest: AppsScriptHttpRequest = {
      method: request.method,
      url: urlString,
      headers: headersObj,
      body: undefined,
    };

    return Effect.gen(function* () {
      yield* sendBody(request, httpRequest, request.body);
      const response = yield* waitForResponse(request, httpRequest);
      return new AppsScriptResponse(request, response);
    });
  }),
);

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer: Layer.Layer<Client.HttpClient> = Client.layerMergedContext(make);
