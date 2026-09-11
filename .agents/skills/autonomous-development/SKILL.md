---
name: autonomous-development
description: Runs configurable autonomous feature implementation, CodeRabbit CLI repair loops, incremental Graphite commits, PR CI babysitting, undrafting, and merge-readiness labeling. Use when explicitly invoking this workflow for an implementation or PR; supports review-only, pre-undraft, pre-merge, and read-only delegation routes.
---

# Autonomous Development

Use this skill only after the user explicitly invokes it. Once invoked, own the
selected route to its terminal criterion. Read the repository policy in
`.agents/autonomous-development.yaml` before using a merge label or delegating
work. Ask intake questions together before mutating the repository; make
routine implementation, review, and waiting decisions autonomously afterward.

## Route the invocation

Treat `implement <feature>` as the default route when no mode is named.

| Mode | Route | Terminal criterion |
| --- | --- | --- |
| `implement <feature>` | Implement, commit coherent slices as they are validated, run the local CodeRabbit loop, submit, babysit CI, undraft, babysit GitHub CodeRabbit review, apply the configured label | Current PR is green and has the configured merge label |
| `coderabbit-loop` | Run only the local CodeRabbit loop on the current branch diff | A successful review run has no new valid findings |
| `pre-undraft <PR>` | Babysit CI and repair the PR | Named CI checks are green; leave the PR draft state unchanged |
| `undraft <PR>` | Run `pre-undraft`, then undraft | The PR is ready and the agent stops |
| `pre-merge <PR>` | Run the full PR babysit flow without labeling | CI and GitHub CodeRabbit review are green; do not apply the configured merge label |
| `babysit <PR>` | Run the full PR babysit flow and label | CI and GitHub CodeRabbit review are green; the configured merge label is present |
| `merge <PR>` | Alias for `babysit` | Same as `babysit`; never merge the PR itself |

Accept these composed modes. Run the local CodeRabbit loop first, then run
the named suffix route:

- `coderabbit-loop-and-pre-undraft`: loop, CI babysit, stop before undrafting.
- `coderabbit-loop-and-undraft`: loop, CI babysit, undraft, stop.
- `coderabbit-loop-and-pre-merge`: loop, the full pre-merge flow, stop before labeling.
- `coderabbit-loop-and-merge`: loop, full babysit, apply the configured merge label.
- `coderabbit-loop-and-babysit`: loop, full babysit, apply the configured merge label.

`merge` and `babysit` apply the configured merge label; `pre-merge` does not. A
mode that applies the label never merges the PR. Combined routes operate on the
current branch and PR; they do not implement a feature or create a new branch.

## Intake and branch gate

Complete this gate before editing files, committing, submitting, undrafting,
or applying a label.

1. Parse the route, feature, username, Linear issue, and PR number or URL.
   Ask all missing questions in one message. Always ask for the username when
   it was not supplied, even if Git or GitHub might reveal a candidate.
2. Read `.agents/autonomous-development.yaml`. Require a non-empty string
   `merge_label` for any route that can apply a label. Read the `subagent`
   defaults for qualifying read-only tasks. A missing or invalid merge-label
   configuration is a blocker; do not fall back to a hard-coded label.
3. If a Linear ticket is supplied, use the configured Linear integration to
   obtain its provided branch name and use that name. If the integration is
   unavailable, stop and ask the user to enable or provide access; do not
   substitute a guessed GitHub branch name.
4. For a route that needs a PR, use the supplied PR number or URL. If it is
   omitted, infer the PR from the current branch only when exactly one open PR
   matches it. Stop before mutation when no PR or multiple plausible PRs are
   found.
5. For `implement`, derive a lowercase kebab-case feature slug when Linear
   did not provide the branch name. Use the form `<username>/<feature-slug>`.
   Preserve an exact Linear-provided branch name when one exists.
6. Inspect `git status --short`, the current branch, the repository root, and
   the configured Graphite trunk. Mark the paths that belong to the requested
   work. Leave unrelated new files untracked and unrelated tracked edits
   untouched and unstaged. Never deliberately untrack an existing file. Ask
   before proceeding when a path mixes scopes or existing commits make intent
   unclear.
7. Set the branch name before implementation edits. Define an empty branch as
   a clean branch with no commits ahead of the trunk. Rename an empty branch
   and track the trunk:

   ```bash
   TRUNK=master # resolved from the repository's Graphite trunk
   git branch -m <target-branch>
   gt track --parent "$TRUNK"
   ```

   Keep `TRUNK` set while choosing the existing-work path below.

   If the branch already has work, create the target branch from the trunk.
   When clearly in-scope changes are uncommitted, preserve them while changing
   bases with a reversible stash, then inspect for conflicts:

   ```bash
   git stash push --include-untracked -m "autonomous-development intake" -- <related-pathspec>...
   gt create <target-branch> --onto "$TRUNK"
   git stash pop
   ```

   Never discard commits or working-tree changes. If moving the work would omit
   a meaningful commit or the stash cannot be restored safely, report that at
   intake and stop.
8. For routes that apply the configured merge label, verify that the exact
   repository label already exists. If it does not, stop and report the
   missing-label blocker; do not create the label.

The gate is complete only when the route, identity, branch, worktree scope,
PR target, configuration, and final-label availability (when applicable) are
all resolved.

## Delegate read-only subtasks

The full implementation, repair, commit, submission, and labeling phases stay
with the main agent. A read-only diagnosis or review subtask may receive the
phase's linked instruction file through an `explorer`. Pass
`subagent.model` and `subagent.reasoning_effort` from
`.agents/autonomous-development.yaml` with every such handoff. If spawning is
unavailable, read the linked file locally and continue the read-only task in
the main agent.

## Implement the feature

For `implement`, inspect relevant context pointers and package scripts before
changing code. Implement the requested feature without asking routine design
questions during execution. Validate and commit each coherent feature slice as
it becomes ready. Run the repository's
prescribed formatting, type, test, build, and audit checks at the appropriate
scope, and record any intentionally skipped check. When the feature changes
are complete and locally validated, run the CodeRabbit loop below.

## Local CodeRabbit loop

Read [Local CodeRabbit loop](references/coderabbit-loop.md) for this phase.
The full loop fixes code and commits changes, so keep it in the main agent. A
separate read-only review or triage subtask may attach this file to an
explorer; if spawning is unavailable, read it locally.

## Commit and submit

Read [Commit and submit](references/commit-and-submit.md) while implementing.
Commit each coherent, validated feature slice as it becomes ready. Before the
initial submission, verify that every intended change is committed, then
submit with Graphite. Capture the resulting PR number and URL, then begin the
selected PR route.

For every later repair cycle, commit the repair immediately, rerun the full
local CodeRabbit loop, and submit with `gt submit --no-interactive` before
watching the new head. Do not call an older commit green after a new commit is
submitted.

## CI babysit and undraft

Use [CI gates](references/ci-gates.md) for failure repair and conflict
handling. The full gate repairs code or repository state, so keep it in the
main agent. A separate read-only diagnosis task may attach this file to an
explorer; otherwise read it locally. `pre-undraft` is the CI gate. From the
repository root, watch the
PR:

```bash
gh pr checks "$PR" --watch --interval 10
```

Monitor all required checks, especially `workspace_ci`, `fallow`, and
`fallow_baseline`. For a repository-owned failure, repair it, run the local
CodeRabbit loop, commit and submit the new head, then restart the watch. Do
not ask whether to keep waiting.

`pre-undraft` completes only when the named checks and every required check are
green for the current head. It stops before changing draft state. `undraft`
continues from that gate with:

```bash
gh pr ready "$PR"
gh pr view "$PR" --json isDraft --jq '.isDraft'
```

Require the final value to be `false`, then stop. If the PR is already ready,
the undraft operation is already satisfied.

## GitHub CodeRabbit babysit

`pre-merge`, `babysit`, and `merge` continue after the undraft gate. Use
[GitHub review operations](references/github-review.md) to inspect CodeRabbit
reviews, issue comments, and inline review comments. The full phase can fix
code, reply, submit, and label, so keep it in the main agent. A separate
read-only review-analysis task may attach this file to an explorer; otherwise
read it locally.

Wait for CodeRabbit to finish reviewing the current head. A pending, missing,
failed, or unauthenticated CodeRabbit review is not green. For every current
or unresolved CodeRabbit finding:

1. Fix a valid finding, including a worthwhile in-scope preference, with the
   smallest safe change. Validate and commit it.
2. Reply to an invalid or intentionally skipped finding with specific evidence
   and the reason it does not apply. Reply in the existing thread when GitHub
   supports it; otherwise post a PR comment that identifies the finding.
3. After any finding is handled, run the complete local CodeRabbit loop and
   submit the resulting head. Wait for the new GitHub review before deciding
   that the PR is green.

The GitHub review gate completes only when CI is green for the current head,
CodeRabbit has completed its review of that head, no actionable valid finding
remains, and every skipped finding has a substantive reply.

## Apply the merge-readiness label

Only `implement`, `babysit`, `merge`, and `coderabbit-loop-and-merge` /
`coderabbit-loop-and-babysit` apply the final label. After both CI and the
GitHub CodeRabbit review are green for the current head:

```bash
gh pr edit "$PR" --add-label "$MERGE_LABEL"
gh pr view "$PR" --json labels --jq '.labels[].name'
```

Set `MERGE_LABEL` from `merge_label` in `.agents/autonomous-development.yaml`
before running the command. Verify the exact configured label is present.
`pre-merge` and its composed
variant stop after the green GitHub review gate without applying it. Applying a
label is the terminal action; this skill does not merge the PR.

## Autonomy and blockers

Resolve ordinary implementation, classification, repair, polling, and commit
decisions without returning to the user. Ask only at intake for a missing
username or Linear access, ambiguous feature or conflict intent, unclear change
scope, or a missing PR. For a missing label, missing credentials or
permissions, failed external service, or an unresolvable valid finding, stop
and report instead of asking for a routine override. Report the exact state,
head SHA, command, and next action when stopping.
