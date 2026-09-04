---
target: dashboard navigation as a whole
total_score: 27
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
timestamp: 2026-09-03T12-56-26Z
slug: s-sheet-web-src-routes-authenticated-dashboard-tsx
---
# Dashboard navigation critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Active server, active schedule state, permissions, and admin status are visible. The chooser has no distinct loading or failure state. |
| 2 | Match system / real world | 3/4 | Server, channel, schedule, and permissions fit the Discord workflow. “Dashboard,” “Sheet Map,” and raw IDs are less literal. |
| 3 | User control and freedom | 3/4 | Back, Escape, dirty-state protection, undo, rollback, and confirmations are strong. The chooser has little recovery control. |
| 4 | Consistency and standards | 3/4 | The visual language is cohesive, but global, server, and editor navigation behave differently, especially on mobile. |
| 5 | Error prevention | 3/4 | Permission gates and destructive-action safeguards help. Empty or failed server metadata is not clearly distinguished. |
| 6 | Recognition rather than recall | 2/4 | Server names are not visible in the rail, and Sheet Map/Settings require product knowledge. |
| 7 | Flexibility and efficiency | 2/4 | Direct routes help, but there are no recent servers, last-used channel memory, Today control, or shortcuts. |
| 8 | Aesthetic and minimalist design | 3/4 | The control-room identity is strong. Dense uppercase metadata and decorative treatment add some repeated-workflow noise. |
| 9 | Error recovery | 3/4 | Administration has thoughtful retry, draft, rollback, and status handling. The chooser remains under-specified. |
| 10 | Help and documentation | 2/4 | Docs exist, but the chooser, Sheet Map entry point, and server scope lack contextual help. |
| **Total** |  | **27/40** | **Acceptable** — a solid operational foundation with remaining discoverability and scope problems. |

This is up from 25/40 in the prior pass. The navigation split improved the information architecture, but did not yet resolve the first-run and cross-scope issues.

## Design Specificity Verdict

The interface is visually specific to SheetWeb: Discord server context, channel navigation, permission-gated administration, schedule terminology, square control surfaces, and the electric-teal status signal all reinforce the product’s operating model.

Its navigation is only moderately specific. The underlying shell still resembles a generic admin dashboard because `DASHBOARD` opens a server chooser, the server rail is icon-first, `SHEET MAP` is shorthand for a serious source-mapping workflow, and raw guild IDs share space with user-facing context.

The two assessments agree that the latest `SCHEDULE` versus `SERVER ADMINISTRATION` split is the right structural move. The deterministic scan found only two advisory typography findings in the selected-guild layout, both outside the core navigation controls: `$guildId.tsx:81` and `:86`. `dashboard.tsx` had no detector findings. They are low-risk micro-label usage, not evidence of a broken navigation system.

Browser evidence confirms separate `Schedule navigation` and `Server administration` landmarks, active `aria-current` on Schedule and the selected server, and no horizontal overflow at 1280×800 or 390×844. No reliable user-visible detector overlay is available because script injection failed.

## Overall Impression

The split worked. A user can now distinguish everyday schedule work from server configuration without mentally parsing one undifferentiated control row.

The remaining weakness is scope confidence. The product asks users to understand a server rail, an active-server header, schedule channels, calendar controls, and an editor-specific navigation model. The interface is strongest after a user already knows the product; it is weakest at the first choice, on mobile Sheet Map, and when metadata fails.

## What’s Working

- The new split makes the role boundary legible: Schedule is the operational destination, while Settings and Sheet Map are clearly administrative.
- The selected server context is repeated in the header, with active states and permission confirmation that reduce cross-server mistakes.
- Admin flows communicate care around risky configuration work through drafts, save states, retries, rollback, and confirmations. The mobile drawer also has strong Escape, focus, and scroll-lock behavior.

## Priority Issues

### [P1] The chooser still hides server identity and failure state

Why it matters: the server rail shows visual avatars while names are mainly available through ARIA/title behavior. “Select a server from the Servers rail” tells Jordan where to look, but not which server each icon represents. A failed or empty server load can look like a normal no-access state.

Fix: show server names in the chooser or provide a deliberate name-reveal/compact list. Distinguish loading, no servers, and failed loading, with an actionable Retry or Discord-access explanation. This can remain metadata-only and does not require Google Sheets reads.

Suggested command: `$impeccable clarify`

### [P1] Mobile Sheet Map loses server-level navigation

Why it matters: the selected-guild layout hides its server navigation below the `sm` breakpoint. Inside Sheet Map, the user is left with an editor-specific back control and reduced context, making it harder to jump to Schedule or another server-level destination.

Fix: retain a compact mobile context bar with Schedule, Server settings, and Sheet mappings, or provide a clear “Back to server administration” control plus an explicit Schedule shortcut.

Suggested command: `$impeccable adapt`

### [P1] The naming model still makes scope ambiguous

Why it matters: `DASHBOARD` opens the server chooser, account `PREFERENCES` sits near server `SETTINGS`, and `SHEET MAP` is less literal than the rest of the interface. These labels force users to remember whether they are changing their account, the server, or the schedule source.

Fix: use scope-explicit labels such as `SERVERS`, `MY PREFERENCES`, `SERVER SETTINGS`, and `SHEET MAPPINGS`. Consider a different label for monitor-only tools if they are not actually server administration.

Suggested command: `$impeccable clarify`

### [P2] Repeat users are sent through an inefficient schedule entry path

Why it matters: `/schedule` selects the first available channel and the current timestamp. Users who work across several channels must reorient each time, and the calendar has no obvious Today shortcut.

Fix: preserve the last-used server/channel where safe, expose the current server/channel as a compact scope line, and add a Today action. Keep this independent of new Sheets reads.

Suggested command: `$impeccable optimize`

### [P2] Screen-reader orientation is incomplete outside the new local landmarks

Why it matters: the local navigation groups are now well labeled, but browser evidence found no main landmark or H1 on the selected schedule route, and the global header navigation has no accessible label. Visual users can infer the hierarchy; assistive-technology users receive less structural orientation.

Fix: establish one page-level heading and main landmark, label the global navigation, and preserve the existing `aria-current` behavior on selected server and Schedule states.

Suggested command: `$impeccable audit`

## Cognitive Load

Passes:

- Schedule and administration are now visually grouped.
- Active server, active destination, and permission state are easy to identify after selection.
- Permission-gated admin controls and collapsible editor sections provide useful progressive disclosure.

Failures:

- Sheet Map exposes five sibling sections: Overview, Users, Teams, Schedules, and Runners.
- The editor combines global chrome, server context, server navigation, editor navigation, lifecycle status, and sticky draft actions in one decision space.
- The icon-first server rail and silent first-channel default create working-memory demands.

Overall load is moderate for the chooser and schedule, and high inside Sheet Map.

## Emotional Journey

- Chooser: clear intent, but low confidence in which icon to click and whether an empty state is normal.
- Selected server: strongest state in the product; server identity, scope, active destination, and permission status reassure.
- Schedule: operationally credible through channel tabs, date state, timezone, and calendar markers; first-channel selection slightly weakens confidence.
- Administration: careful and trustworthy on desktop; more isolated on mobile when server navigation disappears.

## Persona Red Flags

**Alex, power user**

- The icon-only server rail has no recent, pinned, or keyboard quick-switch path.
- Returning to the dashboard adds a chooser step before the last-used server/channel.
- Schedule defaults to the first channel, so Alex must reorient manually.
- No shortcut or batch navigation layer is evident.

**Sam, accessibility-dependent user**

- Server names are available semantically but not visibly in the rail; title-based discovery is weak at zoom and on touch.
- The new local landmarks and live `aria-current` states are good, but page-level structure lacks a clear H1/main landmark and the global header nav lacks an accessible label.
- Low-emphasis metadata such as the server ID can be difficult to perceive at reduced opacity.

**Jordan, first-timer**

- The chooser references the “Servers rail,” but the rail looks like unlabeled avatars.
- `Sheet Map`, `Active Server`, and `Server Administration` assume product vocabulary.
- An empty or failed server list gives no next action.
- `Dashboard` does not describe the server chooser it opens.

## Minor Observations

- Schedule is now a one-item group with no visible group label, while Server Administration has one. That asymmetry may be intentional, but it weakens the grouping logic.
- The raw guild ID is useful for debugging but competes with the human-readable server name in routine use.
- The mobile server row has little visible overflow guidance.
- The legacy `/dashboard/shifts` redirect is harmless and should remain absent from visible navigation.
- The two detector findings are intentional low-risk micro-label exceptions, not navigation defects.

## Questions to Consider

- Should the first dashboard decision be “which named server do I want to operate?” rather than “which icon is this?”
- Is Sheet Map genuinely an everyday peer of Schedule, or advanced server administration?
- When a user returns to the dashboard, should it remember the last server and schedule channel?
