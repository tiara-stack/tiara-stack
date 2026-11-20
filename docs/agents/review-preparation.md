# TiaraStack review preparation

Use `pnpm review:prep` to run the installed agentic-review core through the
TiaraStack Effect v4 CLI. The wrapper resolves Effect imports from
`packages/developer-launcher`, scopes that resolution to the installed core,
and checks that `source.head` still matches local `HEAD` before and after a
bundle is written.

## Capture immutable evidence

Seal screenshot bytes after the evidence tool produces them. The command also
accepts JSON source snapshots and other evidence files. It prints the receipt
and its reference on stdout.

```sh
SOURCE_RECORD_SHA256="$(sha256sum /path/to/source-record.json | cut -d ' ' -f1)"
pnpm evidence:capture capture \
  --input /path/to/tool-output.png \
  --store /path/to/evidence-store \
  --media-type image/png \
  --run-id run-123 \
  --source-identity-sha256 "$SOURCE_RECORD_SHA256"
```

Use `--input -` to seal bytes piped from a capture tool. Each capture gets a
new ID, including a retake. The publisher writes and flushes a private staging
file under the store, hashes those exact bytes, then publishes the object as
`objects/<sha256>.bin` with an atomic hard link that cannot replace an existing
name. It verifies an existing object before reusing it. It writes the
immutable `receipts/<capture-id>.json` file last. The receipt records the
capture ID, content digest, byte count, media type, and available run and
source identity.

Read evidence through its receipt reference. Verify the receipt and object
before using the object bytes. Set `CAPTURE_ID` and `RECEIPT_SHA256` from the
reference printed by the capture command:

```sh
pnpm evidence:capture verify \
  --store /path/to/evidence-store \
  --capture-id "$CAPTURE_ID" \
  --receipt-sha256 "$RECEIPT_SHA256"
```

The command reports `receipt_reference.path` and `receipt_reference.sha256`.
Consumers should retain both with the capture ID and use the verified receipt
as the evidence identity. An interrupted write may leave an unreferenced
private staging file or unreferenced content-addressed object, but it cannot
produce a receipt until the complete object is published. Readers ignore
staging files and objects without a verified receipt.

For a redacted or annotated copy, publish the transformed bytes as a new
capture and name the verified original receipt:

```sh
pnpm evidence:capture capture \
  --input /path/to/redacted-output.png \
  --store /path/to/evidence-store \
  --media-type image/png \
  --derived-from "$ORIGINAL_CAPTURE_ID:$ORIGINAL_SHA256"
```

Set `ORIGINAL_CAPTURE_ID` from `receipt.capture_id` and `ORIGINAL_SHA256` from
`receipt.sha256`. This is the artifact content digest. The
`receipt_reference.sha256` value is the digest of the receipt file.
The derived receipt records `derived_from`; the original artifact and receipt
remain unchanged. Single-source transformations record their parent in
`derived_from`. Generated finding evidence combines a finding record and its
evidence file, so its receipt records both verified parents in
`derived_from_inputs`.

On Linux with accessible procfs, review output keeps separate compatibility
copies at `artifacts/<sha256>-<label>` for current readers. The copies publish
through a pinned directory handle. If procfs is unavailable, or on another
platform, review plan references point directly to the verified
`objects/<sha256>.bin` file. New review plan references also carry a
`capture_receipt` reference, which identifies the sealed snapshot.

Publication requires staging, objects, and receipts on one local filesystem
that supports atomic hard links and directory sync. The publisher checks the
filesystem device before each link and fails if the directories differ or an
operation fails. New store paths sync each created directory entry through
their nearest existing parent. For a pre-existing store, the publisher syncs
its parent when readable and always syncs the store contents. If the parent
denies read access, the existing root entry's durability remains the store
owner's responsibility. Remote filesystem semantics are unverified. This
workflow does not migrate or rewrite historical evidence or prune captures.

## Produce a reviewer bundle

Use `produce` when canonical TiaraStack records are available. It maps those
records to `review-plan/v1`, writes hash-verified immutable snapshots, and
calls the installed core to prepare one bounded reviewer bundle. Run it once
for each configured axis.

The input is a `tiara-review-input/v1` JSON index. It points to canonical
record files through `{ "label", "path", "sha256" }` references. Paths are
relative to the index directory. Hash each exact file, including its final
newline.

The index names:

- `phase`, a `tiara-review-phase/v1` record with `run_id`, `phase_id`,
  `grant_id`, `handoff_id`, `base`, `head`, `capture_id`, and
  `source_identity_sha256`, and `worker_thread_id`.
- `source`, a frozen `review-source-capture/v1` record. Phase and capture must
  agree on run, base, head, and capture ID. `phase.source_identity_sha256`
  equals the exact source-capture file hash.
- `source_files`, rows of `{ "path", "artifact", "axes?" }`. Each
  non-deleted scoped path needs one captured source file for each axis that
  includes it. Set `axes` to `["spec"]` or `["standards"]` to include a
  file in only that axis. Omit `axes` to include the file in both bundles.
- `reviewers.spec` and `reviewers.standards`, each with the configured
  `review_contract` reference, `configuration` reference, matching axis delta,
  exact scope, required and included coverage, and applicable source references.
  Configuration files use `tiara-reviewer-config/v1` and store the reviewer
  ID, model, and reasoning effort under `reviewer`. The producer reads those
  values from the referenced file and derives the helper's required
  `configuration.label` from its reference.
- `rules`, `tiara-review-rule/v1` records with axis `standards`, artifact
  reference, and optional sections. Standards maps to `correctness_reliability`.
- `reviewers.spec.requirements`, containing raw authoritative requirement
  references. Spec rules are rejected. Spec maps to `spec_conformance`.
- `findings`, references to `tiara-review-finding/v1` records with `id`, own
  axis (`spec` or `standards`), status, raw severity, original reviewer, and
  finding-specific evidence. Status must be `unresolved`, `resolved`,
  `accepted`, or `superseded`. Only unresolved findings enter the bundle, on
  their own axis. The producer snapshots the original severity and complete
  evidence bytes.
- `coverage`, references to `tiara-review-coverage/v1` rows with own axis,
  prior identity, canonical coverage record, and impact evidence. The helper
  may report carry candidates. Workers and coordinators decide semantic carry;
  missing impact evidence never becomes `unaffected`.

The producer collects mapping, scope, coverage, and hash errors before it
creates output. It reports plan size and verified artifact count and bytes, with
the largest input artifacts. The installed core renders the prompt and
coordinator manifest, then reports which shared size limit failed. No evidence
is silently dropped or shortened. The redacted record fixtures are generated
by `packages/developer-launcher/integration-tests/review-producer.integration.test.ts`.

On a size failure, the shared core currently names the exceeded limit but does
not return per-section byte counts. The skills-repo follow-up is to expose
measured manifest and reviewer-input section sizes on success and failure,
using the existing renderer and limits. TiaraStack should keep using that
renderer instead of copying its private formatting logic.

```sh
pnpm review:prep produce \
  --input /path/to/canonical-review-input.json \
  --axis spec_conformance \
  --output /path/to/new-spec-output

pnpm review:prep produce \
  --input /path/to/canonical-review-input.json \
  --axis correctness_reliability \
  --output /path/to/new-standards-output
```

Each output directory contains content-addressed snapshots, a plan named by its
SHA-256, and the shared helper bundle. Output directories are exclusive. The
producer verifies referenced hashes before publication and never replaces
source captures or generated bytes. Keep the two axis bundles separate.

The `bundle` command remains available for an existing `review-plan/v1` input.
Use the producer when canonical records are available.

```sh
pnpm review:prep bundle --input /path/to/review-plan.json \
  --axis correctness_reliability --output /path/to/new-bundle
```

## Other checks

```sh
pnpm review:prep check-grant --input /path/to/grant.json \
  --output /path/to/new-grant-check.json
pnpm review:prep count-starts --input /path/to/native-starts.json \
  --output /path/to/new-start-accounting.json
pnpm review:prep timing --input /path/to/phase-times.json \
  --output /path/to/new-timing-summary.json
pnpm review:prep check-completion \
  --input /path/to/current-phase-completion-check.json \
  --output /path/to/new-completion-check.json
```

`check-completion` binds completion and native delivery records to the current
phase's run, phase, grant, handoff, base, head, capture ID, source identity
hash, and worker. A
previous repair handoff returns `reconcile` for a new resync grant. The command
writes an immutable check result and exits nonzero on reconciliation. It does
not admit phases, send native messages, update quota, or write coordinator
state.

Its input uses `tiara-review-completion-check/v1` and references a
`tiara-review-phase/v1`, `tiara-review-completion/v1`, and
`tiara-native-delivery/v1` record. Every reference carries a SHA-256 hash. The
phase's `source_identity_sha256` is the hash of the exact frozen source-capture
record. Completion and delivery repeat the expected run, phase, grant, handoff,
base, head, capture ID, and source hash. Delivery also names its worker and
native delivery ID. The output uses `tiara-review-phase-completion-check/v1`
with `status: "complete"` or `status: "reconcile"`, per-field predicates, and
the exact completion and delivery hashes.

Before a native review starts, recheck the captured head and referenced files.
The wrapper and shared core do not decide semantic carry acceptance, reserve
quota, mutate coordinator state, launch reviewers, or perform remote actions.
The coordinator applies deduplicated starts to quota under its existing lock.
For shared schema details and limits, read the installed
`agentic-review/references/review-preparation.md`.
