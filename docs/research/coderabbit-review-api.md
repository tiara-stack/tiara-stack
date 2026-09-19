# CodeRabbit PR review API research

Checked 2026-09-17. Scope: CodeRabbit Cloud reviews for GitHub pull requests and the integration already present in this checkout.

## Conclusion

CodeRabbit has a supported REST API, but it does not document a live, per-pull-request endpoint that returns all of the requested fields: review state, reviewed head SHA, actionable findings, rate-limit or skipped state, and comment text. The published [OpenAPI specification](https://docs.coderabbit.ai/openapi.json) lists metrics, administration, security, and legacy report routes. It has no route that accepts a GitHub pull request number or URL and returns the current review state. That last sentence is an inference from the published path list.

The CLI has two different capabilities:

- <code>coderabbit review --agent</code> emits structured findings and lifecycle events for a review that the CLI starts. It is useful for a fresh local or remote review, not for polling an existing hosted PR.
- The installed CLI in this workspace, version <code>0.7.6</code>, also exposes <code>coderabbit pullrequest &lt;number-or-url&gt; --show-prompts --agent</code>. Its help describes this as reading CodeRabbit output and printing a consolidated prompt for an AI agent. The public [CLI command reference](https://docs.coderabbit.ai/cli/reference) does not list this subcommand or define a PR-state JSON schema, so it is not a stable replacement for the GitHub polling already used here. In this workspace, omitting <code>--show-prompts</code> fails with a required-option error; the current PR test also had no generated all-comments prompt to read.

For this repository, use the installed CLI's undocumented best-effort
`coderabbit pullrequest --show-prompts --agent` command for agent-ready findings
when available. Keep GitHub as
the live source for the head-scoped hosted review status. Use CodeRabbit's REST
API only for historical or organization-level metrics.

## CodeRabbit REST API

### Authentication and scope

The base URL is <code>https://api.coderabbit.ai</code>. Requests use the <code>x-coderabbitai-api-key</code> header:

~~~bash
curl "https://api.coderabbit.ai/v1/users" \
  -H "x-coderabbitai-api-key: $CODERABBIT_API_KEY"
~~~

CodeRabbit documents organization-scoped keys, Enterprise SSO workspace tokens, and self-hosted instance keys. Each endpoint has its own plan and scope requirements. The metrics endpoints below require Enterprise access. See the [CodeRabbit API overview](https://docs.coderabbit.ai/api).

### Pull request metrics

Endpoint: <code>GET https://api.coderabbit.ai/v1/metrics/reviews</code>

Example:

~~~bash
curl --request GET \
  --url 'https://api.coderabbit.ai/v1/metrics/reviews?start_date=2026-09-01&end_date=2026-09-17&status=all&repository_ids=<provider-repository-id>&limit=1000' \
  --header 'x-coderabbitai-api-key: <api-key>'
~~~

Required query parameters are <code>start_date</code> and <code>end_date</code> in <code>YYYY-MM-DD</code> format. Optional filters include <code>status=merged|closed|all</code>, provider <code>organization_ids</code>, <code>repository_ids</code>, <code>user_ids</code>, <code>format=json|csv</code>, <code>limit</code>, and <code>cursor</code>.

The response contains one record per finalized PR, including <code>pr_url</code>, PR and repository metadata, lifecycle timestamps, <code>status</code> (<code>merged</code> or <code>closed</code>), <code>review_iterations</code>, estimated review effort, and aggregate CodeRabbit comment counts by severity and category. <code>last_commit_at</code> is a timestamp, not a commit SHA. The endpoint does not return live review state, the reviewed head SHA, individual actionable findings, rate-limit/skipped state, or comment bodies. CodeRabbit describes this endpoint as metrics for finalized pull requests, so it is not a live PR poller. See the [Metrics Data API](https://docs.coderabbit.ai/api-reference/metrics-data-api).

### Review comment metrics

Endpoint: <code>GET https://api.coderabbit.ai/v1/metrics/review-comments</code>

Example:

~~~bash
curl --request GET \
  --url 'https://api.coderabbit.ai/v1/metrics/review-comments?start_date=2026-09-01&end_date=2026-09-17&repository_ids=<provider-repository-id>&limit=1000' \
  --header 'x-coderabbitai-api-key: <api-key>'
~~~

The required date window selects merged PRs by merge date. Optional filters include workspace <code>org_id</code>, <code>repository_ids</code>, <code>user_ids</code>, <code>organization_ids</code> for self-hosted instance keys, <code>limit</code>, and <code>cursor</code>.

Each record contains <code>pr_url</code>, provider IDs, <code>merged_at</code>, and stored finding metadata: <code>url</code>, <code>severity</code>, <code>category</code>, and <code>accepted</code>. The endpoint explicitly excludes PRs without stored comments and does not return comment text. A URL can represent multiple findings, and <code>accepted</code> is a stored resolution outcome, not proof that the PR author accepted the finding. It therefore cannot supply the repo's current actionable-comment list. See the [Review comment metrics API](https://docs.coderabbit.ai/api-reference/review-comment-metrics).

### Other published API routes

<code>POST https://api.coderabbit.ai/api/v1/report.generate</code> exists in the OpenAPI document, but CodeRabbit marks it deprecated and limits it to legacy report testing. It is not a per-PR review-state endpoint.

The API's <code>429</code> responses and rate-limit headers describe API request throttling. They are not the hosted PR review quota or a review-skipped result. CodeRabbit's [review-rate-limit documentation](https://docs.coderabbit.ai/management/rate-limits) says the authoritative hosted-PR signal is a rate-limit comment on the pull request, alongside a passing <code>Review rate limited</code> check.

## CLI details

The documented structured-review command is:

~~~bash
coderabbit auth login --api-key "$CODERABBIT_API_KEY"
coderabbit review --agent
~~~

For a remote GitHub review without a checkout, CodeRabbit documents this form for CLI <code>0.7.7</code> or later:

~~~bash
coderabbit review --remote OWNER/REPO --base main --source-branch feature --agent
~~~

Remote reviews require GitHub Cloud, an installed repository in the active CodeRabbit organization, and either CodeRabbit SaaS login or an Agentic API key. A private repository also requires the authenticated user's repository read access. The <code>--agent</code> stream contains <code>finding</code>, <code>review_context</code>, <code>status</code>, <code>heartbeat</code>, <code>complete</code>, and <code>error</code> events. Finding events include severity, file name, fix instructions, suggestions, and a human-readable comment. A no-change CLI review reports <code>status: "review_skipped"</code> and zero findings. These are results for the CLI-run review, not the state of an existing GitHub PR. See the [CLI reference](https://docs.coderabbit.ai/cli/reference) and [headless CLI authentication](https://docs.coderabbit.ai/cli/headless-cli-integration).

The installed binary also prints this PR-oriented command:

~~~bash
coderabbit pullrequest <number-or-url> --show-prompts --agent
~~~

Its help requires CodeRabbit SaaS sign-in or a stored Agentic API key, an
installed GitHub repository in the active organization, and `github.com` pull
requests. The command is useful when the optional AI-agent prompt has been
enabled, but the help only promises a consolidated prompt, not a typed
review-state, head-SHA, quota, or comment API. The polling script treats it as
a findings reader and keeps GitHub status as the completion contract.

## Comparison with the repo's current GitHub data

The repo's [GitHub review operations](../../.agents/skills/autonomous-development/references/github-review.md) resolve <code>headRefOid</code>, then use these GitHub endpoints:

~~~text
GET /repos/{owner}/{repo}/commits/{head_sha}/status
GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
GET /repos/{owner}/{repo}/pulls/{pull_number}/comments
GET /repos/{owner}/{repo}/issues/{pull_number}/comments
~~~

The polling implementation is in [poll.ts](../../.agents/skills/autonomous-development/scripts/poll.ts). It checks the current <code>headRefOid</code> before and during polling, selects the latest status with context <code>coderabbit</code>, treats a completed status as head-scoped only after head validation, and reads the installed CLI's undocumented best-effort <code>coderabbit pullrequest --show-prompts --agent</code> result for findings. It does not classify unassociated historical issue comments, so a hosted rate-limit result must come from the current status or the CodeRabbit CLI/API result. The main review phase still uses GitHub review and comment endpoints for thread repair and replies.

The review-operations reference now invokes
`coderabbit pullrequest "$PR_URL" --show-prompts --agent`. The installed 0.7.6
CLI rejects the older invocation without `--show-prompts`; the polling script
captures the structured CLI result without exposing its intermediate output.

| Requested data | CodeRabbit REST API or CLI | GitHub data already used here |
| --- | --- | --- |
| Review state | No live per-PR REST field. CLI <code>review --agent</code> reports the state of a new CLI run; <code>pullrequest --show-prompts --agent</code> reports a prompt or a prompt error. | Commit status <code>context=coderabbit</code>, its state and description, plus the PR's current head. |
| Reviewed head SHA | Metrics expose <code>last_commit_at</code>, not a SHA. Remote CLI accepts a source SHA, but reviews that source rather than querying an existing PR. | <code>gh pr view --json headRefOid</code>; review and inline-comment <code>commit_id</code> fields are matched to it. |
| Actionable findings | Metrics provide counts, or merged-PR finding metadata without text. The installed <code>pullrequest --show-prompts --agent</code> command returns the consolidated agent prompt when enabled. | GitHub remains the authoritative thread store for repair/reply operations. |
| Rate-limited or skipped | REST <code>429</code> means API throttling. CLI <code>review_skipped</code> covers a no-change CLI run, not a hosted PR. | Hosted PR status descriptions and the CodeRabbit CLI/API result. |
| Review comments | Review-comment metrics return URLs and metadata for merged PRs, not comment text. | GitHub review, review-comment, and issue-comment endpoints return the actual bodies and thread-related fields. |

GitHub's official API documentation confirms that the current calls expose the needed fields: the PR object exposes the head branch/status, commit statuses are keyed by a SHA and include <code>context</code>, <code>state</code>, and <code>description</code>, review records include <code>state</code>, <code>body</code>, and <code>commit_id</code>, and review comments include <code>body</code>, <code>path</code>, <code>line</code>, <code>commit_id</code>, and <code>in_reply_to_id</code>. See [pull requests](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request), [commit statuses](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference), [pull request reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request), [review comments](https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request), and [issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-a-repository).

For private repositories, the GitHub calls need the authenticated <code>gh</code> token already used by the repo. The relevant fine-grained read permissions are <code>Pull requests</code> for reviews and review comments, <code>Issues</code> or <code>Pull requests</code> for issue comments, and <code>Commit statuses</code> for statuses. The linked GitHub endpoint docs list these permissions.

## Recommendation

Use the installed CLI's best-effort prompt command for findings in the silent poller, but do
not treat it as a status API. Keep the GitHub head-SHA/status check for live
merge-readiness decisions and retain GitHub review/comment APIs in the main
agent for thread inspection and replies. Add the CodeRabbit metrics endpoints
only if the repository needs historical review counts, severity/category
aggregates, or post-merge finding metadata.
