# Sheet System

The sheet system coordinates user- and service-initiated operations across shared workspace state, spreadsheets, and messaging platforms.

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

## Durable execution

**Workflow Definition**:
A published business intent whose durable control flow coordinates actions and produces a typed outcome.
_Avoid_: Generic workflow name, background endpoint

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
