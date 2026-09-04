---
score: 27
p0: 0
p1: 3
p2: 2
browser: unavailable
method: source-based
timestamp: 2026-09-04T00-54-24Z
slug: rc-routes-authenticated-dashboard-guilds-index-tsx
---
Target: the authenticated dashboard navigation as a whole, with emphasis on the server chooser, selected-server shell, schedule navigation, server administration, and route naming.

## Design health score

| Heuristic | Score | Assessment |
| --- | ---: | --- |
| Visibility of system status | 3/4 | The active server, active route, loading states, current day, and permission status are visible. Deep route context and unavailable-data states are less clear. |
| Match with the real world | 3/4 | Discord servers, schedules, calendars, and permissions map well to user expectations. "Configuration console" and "sheet mappings" are more product-specific than user-facing. |
| User control and freedom | 3/4 | The rail, named chooser, direct paths, and back-to-server-list link give users exits. The back link always resets to the chooser instead of preserving the previous place. |
| Consistency and standards | 2/4 | The navigation uses several names for the same concepts: SERVERS, YOUR SERVERS, SERVER LIST, Server switcher, and ACTIVE SERVER. Schedule is repeated at parent and child levels. |
| Error prevention | 3/4 | Permission-aware administration links and explicit named server rows help. Icon-only switching and unknown-server routes still make context mistakes possible. |
| Recognition rather than recall | 3/4 | Names are available in the chooser, accessible labels, and focus/hover tooltips. On touch, the rail is still icon-only, and the selected server name truncates on narrow screens. |
| Flexibility and efficiency | 3/4 | The rail is fast for frequent switching and the route structure supports direct links. There is no search, favorite, or named quick-switch path once a user is inside a server. |
| Aesthetic and minimalist design | 2/4 | The visual identity is distinctive, but the selected-server shell stacks back navigation, server identity, schedule, administration, permission status, and schedule content before the user reaches the work. |
| Error recovery | 2/4 | Schedule-unavailable states explain what to do. A failed server-list request can look like an empty server list, and the main navigation has no retry path. |
| Help and documentation | 3/4 | Docs and contextual copy exist. T7-style channels, sheet mappings, and permission terms still need explanation at the point of use. |
| **Total** | **27/40** | **Acceptable, close to good. Consistency, persistent server recognition, and failure recovery are holding it back.** |

## Design specificity verdict

The navigation feels authored for this product in the Discord server rail, TiaraBot language, current-day schedule, and permission-aware administration. The chooser and route hierarchy are not generic dashboard patterns anymore.

The remaining interchangeable parts are the repeated uppercase control labels and generic list treatment. They make the navigation feel like a themed admin template when the user is already in a very product-specific workflow.

The deterministic scan returned advisory findings, not critical errors. Most were design-system drift in small text sizes such as 8px, 9px, and 11px, concentrated in the daily schedule, server settings, and sheet editor. Representative locations include `daily.tsx:589` and `:622`, `settings.tsx:546`, `:679`, `:1114`, and `:1468`, `settings.sheet.tsx:1703`, `:1707`, and `:1761`, plus the selected-server shell at `$guildId.tsx:56`, `:67`, and `:133`. The scan also identified an undocumented focus color in the sheet editor. These are quality advisories, not the main information-architecture problem.

There is no fresh browser evidence for this pass. Both `preview_status` and `preview_open` failed because no preview automation host is available. The latest available deployment evidence showed the named chooser, the persistent rail, the selected-server back link, and the current-day schedule rendering on desktop and mobile. I am not treating those earlier screenshots as a fresh visual verification.

## Overall impression

The flow is now understandable: choose a server, enter its current schedule, then open server administration when needed. The named chooser is a good entry point, and the rail is a good accelerator.

Inside a server, though, the shell is still doing too much. On mobile it asks the user to parse a back link, server identity, schedule link, administration disclosure, and then another schedule heading before the actual schedule. On desktop it adds a permission-status banner to that stack. The page has a clear destination, but the route chrome competes with it.

The most important next move is to keep the named server context persistent while reducing duplicate navigation. The rail can remain. It should not be the only fast switcher a user can understand without hovering.

## What's working

- The chooser now exposes full server names and a clear action, while the rail preserves quick switching. That is a useful combination for first-time users and returning users.
- The URL hierarchy is mostly right. Daily schedule and calendar use different path segments, and server settings, channel settings, and sheet mappings have distinct paths. Date and transition details remain search state, which is appropriate.
- Accessibility fundamentals are stronger than the visual density suggests. The shell has labeled landmarks, `aria-current`, visible focus styles, a skip link, touch-sized controls, and a focus-managed mobile menu.

## Priority issues

### P1. The current server is still too easy to lose on touch

The rail renders avatar or initials only. Its `title` and custom tooltip help on hover and keyboard focus, but not on touch. The selected server heading also uses `truncate`, so a long Discord name is reduced to an unreadable fragment in the compact header. The named chooser solves recognition only at `/dashboard/guilds`, not after a server is selected.

Why it matters: a user with several servers has to remember the icon or go back to the chooser. That turns a persistent context indicator into a memory test, especially on mobile.

Fix direction: keep the rail, but make the current server a named, tap-open chooser in the selected-server header. Let the full name wrap or reveal on demand. The chooser and rail can share the already loaded guild list, so this does not require new Sheets API work.

Suggested next instruction: `Adapt the selected-server shell so the current server name is always available on touch, while retaining the icon rail for fast switching.`

### P1. The selected-server shell duplicates the schedule hierarchy

The parent layout contains `BACK TO SERVER LIST`, the active server card, a `SCHEDULE` link, and server administration. The child schedule layout then starts with `SCHEDULE / #channel`, followed by channel tabs. The desktop shell also adds `MANAGE SERVER ACCESS VERIFIED`.

Why it matters: the schedule-first goal gets pushed below a control panel. The same concept is announced and displayed at two levels, and the administration status reads like another navigation item even though it is only status.

Fix direction: let the schedule page own its schedule heading and channel navigation. In schedule mode, make the parent a compact server context bar with the named chooser and administration entry. In administration mode, show a clear `Back to schedule` link. Move permission verification into the settings context or reduce it to a quiet status treatment.

Suggested next instruction: `Distill the selected-server shell into a named server context bar, one contextual back action, and one secondary administration entry. Remove repeated SCHEDULE labels from the schedule route.`

### P1. Empty membership and failed server loading look identical

The guild layout catches the server-list loader failure and falls back to an empty array. The chooser and rail then show `NO SERVERS AVAILABLE`, with copy telling the user to join or be invited to a Discord server. There is no retry action in that navigation state.

Why it matters: an outage, stale session, quota issue, or Discord request failure can tell an existing user to join a server again. Since the server chooser is the dashboard gate, this is a navigation failure, not just a data-state detail.

Fix direction: preserve the distinction between loading, no memberships, and unavailable server data. Show `Could not load servers` with `Retry` for the failure state, and retain the last successful list when possible. This is also the safest direction for reducing unnecessary upstream requests.

Suggested next instruction: `Clarify the server chooser states so no servers, loading, and failed server loading have distinct copy and recovery actions without adding any Sheets API calls.`

### P2. The vocabulary still shifts as users move through the shell

The same area is called `SERVERS`, `YOUR SERVERS`, `SERVER LIST`, `Server switcher`, and `ACTIVE SERVER`. Administration is labeled `SERVER ADMINISTRATION`, `SERVER SETTINGS`, `SERVER`, and `SHEET MAPPINGS`. The schedule channel tab displays `T7`, while the page heading displays `#t7`.

Why it matters: the app asks new users to learn Discord and TiaraBot concepts already. Changing labels adds avoidable translation work. All-caps labels with wide tracking also slow reading for people scanning quickly or enlarging text.

Fix direction: choose one noun set and use it everywhere. For example: `Servers`, `Switch server`, `Back to servers`, `Manage server`, `Server settings`, and `Google Sheets setup` or `Sheet mappings`. Use one channel presentation, such as `#T7` in both the tab and heading. Keep the visual style, but reserve all-caps microcopy for short status labels.

Suggested next instruction: `Clarify dashboard navigation terminology and accessibility. Standardize server, administration, sheet, and channel labels, and reduce all-caps microcopy.`

### P2. Personal settings do not belong in the server dashboard namespace

`/dashboard/preferences` is account-level DM notification configuration, reached from the account menu rather than the server rail. That is the right visible placement, but the URL and dashboard grouping imply that it is server context. `/dashboard/shifts` is now only a redirect.

Why it matters: the dashboard is becoming a server-and-schedule workspace. Personal notification settings and a retired shifts route make the boundary less clear for deep links, bookmarks, and future navigation.

Fix direction: keep preferences in the account menu, but consider an account-oriented path such as `/settings/notifications` or `/account/preferences`. Keep the shifts URL only as a compatibility redirect and do not give it a visible navigation identity.

Suggested next instruction: `Clarify the dashboard boundary. Keep server schedule and administration in the dashboard, move personal notification settings to account settings, and preserve shifts only as a redirect.`

## Persona red flags

Jordan, a first-time filler, will understand `YOUR SERVERS` and `OPEN SCHEDULE`. They may not understand why the same server is represented by an icon after entry, what `T7` means, or why `SHEET MAPPINGS` is relevant to them. The first schedule should be reachable without decoding the admin vocabulary.

Sam, an accessibility-focused user, gets real benefits from the skip link, landmark labels, `aria-current`, focus outlines, and minimum touch sizes. The weak point is recognition at the rail: a hover tooltip is not a touch affordance, and the active server name can be truncated. Repeated schedule and administration landmarks also add noise to the navigation sequence.

Alex, a power user, gets a fast rail and useful path-based URLs. Alex still has to return to the chooser to get named server context, and there is no search, favorite, or keyboard-efficient named switcher when the server list grows.

## Minor observations

- The rail heading and global header both say `SERVERS`. One can be the global destination, while the other should describe switching within the dashboard.
- The schedule channel list is horizontally scrollable but has no visible overflow cue. This is acceptable for a short list, but it becomes a discoverability problem as channels grow.
- `Unknown server` is a reasonable fallback label, but a direct deep link should also offer a clear `Back to servers` recovery path rather than looking like a valid selected-server context.
- The compact shell uses very small status text. The detector's 8px, 9px, and 11px findings are especially relevant here because navigation labels should be among the easiest text to scan.
- The route split between daily and calendar is a good decision. The remaining query parameters describe date or transition origin, so they do not undermine the main-content path rule.

## Questions to consider

1. Should the named chooser become the canonical server switcher, with the rail treated as a fast-access shortcut?
2. When the user is already on schedule, does the parent `SCHEDULE` link add value, or should the schedule page own that label and the parent only expose server context and administration?
3. Is `/dashboard/preferences` intended to be account settings? If so, should the URL move even if its visible entry remains in the account menu?
