import { Effect, FileSystem } from "effect";
import { makeArgumentError } from "typhoon-core/error";

const maxAggregateUploadBytes = 25n * 1_024n * 1_024n;

export const buildFileUploadFormData = (
  payload: {
    readonly payload: unknown;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly name: string;
      readonly contentType: string;
    }>;
  },
  fs: FileSystem.FileSystem,
  interactionToken?: string,
) =>
  Effect.gen(function* () {
    const fileInfo = yield* Effect.forEach(payload.files, (file) => fs.stat(file.path));
    const aggregateUploadBytes = fileInfo.reduce((total, info) => total + info.size, 0n);
    if (aggregateUploadBytes > maxAggregateUploadBytes) {
      return yield* Effect.fail(makeArgumentError("File uploads must not exceed 25 MiB in total"));
    }

    const formData = new FormData();
    if (interactionToken !== undefined) {
      formData.append("interactionToken", interactionToken);
    }
    formData.append("payload", JSON.stringify(payload.payload));

    yield* Effect.forEach(
      payload.files,
      (file) =>
        Effect.gen(function* () {
          const content = yield* fs.readFile(file.path);
          formData.append(
            "files",
            new File([content as BlobPart], file.name, { type: file.contentType }),
          );
        }),
      { concurrency: 1 },
    );

    return formData;
  });
