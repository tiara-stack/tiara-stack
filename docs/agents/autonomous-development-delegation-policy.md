# Autonomous-development delegation policy

Maintainer reference for deciding whether a future autonomous-development mode
should recommend a read-only explorer handoff. Keep this policy out of the
active skill references so normal task execution does not ask the agent to
recompute the policy.

A mode or subtask qualifies for ordinary read-only delegation only when all
three conditions hold:

1. It requires no repository or external-state mutation.
2. It is expected to require more than three meaningful command or tool calls.
3. It requires code or repository-behavior understanding and cannot be reduced
   to a deterministic Bash script.

Polling is a separate mandatory handoff for any phase that waits on an
external check, review, or workflow. Spawn a dedicated read-only polling
explorer in addition to any ordinary diagnosis or review explorer. It returns
only its terminal report by default. The main agent sends no follow-up
steering or status prompts unless the user asks.

Current phase boundaries:

| Phase | Qualifying handoff | Active instruction file |
| --- | --- | --- |
| Local CodeRabbit loop | Review or triage findings only | `references/coderabbit-loop.md` |
| CI babysit | Diagnose logs and likely cause only | `references/ci-gates.md` |
| GitHub CodeRabbit babysit | Analyze findings against current code only | `references/github-review.md` |
| CI polling | Check status only; report the terminal result | `references/ci-polling.md` |
| GitHub CodeRabbit polling | Check review status only; report the terminal result | `references/github-review-polling.md` |
| Commit, submit, implementation, branch setup, and labeling | None; these mutate state | Main skill |

When adding a mode, update this table and the relevant active reference only
after checking the three conditions. The subagent configuration lives in
`.agents/autonomous-development.yaml`.
