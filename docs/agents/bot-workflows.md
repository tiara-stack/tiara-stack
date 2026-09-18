# Bot workflow guidance

The bot has two separate workflow boundaries. Keep enqueue policy in the HTTP client and keep result observation in the owner-authenticated Zero client.

## Enqueue

Interaction-driven commands and buttons call the contract-specific `enqueue...` method on the injected `SheetWorkflowHttpClient`. `enqueueSheetWorkflow` remains the interaction adapter for acknowledgement, Response Reference issuance, and operation-specific reply text. It is not a second transport client.

Gateway handlers call the same typed client methods with their fixed Service Principal and deterministic invocation ID. The client owns invocation ID generation, the per-attempt timeout, and the selected transport recovery profile. Every attempt keeps the same canonical input, Response Reference, principal, and invocation ID.

Bot callers must not import the generated HTTP client directly, add an `enqueue*Workflow` forwarding function, or wrap a protected enqueue in another transport retry loop. A typed rejection, authorization failure, or invocation conflict stops immediately. An ambiguous transport result remains ambiguous after recovery is exhausted.

## Observation

The saved-message load, saved-message save, and authorization permission check use the owner-authenticated `SheetZeroClient` observation methods. Consume their streams through the shared terminal-result helper. An absent initial row and a Pending row both mean that the observer should keep waiting. A terminal initial snapshot is already complete.

Observation timeout, disconnect, refresh failure, or permanent authorization failure must not enqueue again, mint a new invocation ID, or fall back to periodic HTTP result requests. Accepted work continues independently of the observer. The observer releases its listener and view when it completes, times out, is cancelled, or loses authorization.

## Tests and scope

Protected enqueue tests should construct the real client shape with controlled HTTP and authentication adapters. The local Zero integration proof should cover authenticated HTTP enqueue, synchronized progress and terminal state, owner isolation, reconnect, and cleanup. A forwarding-only test does not prove the policy.

These rules cover bot callers and their shared support. Broader web observer migration, Schedule Hour work, and Development Mode work are outside this change.
