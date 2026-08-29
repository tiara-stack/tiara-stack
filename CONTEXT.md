# Sheet System

The sheet system coordinates user- and service-initiated operations across shared workspace state, spreadsheets, and messaging platforms.

## Workspace configuration

**Workspace Configuration**:
The settings that control sheet-backed behavior for one workspace, independently of the web or bot surface used to read and change them.
_Avoid_: Bot configuration, web configuration page

**Configuration Source**:
The one authoritative source selected for the settings historically owned by the Legacy Settings Tab: the `legacy` Legacy Settings Tab or the `owned` Web Configuration. The inactive source may be retained for rollback, but the sources are never merged or dual-written.
_Avoid_: Rollout Gate, feature flag, fallback chain

**Owned Configuration Source**:
The Configuration Source whose values come from the system-owned Web Configuration and whose authority is anchored to one active Web Configuration Version.
_Avoid_: Web-only source, database source

**Legacy Source Binding**:
The association between the legacy Configuration Source and the stable spreadsheet-tab identity discovered for `Thee's Sheet Settings`, with an explicit unresolved bootstrap state before discovery and the historical title and verified header layout retained as compatibility metadata after binding.
_Avoid_: Title-only lookup, guessed settings tab

**Legacy Settings Tab**:
The Google Sheets tab named `Thee's Sheet Settings` when it acts as a Configuration Source.
_Avoid_: Config sheet, settings sheet

**Web Configuration**:
The system-owned representation of the settings historically owned by the Legacy Settings Tab, shared by authorized web and bot configuration surfaces.
_Avoid_: Mirrored sheet configuration, web-only configuration

**Web Configuration Version**:
A complete, self-contained snapshot of Web Configuration that can be selected as the active web source or retained for rollback; it is not a partial overlay on another source or version.
_Avoid_: Config patch, field override

**Configuration Revision**:
An immutable workspace-specific Web Configuration Version identified for activation, comparison, or rollback; editing produces a new revision rather than mutating one.
_Avoid_: Save attempt, schema version

**Web Configuration Draft**:
The mutable workspace-scoped working copy used to assemble and validate a future Configuration Revision; it is never an authoritative Configuration Source.
_Avoid_: Active revision, per-surface config

**Configuration Schema Version**:
The version of the Web Configuration shape and validation contract, independent of any workspace's Configuration Revision.
_Avoid_: Deployment version, active revision

**Configuration Field**:
A semantically stable named value in a Web Configuration Version whose identity is independent of Legacy Settings Tab labels, columns, and cell positions.
_Avoid_: Settings cell, column mapping

**Canonical Configuration Key**:
The stable semantic key used to identify a Configuration Group or Configuration Field in Web Configuration, independent of its presentation label or legacy location.
_Avoid_: Column key, display label

**Configuration Entry**:
An ordered repeated record in a Web Configuration Version, such as a team, schedule, or runner entry, identified by a stable identity that persists across revisions rather than its legacy row position.
_Avoid_: Config row, settings row

**Configuration Group**:
One of the five semantic sections of Web Configuration: user ranges, team configurations, event information, schedule configurations, or runner configurations.
_Avoid_: Settings block, tab section

**Note Range**:
A Sheet Column Range on a schedule Configuration Entry used by sheet formulas to locate notes associated with that schedule.
_Avoid_: Note metadata, draft range

**Contiguous Sheet Range**:
A single rectangular spreadsheet selection identified by a stable sheet identity and numeric coordinates; its tab-qualified A1 notation is a derived presentation. Sheet cell, column-range, and rectangle-range values are its geometric refinements.
_Avoid_: A1 string identity, named-range composition

**Sheet Cell Reference**:
A Contiguous Sheet Range refined to exactly one cell, identified by a stable sheet identity and one row and column coordinate.
_Avoid_: One-cell A1 range

**Sheet Column Range**:
A Contiguous Sheet Range refined to exactly one column and one or more rows.
_Avoid_: Column label, open-ended column range

**Sheet Rectangle Range**:
A non-empty rectangular Contiguous Sheet Range used where a field may span multiple columns and rows.
_Avoid_: Whole-sheet range, open-ended grid

**Sheet Reference**:
A stable spreadsheet-tab identity represented by its `sheetId`, with the current tab title resolved from fresh metadata.
_Avoid_: Tab title identity, sheet name key

**Local Sheet Range**:
A geometric range whose coordinates are interpreted against the parent Configuration Entry's Sheet Reference rather than carrying a second sheet identity.
_Avoid_: Cross-tab local range, qualified A1 string

**Spreadsheet Reference**:
The workspace-level identity of the single Google spreadsheet to which its Sheet References and configuration ranges belong.
_Avoid_: Sheet ID, tab reference

**Spreadsheet Binding**:
The association between a Web Configuration Version and the workspace's Spreadsheet Reference against which its tab identities and coordinates were authored.
_Avoid_: Implicit spreadsheet, retargeted range

**Sheet Snapshot**:
A bounded read-only observation of a Spreadsheet Reference's current tab metadata and one selected rectangular portion of a Sheet Reference at one observation time. The selected rectangle is defined separately from sparse cell presence by zero-based half-open bounds: `startRow` and `startColumn` are inclusive, while `endRow` and `endColumn` are exclusive, covering `[startRow, endRow) × [startColumn, endColumn)`. Its cells are represented sparsely at absolute zero-based coordinates. Formula-derived and user-entered cells retain their visible `formattedValue`; raw formulas and raw user-entered values are omitted. Included effective formatting is limited to text color, background color, and the `bold`, `italic`, `underline`, and `strikethrough` text flags.
_Avoid_: Whole-sheet export, live spreadsheet view

**Unresolved Sheet Range**:
A Contiguous Sheet Range whose stable sheet identity is missing or whose coordinates are outside the fresh sheet extent, so it remains visible for repair but cannot satisfy configuration validation.
_Avoid_: Deleted A1 string, stale display text

**Derived Range Notation**:
The current tab-qualified A1 presentation generated from a Sheet Reference and range coordinates for display or a Google request; it is not persisted range identity.
_Avoid_: Stored A1 identity, title-bound reference

**Open-Ended Sheet Range**:
A Contiguous Sheet Range with a finite starting row and finite column bounds whose row extent continues to the current sheet end; it preserves legacy growth semantics while reads remain application-bounded.
_Avoid_: Whole-sheet read, unbounded API request

**Typed Configuration Value**:
A Configuration Field value validated according to its semantic type and field contract, including scalar, list, enum, sentinel, cell-reference, and Contiguous Sheet Range values.
_Avoid_: Legacy cell text, untyped setting

**Event Start Instant**:
The canonical UTC moment at which the workspace event begins; Legacy Settings Tab epoch seconds and formula results are import encodings, not the Web Configuration value.
_Avoid_: Start Time cell, event day zero

**Configuration Validity**:
Whether a Web Configuration Version satisfies its field schemas and cross-field invariants well enough to serve as the active web source; an incomplete editable version is not thereby an active source.
_Avoid_: Parse success, best-effort configuration

**Runner Availability**:
The normalized, sorted, non-overlapping union of inclusive event-hour intervals associated with one runner identity.
_Avoid_: Runner hour text, duplicate availability rows

## Identity and authorization

**Effective Principal**:
The authenticated user or service whose permissions are evaluated and who owns the resulting operation.
_Avoid_: Caller identity, delegated caller

**User Principal**:
An effective principal representing a person, identified by the system user and optionally associated with a Discord account.
_Avoid_: Discord user, account user

**Service Principal**:
An effective principal representing an autonomous trusted service rather than a person.
_Avoid_: Service user, sentinel user

**Actor Provenance**:
The service that acted for an effective principal, retained for attribution without granting or changing the principal's authority.
_Avoid_: Delegated identity, impersonated user

**Discord Account**:
An optional Discord identity associated with a user principal; it is not the user's platform-independent identity.
_Avoid_: User ID

**Workspace Capabilities**:
The permissions an effective principal currently holds in a workspace, derived from messaging-platform membership and roles, configured monitor roles, and application ownership.
_Avoid_: Token permissions, delegated permissions

**Authorization Decision**:
The allow or deny result of applying a versioned operation policy to an effective principal and the current relevant capabilities.
_Avoid_: Permission snapshot, scope check

**Audit Attribution**:
The record of both the effective principal whose authority was used and any service actor that performed the operation for that principal.
_Avoid_: Caller ID, impersonation record

**Sheet Configuration Audit Record**:
An immutable Workspace-scoped record for a persisted Sheet Configuration mutation or lifecycle attempt. It retains attribution, outcome, configuration lineage, and transition evidence without retaining configuration values or sheet cell contents.
_Avoid_: Configuration history, snapshot log

## Migration and rollout

**Production Cell**:
The single shared-state production environment containing one authoritative Postgres/Zero state plane, one Discord gateway owner, and one autonomous-trigger ownership set while legacy and replacement paths may coexist.
_Avoid_: Parallel production stack, blue/green environment

**Rollout Gate**:
An audited deployment control that selects exactly one execution path for a future invocation at caller-and-intent granularity, optionally limited to a principal or installation cohort. It never reroutes work that has already been accepted.
_Avoid_: Product feature flag, percentage traffic split

**Rollout Gate Control**:
The authoritative decision record used by a Rollout Gate to select one Execution Path for future invocations within a defined caller-and-intent scope.
_Avoid_: Feature flag, traffic split, deployment rollback

**Canary Hold**:
The former fixed observation window after functional canary evidence. It is not a required step in the expedited rollout. Functional evidence comes from terminal Workflow Run outcomes and required Delivery Receipts; a no-match window is health evidence only, not functional evidence.
_Avoid_: Request hold, workflow timeout, command soak

**Settlement Barrier**:
An event-based rollout checkpoint. It clears only when accepted replacement runs are terminal, Action Deadlines are respected, no ambiguous or unresolved delivery, duplicate effect, or System Failure remains, and the Production Cell is healthy. Autonomous triggers additionally need two successful scheduled cycles unless a safe synthetic cycle is approved.
_Avoid_: Fixed canary hold, request hold, workflow timeout

**Execution Path**:
The one legacy or replacement path selected for a future invocation by a Rollout Gate. The selected path stays with the invocation after acceptance.
_Avoid_: Fallback retry, dual execution

**Rollout Gate Decision**:
The contract record returned for a Rollout Gate evaluation. It contains only the gate key, revision, match result, selected Execution Path, and reason: `gateKey`, `revision`, `matched`, `executionPath`, and `reason`.
_Avoid_: Request log, permission decision

**Rollout Gate Control Change Audit Record**:
The persisted audit record for a Rollout Gate Control change. It records the evidence URL, the `changed_by` Effective Principal that changed the control, and Actor Provenance. Its `effective_principal_key` identifies the target scope.
_Avoid_: Rollout Gate Decision, request log

**Deletion Gate**:
An evidence-backed checkpoint that permits irreversible legacy cleanup only after the replacement scenarios pass, the required soak completes, legacy traffic reaches zero, and legacy durable work is fully drained.
_Avoid_: Deployment completion, unused-code assumption

**Legacy Quarantine**:
The reversible interval after the deletion gate when legacy workloads are scaled to zero and disconnected but their manifests, images, and credentials remain recoverable for a bounded rollback window.
_Avoid_: Hard deletion, ordinary rollout soak

## Durable execution

**Autonomous Trigger**:
A timer or external event that starts service-owned durable work under a stable invocation identity without performing business side effects itself.
_Avoid_: Background job, cron worker

**Sweep Workflow**:
A service-owned workflow that discovers currently eligible domain targets and starts independently durable work for each stable target.
_Avoid_: Cron task, polling loop

**Workflow Contract**:
A published, transport-neutral declaration of a business intent, including its identity, version, input, success, Declared Failure, and authorization-policy metadata.
_Avoid_: Workflow API, workflow DTO

**Workflow Definition**:
The server-only durable control flow that implements one Workflow Contract through pinned Durable Actions and produces its typed outcome.
_Avoid_: Workflow Contract, workflow handler

**Durable Action**:
The smallest independently retryable side-effect boundary that is idempotent or can reconcile an ambiguous outcome. Pure calculation and orchestration are not durable actions.
_Avoid_: Entire workflow handler, arbitrary HTTP call

**Response Reference**:
An opaque, non-secret handle that lets a workflow address a pending messaging-platform response without persisting platform credentials or interaction tokens.
_Avoid_: Interaction token, Discord credential

**Delivery Key**:
A stable identity for one intended messaging-platform write, used to return the original receipt instead of repeating the write when an action is replayed.
_Avoid_: Request ID, retry attempt ID

**Delivery Receipt**:
The stable result of a messaging-platform write, containing the resource identity and outcome needed by later workflow actions without exposing credentials.
_Avoid_: Raw Discord response, interaction token

**Declared Failure**:
A typed terminal outcome expected by a workflow definition, such as invalid domain state, authorization loss, missing configuration, or rejected input.
_Avoid_: Exception, system error

**Ambiguous Outcome**:
An action outcome where the caller did not receive confirmation and therefore cannot know whether an external effect committed without reconciliation.
_Avoid_: Ordinary transient failure, definite failure

**System Failure**:
A terminal execution failure outside a workflow definition's declared business outcomes, exposing only a stable public classification while retaining operational detail privately.
_Avoid_: Declared failure, raw defect

**Action Key**:
The stable identity of one logical action within a workflow invocation, unchanged across retries and derived from stable step or domain-item identity.
_Avoid_: Retry attempt ID, array index

**Idempotency Strategy**:
An action's declared method for making replay safe: a provider-native key, deterministic reconciliation, a domain marker, or refusal to repeat an ambiguous write.
_Avoid_: Best-effort deduplication, blanket retry

**Attempt Timeout**:
The maximum duration of one provider call within a durable action.
_Avoid_: Workflow timeout, business expiry

**Action Deadline**:
The maximum elapsed durable time allowed for all attempts, reconciliation, and backoff belonging to one action.
_Avoid_: Workflow lifetime, process timeout

**Business Expiry**:
An explicit domain deadline after which a workflow's intended business outcome is no longer valid. It is part of the workflow contract rather than a generic runtime limit.
_Avoid_: Run timeout, stale-run alert

**Commit Point**:
The point after which a workflow's authoritative business result must be preserved and subsequent failures require forward recovery rather than rollback.
_Avoid_: Workflow completion, message delivery

**Provisional Effect**:
An externally visible effect created before the commit point that may be safely cleaned up or replaced if the workflow cannot commit.
_Avoid_: Authoritative domain state, committed result

**Recovery Required**:
A durable condition indicating that the authoritative business result is preserved but one or more required post-commit effects still need reconciliation or operator action.
_Avoid_: Rolled back, generic workflow failure

**Terminal Outcome**:
The immutable typed success or failure recorded when a workflow invocation can no longer return to pending execution.
_Avoid_: Latest status, mutable result

**Acknowledgement**:
An owner-scoped record that a user has removed a workflow's terminal outcome from active attention while retaining that outcome in recent history.
_Avoid_: Deletion, read receipt

**Completion Policy**:
A workflow definition's rule for combining independently durable target outcomes, either requiring every target or explicitly collecting partial results.
_Avoid_: Accidental fail-fast behavior, implicit best effort

**Target Disposition**:
The typed success or failure recorded for one stable domain target within a multi-target workflow.
_Avoid_: Array-position result, log-only failure

**Concurrency Policy**:
A workflow definition's declared rule for simultaneous invocations affecting the same canonical domain resource: allow independent effects, serialize mutation, or reject a stale concurrent intent.
_Avoid_: Caller-supplied lock key, accidental last-write-wins

**Action Version**:
The pinned behavior version of a durable action, changed when its observable side effects, schemas, replay safety, reconciliation, compensation, or failure policy changes.
_Avoid_: Deployment version, retry attempt

**Recovery Command**:
An audited operator instruction to reconcile, resume, or run a registered compensation for a specific durable invocation without altering its established business meaning.
_Avoid_: Arbitrary workflow event, public retry

**Causation Link**:
A reference from a new invocation to the earlier terminal invocation whose outcome caused the new business attempt.
_Avoid_: Reopened run, reused invocation ID
