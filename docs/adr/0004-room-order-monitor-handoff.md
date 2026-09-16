---
status: accepted
---

# Derive prior monitor assignments from the schedule sheet

Room-order generation and later room-order actions need to render a compact
Monitor Handoff. The current monitor is already part of the canonical
room-order record, but the prior assignment should remain a property of the
authoritative schedule source rather than another database field.

When navigation, Send, or Tentative Pin rebuilds room-order content, the
workflow resolves the running room's configured schedule and reads the
adjacent Schedule Hour from the authoritative sheet. A present row with no
monitor is known unassigned; a missing row is unknown. The resulting handoff is
passed to the message formatter, which decides whether to show an `In`, `Out`,
or unchanged `Monis:` line.

Do not add prior-monitor or history-known columns to room-order persistence and
do not perform a retrospective sheet read during migration. This keeps
room-order persistence focused on the current operational record and avoids
turning a derived sheet observation into a second source of truth.
