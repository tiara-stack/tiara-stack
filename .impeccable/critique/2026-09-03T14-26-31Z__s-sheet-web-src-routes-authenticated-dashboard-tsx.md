---
target: dashboard navigation mobile density pass
total_score: 26
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-09-03T14-26-31Z
slug: s-sheet-web-src-routes-authenticated-dashboard-tsx
---
# Dashboard navigation critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Active server, route, disclosure state, and access status are clear. The no-channel schedule state still looks blank. |
| 2 | Match between system and real world | 3/4 | Discord/server language fits. “Sheet mappings” and nested server labels need more context. |
| 3 | User control and freedom | 3/4 | The disclosure, browser navigation, drawer close, and settings blockers provide good exits. |
| 4 | Consistency and standards | 3/4 | The visual system is cohesive, but several navigation layers look too similar. |
| 5 | Error prevention | 3/4 | Permission gating and configuration safeguards are strong. Empty schedule routing is not. |
| 6 | Recognition rather than recall | 2/4 | Server names still depend on icon recognition or hover/focus discovery. |
| 7 | Flexibility and efficiency | 2/4 | No shortcut layer, named server search, or retained server/channel context. |
| 8 | Aesthetic and minimalist design | 3/4 | The mobile disclosure reduced clutter. The overall shell still stacks several navigation layers. |
| 9 | Error recovery | 2/4 | Settings recovery is good. A server with no schedule channel has no visible next action. |
| 10 | Help and documentation | 2/4 | Docs exists, but navigation and mapping terminology lack contextual help. |
| **Total** |  | **26/40** | **Acceptable. The foundation is solid, but mobile orientation and empty-state confidence still need work.** |

## Design specificity verdict

The visual language is clearly authored for SheetWeb: green-black control surfaces, teal state signaling, Discord servers, channels, permissions, and Sheets configuration.

The navigation model still feels partly like a generic server-admin shell wrapped around a scheduling product. The new mobile disclosure improves the worst density problem, but the schedule is still competing with server context before users reach the actual work.

The detector found 98 findings across `packages/sheet-web/src`: 2 warnings and 96 advisories. Most are outside this navigation scope:

- 91 font-size advisories, including three adjacent typography findings in `$guildId.tsx`
- 4 color advisories
- 1 decorative grid advisory
- 1 gradient-text warning
- 1 overused-font warning

The direct dashboard target had no detector findings. Inter, the grid treatment, focus color, and gradient text are intentional or outside this navigation review.

## Overall impression

This is a meaningful improvement. On mobile, Schedule stays visible, administration is secondary, and admin links expand into usable 44px targets. At 320px, the disclosure stays on one line with no horizontal overflow.

The remaining problem is orientation. The first mobile viewport is still mostly server context, and a server with no configured schedule channel still lands in a shell that appears empty.

## What's working

- The mobile Server Administration disclosure is the right pattern. It is route-aware, keyboard-operable, uses `aria-expanded` and `aria-controls`, and keeps secondary actions out of the default path.
- Permission-aware navigation is clear. Server Settings and Sheet Mappings only appear when the user can use them.
- Server selection, active route styling, `aria-current`, skip navigation, labeled regions, and the selected-server identity all reinforce scope well.

## Priority issues

### [P1] Mobile still gates the schedule behind too much server context

Why it matters: At 320px, the schedule control begins around y=289, after the header, server switcher, selected-server identity, and surrounding spacing. Channel navigation and schedule content come later. The admin disclosure fixed one layer, but the page still feels like a server control panel before it feels like a schedule.

Fix: compress the selected-server identity into a single mobile scope bar. Hide the Discord ID on mobile, keep Schedule as the visible page heading, and reserve the disclosure for administration only.

Suggested command: `$impeccable adapt`

### [P1] A server with no schedule channel still looks broken

Why it matters: The live schedule route exposed the shell and an `sr-only` “Schedule” heading, but no visible schedule content or recovery instruction. Users cannot tell whether the server is loading, empty, or misconfigured.

Fix: render a visible parent-level empty state such as “No schedule channels configured,” explain that an administrator must configure one, and link to Server Settings → Channels when permitted.

Suggested command: `$impeccable harden`

### [P2] Server switching remains icon-first

Why it matters: Icons are efficient for experienced Discord users, but names are mainly discovered through `title` or hover/focus tooltips. Touch users cannot hover, and first-time users must guess what an icon represents.

The tradeoff is clear:

- Icons keep the rail compact and feel familiar to Discord users.
- A named chooser is easier to learn and supports many servers, but takes more space and adds another visible control.

Fix: keep the icon rail as the desktop shortcut. Use a named server row or chooser on mobile and on the initial server-selection state, using the already-loaded server names without adding Sheets reads.

Suggested command: `$impeccable adapt`

### [P2] Navigation touch targets are still inconsistent

Why it matters: The new disclosure and its links measure 44px, but the Schedule link and global menu trigger measure about 40px. Channel tabs and some drawer controls are smaller still. This matters for one-handed use and motor accessibility.

Fix: establish one mobile navigation target size of at least 44px for Schedule, the menu trigger, drawer links, and channel tabs. Keep horizontal scrolling for channel tabs, but enlarge their hit areas.

Suggested command: `$impeccable audit`

### [P2] Settings repeats the same hierarchy at two levels

Why it matters: Users see `SERVER ADMINISTRATION` → `SERVER SETTINGS` or `SHEET MAPPINGS`, then `CONFIGURATION CONSOLE` → `SERVER` or `CHANNELS`. The repeated “server” labels make it unclear which control changes the page and which changes a page section.

Fix: make the hierarchy explicit. For example, use `SETTINGS` as the page-level destination, then show `Server settings` and `Sheet mappings` as sibling pages, with `Server` and `Channels` clearly subordinate section tabs.

Suggested command: `$impeccable clarify`

## Persona red flags

Alex, power user:

- No keyboard shortcuts or faster command path between schedule, settings, and preferences.
- The former personal-shifts destination now redirects to server selection, leaving the primary user job ambiguous.
- Mobile administration adds a disclosure step, even though this is a reasonable density tradeoff.
- No retained server/channel context means repeated sessions begin with reorientation.

Sam, accessibility-dependent user:

- The disclosure has good ARIA state and 44px targets.
- The server rail is still visually icon-only, even though links have accessible names.
- Schedule is represented mainly by active styling and a screen-reader-only heading.
- Several neighboring controls remain below 44px.

Jordan, first-time user:

- “Choose a server” followed by a visual icon is not a clear first action.
- “Sheet mappings,” “Fill,” and “Channels” assume product knowledge.
- A server with no configured channel gives no visible explanation or next step.
- `SERVERS` does not explain whether the destination is for personal schedules, server schedules, or administration.

## Minor observations

- The long Discord server ID helps debugging but adds noise to the mobile identity block.
- `pathname.includes("/settings")` is brittle as the route tree grows.
- Docs still contains “Dashboard” terminology even though the primary destination is now Servers.
- The global menu and settings controls use approximately 40px targets outside the changed disclosure.
- The no-server state has status text but no refresh or reconnect action.

## Questions to consider

- Should the schedule board own the first 640px on mobile, with server identity compressed into one line?
- Is SheetWeb primarily “my shifts” or “a server’s schedule”? The current navigation still suggests both.
- Should the icon rail remain the expert shortcut while the chooser becomes the first-use and mobile pattern?
