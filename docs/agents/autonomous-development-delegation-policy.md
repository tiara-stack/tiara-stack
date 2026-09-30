# Autonomous-development delegation policy

Maintainer reference for deciding which phase references should require a
read-only explorer handoff. Keep this policy out of active workflow references:
the phase task body must state the handoff directly, so the main agent follows
the task without recomputing this policy.

A phase reference should require ordinary read-only delegation when it is a
read-only sequence expected to require more than three meaningful command or
tool calls and still needs bounded agentic choices, such as selecting the next
diagnostic query or interpreting a repository result. A deterministic script
with no such choices stays local.

The reason for this boundary is context isolation: the main agent needs the
result of a long command chain, not its intermediate transcript. The phase
reference should state the local script or explorer handoff directly; the main
workflow need not expose this threshold or the detailed recipe.

The delegated sequence must be read-only: it requires no repository or
external-state mutation.

For a selected workflow that provides a deterministic local poller, use it for
bounded status checks and have it emit only its terminal report. Keep
intermediate output quiet while it runs.

## Current implementation

The repo-local skill and polling script were removed. This document records the
read-only delegation boundary, not phase-specific execution steps. Keep active
workflow instructions with the selected workflow's own documentation.
