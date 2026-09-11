---
status: accepted
---

# Configure repository-specific autonomous development defaults

The repository keeps the autonomous-development merge label and read-only delegation defaults in `.agents/autonomous-development.yaml`. It uses the existing `to merge` label and hands qualifying investigation or review subtasks to an `explorer` using `gpt-5.6-luna` at maximum reasoning effort. The main agent attaches the smallest relevant instruction file; code edits and other mutations remain with the main agent.
