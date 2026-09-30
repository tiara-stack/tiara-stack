---
status: accepted
---

# Configure repository-specific autonomous development defaults

The repository keeps the autonomous-development merge label, local reviewer
selection, and subagent defaults in `.agents/autonomous-development.yaml`. It
uses the existing `to merge` label for Graphite merge-queue admission and
delegates qualifying read-only investigations to an explorer using
`gpt-6-luna` at medium reasoning effort. The main agent attaches the smallest
relevant instruction file; code edits and other mutations remain with the main
agent.
