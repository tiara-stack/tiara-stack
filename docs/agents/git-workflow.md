# Git and Graphite workflow

Use Graphite for repository commits and pull-request submission. Commit each
validated, coherent slice as it becomes ready. Keep unrelated new files
untracked and unrelated tracked edits outside the index.

## Branches

- Never commit directly to `master`.
- Use `<username>/<branch-name>` with the actual username.
- On `master`, create the branch with `gt create <username>/<branch-name>`.
- In a worktree, rename a nonconforming branch with `git branch -m`, track it with `gt track --parent master`, and use `gt modify -c` for commits.
- If a Linear issue provides a branch name, use the configured Linear integration and preserve that name.

## Commits

Stage only the current coherent slice:

```bash
gt add -v -- <pathspec>...
gt modify -c -m "<conventional commit subject>"
```

Use the package name as the scope when it is clear. Add further `-m`
arguments for additional paragraphs. Pass real arguments instead of escaped
`\n` text. Keep same-file unrelated edits out of the commit by staging hunks or
stopping for clarification.

## Submission

After the intended slices are committed and local review is clean:

```bash
gt submit --no-interactive
```

When the `autonomous-development` skill is already invoked, continue with
[its workflow](../../.agents/skills/autonomous-development/SKILL.md). Otherwise,
continue with the ordinary development flow.

Record the resulting PR number and URL before starting PR babysitting.
