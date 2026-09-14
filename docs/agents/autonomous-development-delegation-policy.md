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
result of a long command chain, not its polling output and intermediate
transcript. The phase reference should state the handoff and attach the worker
reference; the main skill need not expose this threshold or the worker's
detailed recipe.

The delegated sequence must be read-only: it requires no repository or
external-state mutation.

Polling is a separate mandatory handoff for any phase that waits on an
external check, review, or workflow. Spawn a dedicated read-only polling
explorer in addition to any ordinary diagnosis or review explorer. It returns
only its terminal report by default. The main agent sends no follow-up
steering or status prompts unless the user asks.

Current phase boundaries:

| Phase | Qualifying handoff | Active instruction file |
| --- | --- | --- |
| Local CodeRabbit loop | None; command and repair stay with the main agent | `references/coderabbit-loop.md` |
| CI babysit | Diagnose logs and likely cause only | `references/ci-gates.md` |
| GitHub CodeRabbit babysit | None; analysis and repair stay with the main agent | `references/github-review.md` |
| CI polling | Check status only; report the terminal result | `references/ci-polling.md` |
| GitHub CodeRabbit polling | Check review status only; report the terminal result | `references/github-review-polling.md` |
| Commit, submit, implementation, branch setup, and labeling | None; these mutate state | Main skill |

When adding a mode, update this table and the relevant active reference only
after checking the three conditions. The subagent configuration lives in
`.agents/autonomous-development.yaml`.
