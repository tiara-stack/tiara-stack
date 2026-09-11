---
status: accepted
---

# Consolidate autonomous development into one explicit workflow

The repository uses one explicitly invoked `autonomous-development` skill for feature implementation, incremental Graphite commits, CodeRabbit repair loops, CI babysitting, undrafting, and merge-readiness labeling. Its commit and submission procedure is a shared phase of those routes; explicit invocation keeps ordinary implementation requests independent while allowing one autonomous workflow to own its selected terminal gate. Repository-specific label and read-only delegation defaults live in `.agents/autonomous-development.yaml` and are recorded separately in ADR 0002.
