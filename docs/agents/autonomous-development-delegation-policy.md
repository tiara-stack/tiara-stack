# Autonomous-development delegation policy

Maintainer reference for deciding which phase references should require a
read-only explorer handoff. Keep this policy out of the active skill
references: the phase task body must state the handoff directly, so the main
agent follows the task without recomputing this policy.

A phase reference should require ordinary read-only delegation when it is a
read-only sequence expected to require more than three meaningful command or
tool calls and still needs bounded agentic choices, such as selecting the next
diagnostic query or interpreting a repository result. A deterministic script
with no such choices stays local.

The reason for this boundary is context isolation: the main agent needs the
result of a long command chain, not its intermediate transcript. The phase
reference should state the local script or explorer handoff directly; the main
skill need not expose this threshold or the detailed recipe.

The delegated sequence must be read-only: it requires no repository or
external-state mutation.

Polling uses a deterministic local script for external checks, reviews, and
workflows whenever the state can be reduced to a bounded status query. The
script captures intermediate output and emits only its terminal report. The
main agent gives no progress updates while it runs.

Current phase boundaries:

| Phase | Qualifying handoff | Active instruction file |
| --- | --- | --- |
| Local CodeRabbit loop | None; command and repair stay with the main agent | `references/coderabbit-loop.md` |
| CI babysit | None; diagnosis and repair stay with the main agent | `references/ci-gates.md` |
| GitHub CodeRabbit babysit | None; analysis and repair stay with the main agent | `references/github-review.md` |
| CI polling | Deterministic status script; no explorer | `references/polling-scripts.md` and `scripts/poll.ts` |
| GitHub CodeRabbit polling | Deterministic status/CLI script; no explorer | `references/polling-scripts.md` and `scripts/poll.ts` |
| Commit, submit, implementation, branch setup, and labeling | None; these mutate state | Main skill |

When adding a mode, update this table and the relevant active reference only
after checking the three conditions. The subagent configuration lives in
`.agents/autonomous-development.yaml`.
