#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  publishEvidence,
  readVerifiedEvidence,
  verifyEvidenceReceiptReference,
  type PublishEvidenceInput,
} from "../packages/developer-launcher/src/immutable-evidence.ts";

const optionalString = (name: string) => Flag.string(name).pipe(Flag.optional);
type CaptureOptions = {
  readonly input: string;
  readonly store: string;
  readonly mediaType: Option.Option<string>;
  readonly runId: Option.Option<string>;
  readonly sourceIdentity: Option.Option<string>;
  readonly derivedFrom: Option.Option<string>;
};

const parseDerivedFrom = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const separator = value.indexOf(":");
  if (separator < 1) throw new Error("--derived-from must use capture-id:sha256 format");
  return { captureId: value.slice(0, separator), sha256: value.slice(separator + 1) };
};

const readStdinBytes = () =>
  new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Array<Uint8Array> = [];
    process.stdin.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    process.stdin.once("error", reject);
    process.stdin.once("end", () => {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(output);
    });
  });

const readCaptureBytes = (input: string) =>
  Effect.tryPromise({
    try: () => (input === "-" ? readStdinBytes() : readFile(path.resolve(input))),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const withRunId = (runId: string | undefined): Pick<PublishEvidenceInput, "runId"> =>
  runId === undefined ? {} : { runId };

const withSourceIdentity = (
  sourceIdentitySha256: string | undefined,
): Pick<PublishEvidenceInput, "sourceIdentitySha256"> =>
  sourceIdentitySha256 === undefined ? {} : { sourceIdentitySha256 };

const withDerivedFrom = (
  derivedFrom: PublishEvidenceInput["derivedFrom"],
): Pick<PublishEvidenceInput, "derivedFrom"> => (derivedFrom === undefined ? {} : { derivedFrom });

const publishInput = (options: CaptureOptions, bytes: Uint8Array): PublishEvidenceInput => {
  const runId = Option.getOrUndefined(options.runId);
  const sourceIdentitySha256 = Option.getOrUndefined(options.sourceIdentity);
  const derivedFrom = parseDerivedFrom(Option.getOrUndefined(options.derivedFrom));
  return {
    storeDirectory: path.resolve(options.store),
    bytes,
    mediaType: Option.getOrUndefined(options.mediaType) ?? "application/octet-stream",
    ...withRunId(runId),
    ...withSourceIdentity(sourceIdentitySha256),
    ...withDerivedFrom(derivedFrom),
  };
};

const captureEvidence = (options: CaptureOptions) =>
  Effect.gen(function* () {
    const bytes = yield* readCaptureBytes(options.input);
    const result = yield* publishEvidence(publishInput(options, bytes));
    yield* Console.log(
      JSON.stringify(
        {
          receipt: result.receipt,
          receipt_reference: result.receiptReference,
          artifact_path: result.artifactPath,
        },
        null,
        2,
      ),
    );
  });

const capture = Command.make(
  "capture",
  {
    input: Flag.string("input"),
    store: Flag.string("store"),
    mediaType: optionalString("media-type"),
    runId: optionalString("run-id"),
    sourceIdentity: optionalString("source-identity-sha256"),
    derivedFrom: optionalString("derived-from"),
  },
  captureEvidence,
).pipe(
  Command.withDescription(
    "Seal screenshot, JSON, or other tool output and print its immutable receipt",
  ),
);

const verify = Command.make(
  "verify",
  {
    store: Flag.string("store"),
    captureId: Flag.string("capture-id"),
    receiptSha256: optionalString("receipt-sha256"),
  },
  ({ store, captureId, receiptSha256 }) =>
    Effect.gen(function* () {
      const storeDirectory = path.resolve(store);
      const expectedReceiptSha256 = Option.getOrUndefined(receiptSha256);
      const result =
        expectedReceiptSha256 === undefined
          ? yield* readVerifiedEvidence({ storeDirectory, captureId })
          : yield* verifyEvidenceReceiptReference({
              storeDirectory,
              reference: {
                capture_id: captureId,
                path: `receipts/${captureId}.json`,
                sha256: expectedReceiptSha256,
              },
            });
      yield* Console.log(
        JSON.stringify(
          {
            receipt: result.receipt,
            receipt_reference: result.receiptReference,
            byte_count: result.bytes.byteLength,
          },
          null,
          2,
        ),
      );
    }),
).pipe(Command.withDescription("Verify a receipt and its referenced artifact bytes"));

const command = Command.make("evidence-capture").pipe(
  Command.withDescription("Publish and verify immutable engineering evidence"),
  Command.withSubcommands([capture, verify]),
);

export const main = Command.run(command, { version: "tiara-evidence-capture/v1" }).pipe(
  Effect.provide(NodeServices.layer),
);
if (process.argv[1]?.endsWith("evidence-capture.ts")) NodeRuntime.runMain(main);
