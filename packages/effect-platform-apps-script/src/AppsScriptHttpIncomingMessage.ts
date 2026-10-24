import * as Effect from "effect/Effect";
import * as Inspectable from "effect/Inspectable";
import * as Option from "effect/Option";
import { pipeArguments } from "effect/Pipeable";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Headers from "effect/unstable/http/Headers";
import * as IncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as UrlParams from "effect/unstable/http/UrlParams";

/**
 * @since 1.0.0
 * @category Constructors
 */
export abstract class AppsScriptHttpIncomingMessage<E>
  extends Inspectable.Class
  implements IncomingMessage.HttpIncomingMessage<E>
{
  /**
   * @since 1.0.0
   */
  readonly [IncomingMessage.TypeId]: typeof IncomingMessage.TypeId;
  readonly source: GoogleAppsScript.URL_Fetch.HTTPResponse;
  readonly onError: (error: unknown) => E;
  readonly remoteAddressOverride?: Option.Option<string> | undefined;

  constructor(
    source: GoogleAppsScript.URL_Fetch.HTTPResponse,
    onError: (error: unknown) => E,
    remoteAddressOverride?: Option.Option<string>,
  ) {
    super();
    this[IncomingMessage.TypeId] = IncomingMessage.TypeId;
    this.source = source;
    this.onError = onError;
    this.remoteAddressOverride = remoteAddressOverride;
  }

  pipe() {
    return pipeArguments(this, arguments);
  }

  get headers() {
    const headerArray =
      this.source.getAllHeaders() /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Record<
        string,
        string | string[]
      > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
    const headers: Record<string, string | string[]> = {};
    for (const key in headerArray) {
      const value = headerArray[key];
      if (value !== undefined) {
        headers[key] = value;
      }
    }
    return Headers.fromInput(headers);
  }

  get remoteAddress() {
    return this.remoteAddressOverride ?? Option.fromNullishOr(undefined);
  }

  private textEffect: Effect.Effect<string, E> | undefined;
  get text(): Effect.Effect<string, E> {
    if (this.textEffect) {
      return this.textEffect;
    }
    this.textEffect = Effect.runSync(
      Effect.cached(
        Effect.try({
          try: () => {
            const content = this.source.getContent();
            const uint8Array = Uint8Array.from(content);
            return new TextDecoder().decode(uint8Array);
          },
          catch: this.onError,
        }),
      ),
    );
    return this.textEffect;
  }

  get textUnsafe(): string {
    return Effect.runSync(this.text);
  }

  get json(): Effect.Effect<Schema.Json, E> {
    return Effect.flatMap(this.text, (text) =>
      Effect.try({
        try: () => (text === "" ? null : JSON.parse(text)),
        catch: this.onError,
      }),
    );
  }

  get jsonUnsafe(): Schema.Json {
    return Effect.runSync(this.json);
  }

  get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, E> {
    return Effect.flatMap(this.text, (_) =>
      Effect.try({
        try: () => UrlParams.fromInput(new URLSearchParams(_)),
        catch: this.onError,
      }),
    );
  }

  get stream(): Stream.Stream<Uint8Array, E> {
    return Stream.sync(() => {
      const content = this.source.getContent();
      return Uint8Array.from(content);
    });
  }

  get arrayBuffer(): Effect.Effect<ArrayBuffer, E> {
    return Effect.try({
      try: () => {
        const content = this.source.getContent();
        const uint8Array = Uint8Array.from(content);
        return uint8Array.buffer;
      },
      catch: this.onError,
    });
  }
}
