# Ticket routing model research

Checked 2026-09-30. This note explains `.agents/ticket-routing.yaml`.

## Synced T3Code-MCP baseline

The benchmark note on the synced T3Code-MCP `main` branch, checked on
September 28, reports Codex-harness runs at max reasoning effort. Its composite
scores were 41 for GPT-6 Luna, 57 for GPT-6 Sol, and 62 for GPT-6 Astra.
Average cost across its three-benchmark suite was $0.18, $2.99, and $7.47 per
task, respectively. These runs include the Codex harness and three attempts per
task; the costs are suite averages, not single-benchmark costs. See the
[Artificial Analysis comparison](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-codex)
and its
[methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking).

The T3Code-MCP routing config uses GPT-6 Luna for quick through standard work
and GPT-6 Sol at max for complex and architectural work.

## GPT-6.1 Sol benchmark results

Artificial Analysis published its GPT-6.1 Sol results on September 29. At max
effort, GPT-6.1 Sol gained 3 points over GPT-6 Sol max on the Coding Agent
Index. At xhigh, it gained 6 points over GPT-6 Sol max and scored 1 point above
GPT-6 Astra. The report also records a 12-point Terminal-Bench 4.0 gain; its
summary does not state the reasoning-effort comparison for that result.
Artificial Analysis reports that GPT-6.1 Sol costs 31% less per Intelligence
Index task than GPT-6 Sol. That task-cost metric is separate from the
three-benchmark suite cost above. See the
[GPT-6.1 Sol report](https://artificialanalysis.ai/articles/gpt-6-1-sol-replaces-gpt-6-sol-after-just-7-days-with-near-astra-intelligence).

The DeepSWE owner leaderboard still shows its September 22 update and has no
GPT-6.1 Sol entry. Artificial Analysis's Coding Agent Index includes DeepSWE
v1.1, but its release report does not publish a separate GPT-6.1 Sol DeepSWE
score. See the
[DeepSWE leaderboard](https://deepswe.datacurve.ai/).

## Routing decision

- Keep GPT-6 Luna for quick, focused, and standard work.
- Use GPT-6.1 Sol at max for complex work.
- Use GPT-6.1 Sol at xhigh for architectural work. Artificial Analysis reports
  that xhigh is 6 points above GPT-6 Sol max on its Coding Agent Index and
  1 point above GPT-6 Astra.

The recommendation follows current benchmark results; it has not been
evaluated against TiaraStack's own ticket history.
