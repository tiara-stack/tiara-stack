import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const EvidenceSourceReferenceSchema = Schema.Struct({ capture_id: Schema.String, sha256: Digest });
type DerivedEvidenceSource = { readonly captureId: string; readonly sha256: string };

const EvidenceReceiptSchema = Schema.Struct({
  schema: Schema.Literal("tiara-evidence-receipt/v1"),
  capture_id: Schema.String,
  captured_at: Schema.String,
  sha256: Digest,
  byte_count: Schema.Number,
  media_type: Schema.String,
  artifact: Schema.Struct({ path: Schema.String, sha256: Digest }),
  run_id: Schema.optionalKey(Schema.String),
  source_identity_sha256: Schema.optionalKey(Digest),
  derived_from: Schema.optionalKey(EvidenceSourceReferenceSchema),
  derived_from_inputs: Schema.optionalKey(Schema.Array(EvidenceSourceReferenceSchema)),
});

type EvidenceReceipt = typeof EvidenceReceiptSchema.Type;
export type EvidenceReceiptReference = {
  readonly capture_id: string;
  readonly path: string;
  readonly sha256: string;
};

export type PublishEvidenceInput = {
  readonly storeDirectory: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly runId?: string;
  readonly sourceIdentitySha256?: string;
  readonly derivedFrom?: DerivedEvidenceSource;
  readonly derivedFromInputs?: ReadonlyArray<DerivedEvidenceSource>;
  readonly captureId?: string;
  /** Relative compatibility path. Current callers use `artifacts/<filename>`. */
  readonly convenienceArtifactPath?: string;
};

type PublishedEvidence = {
  readonly receipt: EvidenceReceipt;
  readonly receiptReference: EvidenceReceiptReference;
  readonly artifactPath: string;
  readonly compatibilityArtifactPath?: string;
};

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const isNodeError = (error: unknown, code: string) =>
  Predicate.isError(error) && Predicate.hasProperty(error, "code") && error.code === code;

const syncDirectory = async (directory: string) => {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectoryChainTo = async (directory: string, stopAt: string) => {
  let current = path.resolve(directory);
  const stop = path.resolve(stopAt);
  while (true) {
    await syncDirectory(current);
    if (current === stop) return;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot reach directory sync boundary ${stop}`);
    }
    current = parent;
  }
};

const isPathWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const findExistingAncestor = async (directory: string): Promise<string> => {
  let current = path.resolve(directory);
  while (true) {
    try {
      const metadata = await stat(current);
      if (!metadata.isDirectory()) throw new Error(`Store ancestor is not a directory: ${current}`);
      return realpath(current);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
};

const syncExistingStoreParentWhenReadable = async (root: string) => {
  try {
    await syncDirectory(path.dirname(root));
  } catch (error) {
    if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) return;
    throw error;
  }
};

const writeAndFlush = async (filePath: string, bytes: Uint8Array) => {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const flushFile = async (filePath: string) => {
  const handle = await open(filePath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const assertSameFilesystem = async (stagedPath: string, destinationDirectory: string) => {
  const [staged, destination] = await Promise.all([stat(stagedPath), stat(destinationDirectory)]);
  if (staged.dev !== destination.dev) {
    throw new Error(
      `Evidence staging and publication directories are on different filesystems: ${destinationDirectory}`,
    );
  }
};

const verifyObject = async (objectPath: string, sha256: string, byteCount: number) => {
  const metadata = await lstat(objectPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Immutable evidence path is not a regular file: ${objectPath}`);
  }
  const bytes = await readFile(objectPath);
  const found = digest(bytes);
  if (found !== sha256 || bytes.byteLength !== byteCount) {
    throw new Error(
      `Immutable evidence object is corrupt at ${objectPath}: expected ${sha256}/${byteCount}, found ${found}/${bytes.byteLength}`,
    );
  }
};

const publishFileWithoutReplacement = async (
  stagedPath: string,
  targetPath: string,
  targetDirectory: string,
) => {
  await assertSameFilesystem(stagedPath, targetDirectory);
  try {
    await link(stagedPath, targetPath);
    await syncDirectory(targetDirectory);
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
};

const descriptorDirectoryRoots: Readonly<Record<string, string>> = { linux: "/proc/self/fd" };
const directoryOpenFlags =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const descriptorDirectoryPath = (fileDescriptor: number) => {
  const root = descriptorDirectoryRoots[process.platform];
  if (root === undefined) {
    throw new Error(`Atomic convenience publication is unsupported on ${process.platform}`);
  }
  return path.join(root, String(fileDescriptor));
};

const hasAccessibleDescriptorDirectoryRoot = async (evidenceRoot: string) => {
  if (descriptorDirectoryRoots[process.platform] === undefined) return false;
  const evidenceHandle = await open(evidenceRoot, directoryOpenFlags);
  try {
    try {
      const descriptorHandle = await open(
        descriptorDirectoryPath(evidenceHandle.fd),
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      );
      await descriptorHandle.close();
      return true;
    } catch (error) {
      if (
        isNodeError(error, "ENOENT") ||
        isNodeError(error, "EACCES") ||
        isNodeError(error, "EPERM") ||
        isNodeError(error, "ENOTDIR") ||
        isNodeError(error, "ELOOP")
      ) {
        return false;
      }
      throw error;
    }
  } finally {
    await evidenceHandle.close();
  }
};

const openArtifactDirectory = async (root: string) => {
  const rootHandle = await open(root, directoryOpenFlags);
  try {
    const artifactDirectoryPath = path.join(descriptorDirectoryPath(rootHandle.fd), "artifacts");
    try {
      await mkdir(artifactDirectoryPath, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const metadata = await lstat(artifactDirectoryPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `Convenience artifact path is not a regular directory: ${artifactDirectoryPath}`,
      );
    }
    await rootHandle.sync();
    const artifactHandle = await open(artifactDirectoryPath, directoryOpenFlags);
    return { rootHandle, artifactHandle };
  } catch (error) {
    await rootHandle.close();
    throw error;
  }
};

const assertSameFilesystemHandle = async (
  stagedPath: string,
  directoryHandle: Awaited<ReturnType<typeof open>>,
) => {
  const [staged, directory] = await Promise.all([stat(stagedPath), directoryHandle.stat()]);
  if (staged.dev !== directory.dev) {
    throw new Error("Evidence staging and convenience directories are on different filesystems");
  }
};

const publishFileAtDirectoryWithoutReplacement = async (
  stagedPath: string,
  targetPath: string,
  directoryHandle: Awaited<ReturnType<typeof open>>,
) => {
  await assertSameFilesystemHandle(stagedPath, directoryHandle);
  try {
    await link(stagedPath, targetPath);
    await directoryHandle.sync();
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
};

const ensureStore = async (storeDirectory: string) => {
  const requestedRoot = path.resolve(storeDirectory);
  let existingAncestor: string | undefined;
  let rootExisted = true;
  try {
    const metadata = await stat(requestedRoot);
    if (!metadata.isDirectory())
      throw new Error(`Evidence store is not a directory: ${requestedRoot}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    rootExisted = false;
    existingAncestor = await findExistingAncestor(path.dirname(requestedRoot));
    await syncDirectory(existingAncestor);
  }
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(requestedRoot);
  const stagingDirectory = path.join(root, ".staging");
  const objectDirectory = path.join(root, "objects");
  const receiptDirectory = path.join(root, "receipts");
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await chmod(stagingDirectory, 0o700);
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  if (rootExisted) {
    await syncExistingStoreParentWhenReadable(root);
  } else {
    if (existingAncestor === undefined) throw new Error("Evidence store ancestor was not resolved");
    await syncDirectoryChainTo(path.dirname(root), existingAncestor);
  }
  await syncDirectory(root);
  return { root, stagingDirectory, objectDirectory, receiptDirectory };
};

type StagedArtifact = {
  readonly sha256: string;
  readonly byteCount: number;
};

const requireText = (value: string, label: string) => {
  if (value.trim() === "") throw new Error(`${label} must be a non-empty string`);
};

const validateSourceIdentity = (value: string | undefined) => {
  if (value !== undefined && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("source identity must be a lowercase SHA-256 digest");
  }
};

const resolveCaptureId = (value: string | undefined) => {
  const captureId = value ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/u.test(captureId))
    throw new Error("capture ID contains unsupported characters");
  return captureId;
};

const validatePublishInput = (input: PublishEvidenceInput) => {
  requireText(input.mediaType, "media type");
  if (input.runId !== undefined) requireText(input.runId, "run ID");
  validateSourceIdentity(input.sourceIdentitySha256);
  if (input.derivedFrom !== undefined && input.derivedFromInputs !== undefined) {
    throw new Error("Use either derivedFrom or derivedFromInputs, not both");
  }
  if (input.derivedFromInputs !== undefined && input.derivedFromInputs.length < 2) {
    throw new Error("derivedFromInputs must contain at least two verified sources");
  }
  return resolveCaptureId(input.captureId);
};

const verifyDerivedSource = async (input: PublishEvidenceInput) => {
  const sources =
    input.derivedFromInputs ?? (input.derivedFrom === undefined ? [] : [input.derivedFrom]);
  for (const source of sources) {
    const original = await readVerifiedReceiptNode(input.storeDirectory, source.captureId);
    if (original.receipt.sha256 !== source.sha256) {
      throw new Error(`Derived evidence source digest mismatch for ${source.captureId}`);
    }
  }
};

const writeStagedArtifact = async (
  stagedPath: string,
  bytes: Uint8Array,
): Promise<StagedArtifact> => {
  await writeAndFlush(stagedPath, bytes);
  const stagedBytes = await readFile(stagedPath);
  return {
    sha256: digest(stagedBytes),
    byteCount: (await stat(stagedPath)).size,
  };
};

const createReceipt = (
  input: PublishEvidenceInput,
  captureId: string,
  artifact: StagedArtifact,
) => {
  const value: Record<string, unknown> = {
    schema: "tiara-evidence-receipt/v1",
    capture_id: captureId,
    captured_at: new Date().toISOString(),
    sha256: artifact.sha256,
    byte_count: artifact.byteCount,
    media_type: input.mediaType,
    artifact: { path: `objects/${artifact.sha256}.bin`, sha256: artifact.sha256 },
  };
  if (input.runId !== undefined) value.run_id = input.runId;
  if (input.sourceIdentitySha256 !== undefined) {
    value.source_identity_sha256 = input.sourceIdentitySha256;
  }
  if (input.derivedFrom !== undefined) {
    value.derived_from = {
      capture_id: input.derivedFrom.captureId,
      sha256: input.derivedFrom.sha256,
    };
  }
  if (input.derivedFromInputs !== undefined) {
    value.derived_from_inputs = input.derivedFromInputs.map((source) => ({
      capture_id: source.captureId,
      sha256: source.sha256,
    }));
  }
  return Schema.decodeUnknownSync(EvidenceReceiptSchema)(value);
};

const publishReceipt = async (input: {
  readonly storeRoot: string;
  readonly receiptDirectory: string;
  readonly stagedReceiptPath: string;
  readonly receipt: EvidenceReceipt;
  readonly captureId: string;
}): Promise<EvidenceReceiptReference> => {
  const receiptBytes = jsonBytes(input.receipt);
  await writeAndFlush(input.stagedReceiptPath, receiptBytes);
  const receiptPath = path.join(input.receiptDirectory, `${input.captureId}.json`);
  const inserted = await publishFileWithoutReplacement(
    input.stagedReceiptPath,
    receiptPath,
    input.receiptDirectory,
  );
  if (!inserted) throw new Error(`Evidence receipt already exists for capture ${input.captureId}`);
  return {
    capture_id: input.captureId,
    path: path.relative(input.storeRoot, receiptPath),
    sha256: digest(receiptBytes),
  };
};

const conveniencePathParts = (root: string, target: string) => {
  if (!isPathWithin(root, target)) {
    throw new Error("Convenience artifact path must stay inside the evidence store");
  }
  const parts = path.relative(root, target).split(path.sep);
  if (parts.length !== 2 || parts[0] !== "artifacts" || parts[1] === undefined || parts[1] === "") {
    throw new Error("Convenience artifact path must use artifacts/<filename>");
  }
  return parts[1];
};

const writeConvenienceCopy = async (
  root: string,
  stagingDirectory: string,
  relativePath: string,
  objectPath: string,
  sha256: string,
  byteCount: number,
) => {
  const target = path.resolve(root, relativePath);
  const fileName = conveniencePathParts(root, target);
  const directoryHandles = await openArtifactDirectory(root);
  const stagedCopyPath = path.join(stagingDirectory, `${randomUUID()}.convenience`);
  try {
    await copyFile(objectPath, stagedCopyPath, constants.COPYFILE_EXCL);
    await flushFile(stagedCopyPath);
    const targetPath = path.join(
      descriptorDirectoryPath(directoryHandles.artifactHandle.fd),
      fileName,
    );
    const inserted = await publishFileAtDirectoryWithoutReplacement(
      stagedCopyPath,
      targetPath,
      directoryHandles.artifactHandle,
    );
    if (!inserted) {
      await verifyObject(targetPath, sha256, byteCount);
      await directoryHandles.artifactHandle.sync();
    }
  } finally {
    await Promise.all([
      rm(stagedCopyPath, { force: true }),
      directoryHandles.artifactHandle.close(),
      directoryHandles.rootHandle.close(),
    ]);
  }
};

const readVerifiedReceiptNode = async (
  storeDirectory: string,
  captureId: string,
): Promise<{
  receipt: EvidenceReceipt;
  receiptReference: EvidenceReceiptReference;
  bytes: Uint8Array;
}> => {
  if (!/^[a-zA-Z0-9_-]+$/u.test(captureId))
    throw new Error("capture ID contains unsupported characters");
  const root = path.resolve(storeDirectory);
  const receiptDirectory = path.join(root, "receipts");
  const receiptPath = path.join(receiptDirectory, `${captureId}.json`);
  const metadata = await lstat(receiptPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Evidence receipt path is not a regular file: ${receiptPath}`);
  }
  const receiptBytes = await readFile(receiptPath);
  const decoded: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes),
  );
  const receipt = Schema.decodeUnknownSync(EvidenceReceiptSchema)(decoded);
  if (receipt.capture_id !== captureId)
    throw new Error(`Receipt capture ID mismatch at ${receiptPath}`);
  if (receipt.artifact.path !== `objects/${receipt.sha256}.bin`) {
    throw new Error(`Receipt artifact path is not content-addressed: ${receipt.artifact.path}`);
  }
  const bytes = await readFile(path.join(root, receipt.artifact.path));
  const found = digest(bytes);
  if (
    found !== receipt.sha256 ||
    found !== receipt.artifact.sha256 ||
    bytes.byteLength !== receipt.byte_count
  ) {
    throw new Error(
      `Evidence verification failed for capture ${captureId}: expected ${receipt.sha256}/${receipt.byte_count}, found ${found}/${bytes.byteLength}`,
    );
  }
  return {
    receipt,
    receiptReference: {
      capture_id: captureId,
      path: path.relative(root, receiptPath),
      sha256: digest(receiptBytes),
    },
    bytes,
  };
};

const publishEvidenceNode = async (input: PublishEvidenceInput): Promise<PublishedEvidence> => {
  const captureId = validatePublishInput(input);
  await verifyDerivedSource(input);
  const { root, stagingDirectory, objectDirectory, receiptDirectory } = await ensureStore(
    input.storeDirectory,
  );
  const stagedArtifactPath = path.join(stagingDirectory, `${randomUUID()}.artifact`);
  const stagedReceiptPath = path.join(stagingDirectory, `${randomUUID()}.receipt`);
  try {
    const artifact = await writeStagedArtifact(stagedArtifactPath, input.bytes);
    const objectPath = path.join(objectDirectory, `${artifact.sha256}.bin`);
    const inserted = await publishFileWithoutReplacement(
      stagedArtifactPath,
      objectPath,
      objectDirectory,
    );
    if (!inserted) {
      await verifyObject(objectPath, artifact.sha256, artifact.byteCount);
      await syncDirectory(objectDirectory);
    }
    let compatibilityArtifactPath: string | undefined;
    if (input.convenienceArtifactPath !== undefined) {
      const target = path.resolve(root, input.convenienceArtifactPath);
      conveniencePathParts(root, target);
    }
    if (input.convenienceArtifactPath !== undefined) {
      if (await hasAccessibleDescriptorDirectoryRoot(root)) {
        await writeConvenienceCopy(
          root,
          stagingDirectory,
          input.convenienceArtifactPath,
          objectPath,
          artifact.sha256,
          artifact.byteCount,
        );
        compatibilityArtifactPath = input.convenienceArtifactPath;
      }
    }
    const receipt = createReceipt(input, captureId, artifact);
    const receiptReference = await publishReceipt({
      storeRoot: root,
      receiptDirectory,
      stagedReceiptPath,
      receipt,
      captureId,
    });
    return {
      receipt,
      receiptReference,
      artifactPath: path.relative(root, objectPath),
      ...(compatibilityArtifactPath === undefined ? {} : { compatibilityArtifactPath }),
    };
  } finally {
    await Promise.all([
      rm(stagedArtifactPath, { force: true }),
      rm(stagedReceiptPath, { force: true }),
    ]);
  }
};

export const publishEvidence = (input: PublishEvidenceInput) => {
  const bytes = Uint8Array.from(input.bytes);
  const derivedFrom =
    input.derivedFrom === undefined
      ? undefined
      : { captureId: input.derivedFrom.captureId, sha256: input.derivedFrom.sha256 };
  const derivedFromInputs = input.derivedFromInputs?.map((source) => ({
    captureId: source.captureId,
    sha256: source.sha256,
  }));
  const snapshot: PublishEvidenceInput = {
    ...input,
    bytes,
    ...(derivedFrom === undefined ? {} : { derivedFrom }),
    ...(derivedFromInputs === undefined ? {} : { derivedFromInputs }),
  };
  return Effect.tryPromise({
    try: () => publishEvidenceNode(snapshot),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
};

export const readVerifiedEvidence = (input: { storeDirectory: string; captureId: string }) =>
  Effect.tryPromise({
    try: () => readVerifiedReceiptNode(input.storeDirectory, input.captureId),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const verifyEvidenceReceiptReference = (input: {
  readonly storeDirectory: string;
  readonly reference: EvidenceReceiptReference;
}) =>
  readVerifiedEvidence({
    storeDirectory: input.storeDirectory,
    captureId: input.reference.capture_id,
  }).pipe(
    Effect.flatMap((verified) =>
      verified.receiptReference.path === input.reference.path &&
      verified.receiptReference.sha256 === input.reference.sha256
        ? Effect.succeed(verified)
        : Effect.fail(
            new Error(`Evidence receipt reference mismatch for ${input.reference.capture_id}`),
          ),
    ),
  );
