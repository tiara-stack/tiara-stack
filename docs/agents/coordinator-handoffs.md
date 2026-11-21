# Coordinator handoff acceptance

Read this before accepting an inbound T3 worker handoff. The coordinator owns
phase admission and the next action; the worker owns the work granted for that
phase.

## Verify the inbound handoff

1. Read the authoritative current phase and its registered dispatch record from
   coordinator state. Use the exact current run, ticket, phase, grant,
   handoff ID, expected client request ID, coordinator target, worker thread,
   worker phase-start native run, and authorized continuation run IDs. Do not
   derive expected state from the worker's message.
2. Read the coordinator thread and registered worker thread with the native T3
   thread-read operation. Capture bounded readbacks containing the inbound
   message and matching worker response. Preserve the selected native fields
   and payload text exactly; use redacted fixtures only in shared tests and
   examples. Reference each local readback file by its exact SHA-256 in the
   check input.
3. Bind the current phase to its frozen source-capture artifact. For a phase
   that may advance HEAD, capture the resulting source separately and keep the
   original phase source fields unchanged. Set `result_head_policy` to
   `may_advance` only when the dispatch authorizes a repair that can commit.
4. Run the check and read its output:

   ```sh
   pnpm review:prep check-handoff \
     --input /path/to/current-worker-handoff-check.json \
     --output /path/to/new-worker-handoff-check.json
   ```

   Accept the native handoff only when the result has `status: "complete"` and
   an empty `reconciliation` list. A nonzero exit writes the reconciliation
   result when validation reaches reconciliation. Invalid input JSON or schema,
   an unreadable input, or an output create/write failure can exit before a
   result exists. Confirm that this invocation created the output file before
   reading it; otherwise resolve the input or filesystem failure and rerun.
   Output paths are exclusive and must be new.

The `tiara-worker-handoff-check/v1` input references four primary hashed
records, plus the phase source capture and a separate result capture when the
result head advanced:

- `phase`: the current `tiara-review-phase/v1` record.
- `dispatch`: `tiara-worker-dispatch/v1`, including `run_id`, `ticket_id`,
  `phase_id`, `grant_id`, `handoff_id`, `client_request_id`,
  `base`, `head`, `capture_id`, `source_identity_sha256`,
  `coordinator_instance_id`, `coordinator_thread_id`, `worker_thread_id`,
  `phase_start_native_run_id`, `authorized_continuation_native_run_ids`, and
  `result_head_policy` (`same` or `may_advance`). Its phase identities must
  match the current phase record.
- `coordinator_readback`: the native readback for the exact coordinator
  thread. The checker requires one inbound `user_message` whose native message
  ID carries the expected `thread-send:<client_request_id>` suffix, whose
  `sourceThreadId` is the coordinator thread, and whose `senderThreadId` is the
  registered worker.
- `worker_readback`: the native readback for the registered worker thread. Its
  assistant message must contain the exact same payload and have a native
  `runId` registered as the phase start or an authorized continuation. The
  worker message's run ID is distinct from the inbound item's `runId`, which
  belongs to the recipient coordinator thread.

The payload begins with a `TICKET_COORDINATOR v1` envelope. Include `kind`,
`run_id`, `ticket_id`, `worker_id`, `phase`, `grant_id`, `handoff_id`,
`message_id`, and `outcome`. The worker run ID comes from the worker thread's
native assistant-message `runId`, not a new payload field. If the message
includes `actual_phase_start_native_run_id` or
`actual_continuations_observed`, the checker compares those claims with the
dispatch. Native `recentRuns` is the source for any lineage directly visible
in the bounded worker readback; payload claims alone do not establish lineage.
The marker alone never establishes provenance.

Include `source_base`, `source_head`, `source_capture_id`, and
`source_identity_sha256` for the frozen phase source. Include `result_head`,
`result_capture_id`, and `result_source_identity_sha256` for the completed
work. The input's `source_capture` reference must hash to the current phase's
source identity and agree on run, base, head, and capture ID. If the result
head advanced, provide a separate `result_source_capture` reference. It must
agree on the phase run and base, the reported result head and capture ID, and
its exact content hash. This preserves the source contract across authorized
repair commits.

The checker writes only its explicit output file. It does not send messages,
change phase grants, update quota, decide repairs, or set merge readiness.

## Continue after acceptance

A successful check closes the handoff-verification step. It is a phase
checkpoint, not a reason to end coordinator work. Verify any reported checks
and artifacts under their existing owners, then take the next eligible
coordinator action. If no action is eligible, record the concrete blocker and
the event or condition that will allow work to resume. Do not add a scheduler
or acknowledgement callback loop.

## Native evidence limits

T3 thread readback exposes the coordinator thread ID, inbound sender thread ID,
native message ID, exact payload, recipient-side run ID, and the worker
thread's assistant-message run IDs. When the worker's bounded `recentRuns`
includes phase-start or continuation IDs, the checker confirms that
observation. If a run falls outside the returned window, the result records
that lineage observation as unavailable. The current readback does not expose the
separate coordinator instance ID or a dedicated `clientRequestId` field. The
checker therefore verifies the exact coordinator thread and the observed
`thread-send:<client_request_id>` message-ID suffix; it records the missing
instance-ID confirmation as an evidence limitation. If T3 changes these fields
or the message-ID form, keep the check in reconciliation until the adapter is
updated from native API evidence.

The native message ID uses the observed
`message:mcp:<native-caller>:thread-send:<clientRequestId>` shape. Its request
ID suffix binds the readback item to the dispatch request; a separate request
ID property is unavailable. The readbacks are observations, not signed
attestations of repository state.
Hash references preserve the exact bytes checked. A worker-authored statement
does not independently prove its reported checks, source files, or result head;
the coordinator verifies those through the project's existing check and
evidence procedures before admitting another phase.
