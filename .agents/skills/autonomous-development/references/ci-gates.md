# CI gates

Use this reference to keep a pull request in draft while checking CI before
removing its draft state. The `pre-undraft` phase ends with all required checks
green and leaves the PR draft unchanged.
When the file is attached to a read-only explorer, inspect and report the
failure only. The main agent performs repairs, commits, submissions, and
conflict resolution.

## Inspect and wait

Set `PR` to the pull request number or URL before running these commands.
Watch checks until they reach a terminal state:

```bash
gh pr checks "$PR" --watch --interval 10
```

Inspect failed workflow and step logs with `gh run view <run-id>
--log-failed` or the matching GitHub Actions detail. Monitor all required
checks, especially `workspace_ci`, `fallow`, and `fallow_baseline`.

## Repair a failure

1. Rerun a clearly transient or infrastructure-only failure once. Repair a
   reproducible repository failure in the code, configuration, generated
   output, or test that caused it.
2. Run `pnpm dlx fallow@2.88.2 audit` for ordinary Fallow findings. For
   `fallow_baseline`, use the exact baseline command from
   `.github/workflows/ci.yml`.
3. Fix a baseline finding before changing the baseline. Update a baseline only
   when the code change intentionally and legitimately changes the accepted
   result, after local verification, and commit the update as an understandable
   change. Never regenerate a baseline solely to suppress a failure.
4. If Git reports merge conflicts, fetch the target and resolve each conflict
   while preserving both sides when their intent is clear. Validate the result.
   Report a precise blocker when the intended resolution is ambiguous.
5. Run the local CodeRabbit review command, repair any valid findings, commit
   repairs with Graphite, and submit the new head. Restart the watch from that
   head:

   ```bash
   coderabbit review --agent --base master --include-untracked
   gt submit --no-interactive
   ```

Keep polling at a bounded cadence until checks are green, an external blocker
appears, or a decision is needed. A different required check failing is also a
release blocker; use the same repair loop when it is repository-owned and its
intent is clear.
