---
target: dashboard navigation URL path + accessibility pass
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
timestamp: 2026-09-03T17-13-37Z
slug: s-sheet-web-src-routes-authenticated-dashboard-tsx
---
# Dashboard navigation critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Active server, route, disclosure state, timezone, and access status are clear; the direct daily view can remain on an unhelpful loading state. |
| 2 | Match between system and real world | 2/4 | Server and calendar concepts fit, but raw guild IDs, `t7`, epoch timestamps, and technical administration terms remain visible. |
| 3 | User control and freedom | 3/4 | Path-based settings, back links, channel navigation, server switching, and the mobile disclosure provide good exits; day-level stepping is still missing. |
| 4 | Consistency and standards | 3/4 | Active states and visual language are coherent, but `t7` versus `#t7`, repeated settings labels, and nested selection semantics are not fully consistent. |
| 5 | Error prevention | 3/4 | Permission gates and destructive confirmations are thoughtful; first-channel selection and the daily loading failure are too implicit. |
| 6 | Recognition rather than recall | 2/4 | Icon-only server switching and terse channel labels still make users remember mappings, especially on mobile. |
| 7 | Flexibility and efficiency | 2/4 | Deep links now reflect the main settings content, but the daily route is unreliable and `/dashboard/shifts` still redirects to server selection. |
| 8 | Aesthetic and minimalist design | 3/4 | Mobile is meaningfully less dense, but the server card, schedule controls, and administration still push calendar work down the page. |
| 9 | Help users recognize and recover from errors | 2/4 | The no-channel state is explicit, but the daily loading state has no visible retry or escalation path. |
| 10 | Help and documentation | 2/4 | Global Docs exists, but schedule behavior and terms such as sheet mappings and lockdown controls lack contextual explanation. |
| **Total** |  | **25/40** | **A usable foundation with improved structure, held back by schedule-route recovery, server orientation, and terminology.** |

## Design specificity verdict

The dark green-black, electric-teal control-room language is clearly authored for SheetWeb. Discord servers, channels, permissions, timezone, drafts, and Sheets configuration give the product a real domain identity. The navigation model still partly resembles a generic admin shell wrapped around a scheduling product.

The Impeccable detector was run against `packages/sheet-web/src/routes/_authenticated/dashboard.tsx` and returned JSON `[]` with 0 findings. Fallow is a separate code-health signal: the final audit reported 10 above-threshold findings, including 3 complexity findings (notably `ScheduleContent` in `$guildId.schedule.tsx`), 4 clone groups / 163 duplicated lines in the existing calendar file, and 28 large functions across the sheet/settings UI. Those are maintainability follow-ups, not visual detector failures. The detector’s absence of findings is credible for the targeted dashboard route; it does not certify the broader shell.

## Overall impression

This pass is structurally better. Schedule is visible on mobile, administration is a secondary disclosure, settings content is encoded in paths, and the direct schedule entry now lands on a channel calendar. At 320px there is no horizontal overflow, and the main mobile schedule/admin controls are 44px high.

The remaining concern is orientation and operational confidence. A first-time mobile user still sees an icon rather than a named server choice, calendar dates arrive around y545 in an 844px viewport, and the direct daily URL can remain on “Loading schedule…” without a next action.

## What’s working

- The mobile server-administration disclosure is route-aware, keyboard-operable, uses `aria-expanded` / `aria-controls`, and keeps secondary actions out of the default schedule path.
- The main settings split now uses `/settings/server`, `/settings/channels`, and `/settings/sheet`; the legacy `?section=channels` URL normalizes to `/settings/channels`.
- Permission-aware links, active route treatment, labeled server controls, skip navigation, timezone context, and draft/confirmation states form a strong foundation.

## Priority issues

### [P1] The direct daily schedule route can stall without recovery

What: A fresh visit to `/dashboard/guilds/:guildId/schedule/:channel/daily` remained on “Loading schedule…” for more than 15 seconds, with no visible retry or escalation path.

Why it matters: Daily view is a main-content route. A user who follows a deep link cannot tell whether data is empty, still loading, or broken.

Fix: Give the daily loader the same explicit failure/empty contract as the calendar route; add a visible retry action and a clear fallback back to the channel calendar. Preserve the path-based view route and keep only date/view state in search.

Suggested command: `$impeccable harden`

### [P1] The server switcher is still a shortcut, not a chooser

What: The rail exposes a 48px icon with a name on hover/focus, while the `CHOOSE A SERVER` route tells users to use the switcher instead of presenting named server options.

Why it matters: Icons are excellent for experienced Discord users and keep the rail compact, but touch users cannot hover and first-time users must guess. The current chooser route does not resolve that orientation problem.

Fix: Keep the icon rail as the desktop power-user shortcut. On mobile and the initial server-selection state, use a named server chip/list or bottom sheet with icon, server name, and selected state. This can use the already-loaded Discord guild list and does not require new Sheets reads.

Suggested command: `$impeccable adapt`

### [P1] Schedule is improved, but not yet schedule-first enough on mobile

What: The schedule link is visible at about y193, the schedule heading at y306, and calendar dates begin around y545 on a 390×844 viewport. Administration is collapsed, but server context still consumes most of the first screen.

Why it matters: The primary job is to inspect or act on a schedule; the first useful schedule content should dominate the opening viewport.

Fix: Collapse server identity into a compact scope bar, make the current date/day the first actionable schedule surface, and add an explicit Calendar/Daily + Today control. Keep channel context in the path.

Suggested command: `$impeccable simplify`

### [P2] Settings paths are better, but the hierarchy and language still repeat themselves

What: The shell says `SERVER ADMINISTRATION`, the entry says `SERVER SETTINGS`, the page says `CONFIGURATION CONSOLE` / `Server settings`, and the section tabs say `SERVER` / `CHANNELS`. `/settings/channels` retains the h1 “Server settings.”

Why it matters: Users cannot immediately tell which label is the page, which is the section, and which is the capability. Technical phrases such as “Sheet mappings” and “Lockdown operators” add product vocabulary without explanation.

Fix: Use one page-level label (`Settings` or `Server administration`), then name sibling destinations and subordinate sections in plain language. Give `/settings/channels` its own heading and descriptions. Keep `?timestamp=` only for date/view state; the main settings layout is correctly path-based now.

Suggested command: `$impeccable clarify`

### [P2] Accessibility feedback and navigation targets need one final consistency pass

What: The new schedule/admin links and channel tabs are near the intended 44px target, but the global mobile menu trigger and some drawer controls are about 40px. Calendar/channel changes do not clearly announce the new state, and the direct daily loading state has no recovery action. One independent browser pass also observed a possible transient invisible drawer while focus was trapped; a follow-up after the transition settled reproduced a visible drawer, so this is a regression-test item rather than a confirmed blocker.

Why it matters: Keyboard and touch users need reliable focus, status, and target sizing at the exact points where the navigation model changes.

Fix: Standardize mobile navigation controls at 44px or larger, make the skip target move focus to `main`, announce channel/date changes, use exact current-route semantics, and add automated coverage for the drawer after its transition completes.

Suggested command: `$impeccable audit`

## Persona red flags

- Alex, the power user, benefits from deep links and the desktop rail, but a daily deep link can stall and routine schedule checks still lack a Today/day-stepping shortcut. `/dashboard/shifts` also redirects to server selection, leaving the personal-versus-server job ambiguous.
- Sam, an accessibility-dependent user, benefits from labeled server links and the disclosure state, but still encounters inconsistent target sizes, weak async announcements, and selection/current-route semantics that need verification.
- Jordan, a first-time mobile coordinator, can see the active server name after selection but must identify other servers from icons, and spends most of the opening viewport in server chrome before reaching calendar dates.

## Minor observations

- `TIME ZONE: Asia/Bangkok` is excellent operational context and should remain prominent.
- The selected server’s raw snowflake is useful for debugging but should be secondary or hidden on mobile.
- `SCHEDULE` appears in both the server card and the page content, creating mild repetition.
- Global `SERVERS` navigation and the local server rail represent the same concept twice.
- The mobile settings channel list serializes 23 rows before the editor, making the admin flow very long even though it is technically usable.

## Questions to consider

- Is the icon rail primarily a Discord-familiar power shortcut, or should it be the product’s actual server chooser? The best current compromise is icon rail on desktop plus a named chooser on mobile/first use.
- Is the primary job “my shifts” or “a server’s schedule”? The `/dashboard/shifts` redirect currently leaves that product model unresolved.
- Should the next mobile pass prioritize a named server chooser, a reliable daily route, or a current-day schedule surface?
