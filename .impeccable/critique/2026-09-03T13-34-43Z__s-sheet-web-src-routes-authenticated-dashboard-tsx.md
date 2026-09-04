---
target: dashboard navigation as a whole
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-09-03T13-34-43Z
slug: s-sheet-web-src-routes-authenticated-dashboard-tsx
---
# Dashboard navigation critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 2/4 | The selected server is clear, but a server with no schedule channels can appear blank. |
| 2 | Match system / real world | 3/4 | Server, channel, permissions, and account terminology fit; “Sheet mappings” remains technical. |
| 3 | User control and freedom | 3/4 | Escape, back, unsaved-change protection, retries, and confirmations are strong. |
| 4 | Consistency and standards | 3/4 | Scope labels improved, but Docs still exposes older “Dashboard” terminology. |
| 5 | Error prevention | 3/4 | Permission and draft safeguards work; no-channel routing does not prevent a dead end. |
| 6 | Recognition rather than recall | 2/4 | The icon rail is efficient for Discord users, but names still depend on hover/focus discovery. |
| 7 | Flexibility and efficiency | 2/4 | The rail is fast for experts, but there are no named quick-switch, shortcut, or last-destination aids. |
| 8 | Aesthetic and minimalist design | 3/4 | Strong control-room identity, with some pressure from nested nav layers and dense labels. |
| 9 | Error recovery | 2/4 | Administration recovers well; the blank schedule state has no explanation or recovery. |
| 10 | Help and documentation | 2/4 | Docs are available, but server selection, channel setup, and mapping scope need more context. |
| **Total** |  | **25/40** | **Acceptable** |

Terminology and landmarks improved, but the overall score did not rise because the no-channel schedule state is a P1 confidence failure.

## Design Specificity Verdict

The visual system remains strongly specific to SheetWeb: Discord-style server switching, server permissions, schedule channels, Sheet Mappings, and the dark electric-teal control-room language.

The information architecture is improving but still partly generic. The icon rail is a reasonable expert shortcut for users who already know their Discord servers. A named chooser would improve first-use clarity and distinguish similar icons, but it adds a separate selection surface and more cognitive overhead. The best current direction is to keep the rail and ensure names are discoverable on desktop, keyboard, and touch without making hover the only path.

The broad detector scan found 97 findings: 90 typography advisories, four color advisories, one gradient-text warning, one overused-font warning, and one decorative-grid advisory. Most are outside this navigation scope. The in-scope selected-guild findings are compact typography choices, including the server ID and mobile administration labels. They are consistency advisories, not functional defects.

Live inspection confirmed the new `SERVERS`, `MY PREFERENCES`, `SERVER SETTINGS`, and `SHEET MAPPINGS` terminology in the authenticated desktop flow. The new main/global navigation semantics are present in source. No user-visible overlay is claimed because injection/browser visualization was unavailable.

## Overall Impression

The terminology pass succeeded. Account scope, server scope, administration scope, and schedule scope are now much easier to distinguish.

The biggest remaining issue is not the icon rail itself. It is that a valid server configuration can lead to a visually empty schedule surface. That makes the product feel unreliable at exactly the moment an operator is trying to determine whether setup is complete.

## What’s Working

- The icon rail preserves Discord familiarity and avoids adding server state or a redundant chooser step.
- `SERVERS`, `MY PREFERENCES`, `SERVER SETTINGS`, and `SHEET MAPPINGS` create a much cleaner scope vocabulary.
- Skip navigation, page landmarks, labeled navigation groups, explicit selected states, and mobile Sheet Mappings visibility are meaningful accessibility improvements.
- Draft lifecycle, retries, rollback, and unsaved-change protection remain strong patterns in administration.

## Priority Issues

### [P1] No-channel schedule state is visually silent

Why it matters: the live schedule route can render the server shell with only a visually hidden `Schedule` heading when no schedule channel exists. Users cannot tell whether the server is unconfigured, still loading, or broken.

Fix: render a visible parent-level empty state such as “No schedule channels configured,” explain that an administrator must configure one, and link to `SERVER SETTINGS → CHANNELS` when permitted.

Suggested command: `$impeccable harden`

### [P1] The icon rail still makes first discovery name-blind

Why it matters: the rail is excellent for experienced Discord users, but the chooser can still present an icon or two-letter fallback such as `LE`. Hover/focus labels help desktop and keyboard users, but touch users cannot rely on hover.

Fix: keep the icon rail as the primary switcher. Make the selected server name persistently visible, keep the accessible action name, and provide a tap/focus name reveal. Only add a named chooser/list if first-use testing shows the rail is insufficient.

Suggested command: `$impeccable adapt`

### [P2] Mobile navigation is now discoverable but crowded

Why it matters: keeping Server Administration visible on mobile fixes the previous context loss, but the header now combines the server rail, selected-server identity, Schedule, Server Settings, Sheet Mappings, and the editor’s own section selector.

Fix: retain the administration grouping, but reduce duplicate context and keep the mobile labels comfortably readable. Avoid shrinking important labels further to fit.

Suggested command: `$impeccable layout`

### [P2] Terminology still leaks across neighboring surfaces

Why it matters: the main authenticated header now says `SERVERS`, but Docs still uses `Dashboard`, and the codebase mixes `server`, `guild`, and `workspace`. This weakens the scope model users are learning.

Fix: use `server` for Discord-facing concepts, reserve `workspace` for a deliberately different domain object, and rename the Docs return destination to `SERVERS` where it points to the server dashboard.

Suggested command: `$impeccable clarify`

## Cognitive Load

Passes:

- Server administration is now structurally separated from Schedule.
- Active server and current destination are explicit.
- Permission gating and editor controls provide useful progressive disclosure.

Failures:

- Sheet Mappings still exposes five sibling sections.
- Mobile combines several navigation layers and sticky draft controls.
- Icon-first server switching and first-channel defaults create working-memory demands.
- The no-channel route forces users to infer system state from absence.

Overall load is moderate in the main dashboard and high in Sheet Mappings.

## Emotional Journey

- Chooser: familiar to Discord users, uncertain for first-time or touch users.
- Selected server: strong and reassuring through server name, active state, and permissions.
- Schedule: operationally credible when configured, but a no-channel server creates a sharp confidence drop.
- Administration: careful and trustworthy, with improved mobile context but increased density.

## Persona Red Flags

**Alex, power user**

- The rail is fast only after memorizing server icons.
- No keyboard quick-switch, named search, or recent destination exists.
- Returning to the dashboard still requires choosing a server again.
- A misconfigured server can look like a blank schedule.

**Sam, accessibility-dependent user**

- Server names are available through accessible labels, but visual tooltip discovery is weak on touch and zoom.
- Page/global landmarks improved substantially.
- Low-opacity metadata and dense mobile labels may still be difficult to perceive.
- The mobile drawer’s focus trapping and Escape behavior are strong and should be preserved.

**Jordan, first-timer**

- `SERVERS` is clear, but an icon or `LE` fallback is not enough identity.
- `SERVER SETTINGS` and `SHEET MAPPINGS` are clearer, though Sheet Mappings remains technical.
- A no-channel server gives no visible explanation or next action.
- The Docs “Dashboard” label conflicts with the newer vocabulary.

## Minor Observations

- The custom tooltip is correctly paired with an accessible link name, but its live mobile behavior was not browser-verified.
- The schedule H1 is screen-reader-only; a visible channel/schedule title could improve orientation for everyone.
- The account menu has Escape behavior but not full arrow-key menu navigation.
- The detector’s two warning-level findings are outside the dashboard navigation surface.
- No persisted server/channel state or Sheets reads were added.

## Questions to Consider

- Is the icon rail sufficient if the no-server state remains a named list, while the selected-server experience stays icon-first?
- Should an unconfigured server ever enter the schedule surface without an explicit setup message?
- Can the selected-server header become the single scope anchor for the entire mobile administration flow?
