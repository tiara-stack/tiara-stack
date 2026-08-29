# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

This record covers the web products in the monorepo. SheetWeb is the only web
product currently present.

Its primary users are Project Sekai tiering communities that run scheduled
co-op support shifts:

- Fillers and support members need to find their Fill, Overfill, and Standby
  hours, inspect open slots, submit and verify fill teams when enabled, respond
  to check-ins, enter the right running room, and report problems to their
  server's mana/moni.
- Mana/moni and monitors coordinate shifts. They configure the event server and
  channels, inspect schedule and slot state, run or oversee check-ins, review
  empty slots and movement, prepare and publish room order, manage optional
  running-room access, and handle replacements through the server's own process.
- Server administrators and members with Manage Server configure server and
  channel settings. Registered TiaraBot monitor roles authorize monitor
  operations.

## Product Purpose

SheetWeb is the browser dashboard and documentation surface for a workflow that
connects an event server's Google Sheet schedule to Discord. It gives teams
schedule views, guild and channel configuration, operational guides, and the
shared context needed to run a tiering shift with TiaraBot.

Success means that fillers can act on current schedule and check-in information,
while mana/moni can prepare rooms, manage access, see coverage gaps, and hand
off problems without losing track of the source schedule or the server's own
procedures.

## Positioning

No distinct competitive positioning or marketing claim was confirmed. The
current factual mechanism is the connection between Google Sheets schedule
data, Discord operations, and browser controls and documentation.

## Operating Context

The product is used during Project Sekai tiering events. Users are expected to
know their server's tiering strategy, runner room plan, fill-team and ISV
requirements, schedule-sign-up process, standby and emergency escalation, and
private-room recovery process.

A typical shift involves:

1. Configuring the event server, schedule sheet, running rooms, check-in
   destinations, monitor roles, and any lockdown roles.
2. Posting or inspecting the schedule and current open slots.
3. Opening check-in automatically at minute 45 or manually at the server's
   chosen time.
4. Reviewing check-in state and applying the server's own standby or emergency
   process.
5. Generating, selecting, sending, and pinning the room order.
6. Cleaning up stale room access after replacements and escalating persistent
   bot failures through the server's manual runbook.

The web documentation uses the terms runner/tierer, filler/support, mana/moni,
Fill, Overfill, Standby, ISV, Encore, Marathon, World Link, and Cheerful
Carnival (CC) as defined in its tiering glossary.

## Capabilities and Constraints

- The current web product includes authenticated dashboard flows, guild
  selection, per-guild schedule and calendar views, server and channel settings,
  developer OAuth-client management, and TiaraDocs.
- TiaraBot exposes schedule lookups, open and filled slots, schedule-sheet
  screenshots, check-ins, room-order drafts and posts, saved team lookups,
  optional team submission, personal notification preferences, server and
  channel configuration, lockdown operations, and service readiness.
- Server procedures remain authoritative. TiaraBot supplies schedule and slot
  data but does not choose a runner's team, spend energy or crystals, play a
  tiering song, join a private co-op room, assign an open slot, or write the
  server's emergency ping.
- Automatic check-in and manual check-in are both supported. Servers choose
  their own schedule-sign-up timing and standby or emergency policy.
- Team submission is server-gated. It requires both a configured submission
  channel and the service-controlled feature flag. Without both, the feature
  must remain inactive and the server's manual process applies.
- A running-room lockdown role is optional. When used, it is separate from
  server-level monitor roles and controls visibility and access to one running
  channel.
- Configuration and destructive channel-permission actions follow Discord
  permissions. Manage Server or Administrator is required for server and
  channel configuration; registered TiaraBot monitor roles or Manage Server can
  authorize lockdown setup and undo.
- The product relies on Discord OAuth, Google Sheets, Discord channel
  permissions, and a server-specific human handoff path. Do not assume that
  server names, contacts, channels, timing, or escalation rules are global.

## Brand Commitments

The repository currently uses the names TiaraStack, SheetWeb, TiaraBot, and
TiaraDocs. No additional voice, logo, color, typography, or asset commitment
was confirmed.

## Evidence on Hand

- The repository README documents the current web product and its supporting
  runtimes: `README.md`.
- The public operating guides live under
  `packages/sheet-web/content/docs/`, including filler, mana/moni, command,
  permission, and tiering-glossary references.
- The local docs point to the external [How to Tier guide](https://docs.google.com/document/d/1jA03i1D7cTB0rwhaRHHErlDbPoLf1-gP/edit#heading=h.c6q6k29opnkr)
  and [Managing/Monitoring guide](https://docs.google.com/document/d/1fUGQq89a8TMnJQYxiE44TCJu4-FDhK-Tdgr6qPx_vr4/edit?tab=t.0)
  for strategy and management background.
- No user-provided testimonials, customer list, benchmarks, pricing, press, or
  other external proof was confirmed. Future work must not fabricate any.

## Product Principles

- Make current schedule, slot, and check-in state easy to inspect before anyone
  acts.
- Support the server's human coordination process instead of silently replacing
  its assignment or escalation decisions.
- Keep permissions and role boundaries clear between fillers, mana/moni,
  monitors, and administrators.
- Treat room access and published room order as operational state that needs
  explicit confirmation.
- When automation cannot resolve a problem, preserve the facts needed for a
  human handoff and return users to the server's runbook.
