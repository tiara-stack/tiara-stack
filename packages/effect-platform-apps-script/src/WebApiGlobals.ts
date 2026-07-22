/**
 * Minimal Web API surface required by Effect's HTTP contracts in Google Apps Script.
 *
 * Apps Script consumers install these globals before loading this package. Keep these
 * declarations aligned with that bootstrap instead of including the browser DOM library.
 */
declare global {
  interface TextDecoder {
    decode(input?: ArrayBufferLike | ArrayBufferView<ArrayBufferLike>): string;
  }

  var TextDecoder: {
    new (): TextDecoder;
  };

  interface URLSearchParams extends Iterable<[string, string]> {
    toString(): string;
  }

  var URLSearchParams: {
    new (
      init?:
        | string
        | URLSearchParams
        | Record<string, string>
        | Iterable<readonly [string, string]>,
    ): URLSearchParams;
  };

  interface FormData {}

  interface Headers {
    append(name: string, value: string): void;
    get(name: string): string | null;
  }

  var Headers: {
    new (): Headers;
  };

  interface Blob {}

  interface BlobPropertyBag {
    readonly type?: string;
  }

  var Blob: {
    new (
      blobParts?: ReadonlyArray<string | Blob | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>>,
      options?: BlobPropertyBag,
    ): Blob;
  };

  interface ResponseInit {
    readonly headers?: Headers;
    readonly status?: number;
  }

  interface Response {
    formData(): Promise<FormData>;
  }

  var Response: {
    new (body?: Blob | null, init?: ResponseInit): Response;
  };
}

export {};
