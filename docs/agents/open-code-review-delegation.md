# Open Code Review delegation

Use this procedure for the `open-code-review-delegate` local reviewer in
`.agents/autonomous-development.yaml`.

1. Run `ocr delegate preview --format json` on the workspace changes. Use its
   path list as the review scope.
2. Resolve the review rule for every listed path with
   `ocr delegate rule --format json <paths>`.
3. Inspect each diff against its resolved rules. Record every `(path, status)`
   as reviewed or skipped with a reason.
4. Report total paths, reviewed paths, skipped paths, and coverage. The review
   passes only at 100% coverage.

If a command reports exactly `unknown flag: --format`, retry that command
without the flag. Treat any other command failure, missing rule result, or
incomplete coverage as a failed review.
