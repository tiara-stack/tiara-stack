# TiaraStack review preparation

Use `pnpm review:prep` to run the installed agentic-review core through the
TiaraStack Effect v4 CLI. The wrapper resolves Effect imports from
`packages/developer-launcher`, scopes that resolution to the installed core,
and checks that `source.head` still matches local `HEAD` before and after a
bundle is written.

Provide the installed core's `review-plan/v1` input, built from the canonical
frozen source capture and the reviewer's own accepted scope and coverage. Keep
canonical captures, accepted reports, grants, reservations, and native receipts
in their existing locations. The plan must reference those exact files and
hashes. The core validates readable inputs, source identity, axis isolation,
coverage, and documented size/count limits. It writes only to a new output
path.

```sh
pnpm review:prep bundle --input /path/to/review-plan.json \
  --axis correctness_reliability --output /path/to/new-bundle
pnpm review:prep check-grant --input /path/to/grant.json \
  --output /path/to/new-grant-check.json
pnpm review:prep count-starts --input /path/to/native-starts.json \
  --output /path/to/new-start-accounting.json
pnpm review:prep timing --input /path/to/phase-times.json \
  --output /path/to/new-timing-summary.json
```

Before a native review starts, recheck the captured head and referenced files.
The wrapper and generic core do not decide semantic carry acceptance, reserve
quota, mutate coordinator state, launch reviewers, or perform remote actions.
The coordinator applies deduplicated starts to quota under its existing lock.
For schema details and limits, read the installed
`agentic-review/references/review-preparation.md`.
