---
target: dashboard navigation as a whole
total_score: 22
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 4
timestamp: 2026-09-03T10-34-35Z
slug: s-sheet-web-src-routes-authenticated-dashboard-tsx
---
# Dashboard navigation critique

## Design health score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 2/4 | Active states and save feedback exist, but the default route is a "COMING SOON" placeholder and schedule freshness is unclear. |
| 2 | Match system / real world | 2/4 | Discord terminology fits, but "MY SHIFTS" promises personal operational data that is not there. |
| 3 | User control and freedom | 2/4 | Back links and editor blockers help, but "Dashboard" returns users to the placeholder and the sheet editor hides the normal shell. |
| 4 | Consistency and standards | 3/4 | The visual system is cohesive, but active states, labels, and icon-only controls vary by route. |
| 5 | Error prevention | 2/4 | Permission checks and draft protection are thoughtful, but empty states do not guide recovery. |
| 6 | Recognition rather than recall | 2/4 | Server headers help, but the guild rail, calendar markers, and terse labels require interpretation. |
| 7 | Flexibility and efficiency | 2/4 | Channel tabs and sticky editor actions help, but the common schedule path is deep and has no remembered context or accelerator. |
| 8 | Aesthetic and minimalist design | 3/4 | The control-room look is strong, but redundant headers, equal-weight navigation, and placeholder dead space dilute it. |
| 9 | Help users recover from errors | 2/4 | Settings has retry/status handling, while "NO GUILDS", "NO CHANNELS AVAILABLE", and "COMING SOON" stop users. |
| 10 | Help and documentation | 2/4 | TiaraDocs is reachable, but the dashboard has no contextual help, legend, or terminology guidance. |
| **Total** |  | **22/40** | **Acceptable, 55%. Significant IA work is needed.** |

## Design specificity verdict

The visual language is authored for SheetWeb. Electric teal control surfaces, square tabs, server labels, schedule grids, and permission-gated management actions clearly belong to this product.

The information architecture feels provisional and category-generic. The first question is "which tab do I click?" rather than "what needs attention in this shift?"

The automated detector found no issues in the scanned shell file. It ran against `packages/sheet-web/src/routes/_authenticated/dashboard.tsx` and returned `[]` with exit code 0. That scan did not include the child route files, so it does not clear the full dashboard route group.

Browser evidence was blocked by the authenticated route guard and local environment configuration. Fresh preview tabs opened, but the dashboard resolved to a network/error document or auth redirect, so no authenticated screenshots, console findings, or `[Human]` overlay were produced. The source and route tree were used as the visual evidence for the critique.

## Overall impression

The visual system says "live operations console." The entry route says "unfinished."

`/dashboard` redirects to `MY SHIFTS`, but `dashboard/index.tsx` sends users to `shifts.tsx`, which only renders "COMING SOON." The working schedule is nested behind `GUILDS`, a server icon, a channel, a calendar, and then a day. SheetWeb looks like an operational product before its front door behaves like one.

## Cognitive load

6 of 8 checklist items fail, which is high.

- Pass: chunking and grouping.
- Fail: single focus, visual hierarchy, one thing at a time, minimal choices, working memory, and progressive disclosure.
- The combined shell exposes global navigation, three dashboard tabs, a guild rail, server tabs, channel tabs, and calendar/day controls at once.
- Users must remember the selected server, channel, date, and view while moving through nested routes.

## Emotional journey

- Entry is an immediate valley. Sign-in lands on a placeholder.
- Discovery improves once users enter `GUILDS`; the active server header and local tabs provide useful orientation.
- The calendar feels calm and controlled, and the daily view has a useful live quality.
- High-stakes moments lack reassurance. There is no clear data-updated time, timezone, coverage summary, check-in state, or readiness signal.
- The ending is weak. The global `DASHBOARD` link always returns to the dead-end `MY SHIFTS` page.

## What's working

1. The visual language is coherent and specific. The sharp surfaces, teal signal, and dense control-room structure match the product's operating context.

2. Permission-aware navigation is a good foundation. `SETTINGS` and `SHEET MAP` appear only when the selected user's capabilities allow them.

3. The deeper workspaces have solid local patterns: channel tabs, calendar/day drill-down, draft lifecycle states, sticky editor actions, and unsaved-change protection.

## Priority issues

### [P1] "My shifts" is a false front door

Why it matters: The product promise is about acting on current schedules and check-ins. The first authenticated destination provides none of that. The global `DASHBOARD` link also sends users back to it.

Fix: Either make this the real operational home with current/next shift, open slots, check-in state, coverage gaps, and direct actions, or remove it from primary navigation until it can do that. If personal aggregation is not ready, land users on a useful server picker or the last useful server schedule.

Suggested command: `$impeccable shape`

### [P1] The navigation has too many equal peers and too many layers

Why it matters: The common path is `Dashboard -> Guilds -> server -> channel -> calendar -> day`. `PREFERENCES` has the same visual weight as the operational areas even though it is a personal account setting. `GUILDS` is really a workspace switcher, not a peer destination.

Fix: Use this model:

- `Home` or `Today` as the operational landing page.
- `Servers` as the workspace switcher, with the selected server kept visible.
- `Schedule`, `Manage server`, and `Sheet map` inside the selected server.
- `Calendar` and `Daily` as views inside `Schedule`.
- `Preferences` in the account menu.
- Developer OAuth clients in a separate, permission-gated Developer/Admin area.
- Keep TiaraDocs outside the operational shell, with contextual links from empty and error states.

Suggested command: `$impeccable distill`

### [P1] Context and controls are too dependent on hover, memory, and interpretation

Why it matters: The guild rail shows server icons with names exposed through `title` and `aria-label`, but no visible selected state. The mobile version becomes an icon strip as well. Calendar navigation uses unlabeled chevrons, day links expose only numbers, and schedule markers have no legend.

Fix: Add a visible selected-server treatment, a persistent `Server / Channel / View` context line, explicit `Channels` and `Calendar / Daily` labels, full-date accessible names, a timezone, a `Today` action, and a legend for calendar markers. Prefer `Servers` if that is clearer to users than `Guilds`.

Suggested command: `$impeccable clarify`

### [P1] The dashboard does not surface operational state

Why it matters: A calendar is a record, not a control center. The product context calls out open slots, check-ins, room access, coverage gaps, and handoffs, but the dashboard entry exposes none of them.

Fix: Make the landing page answer "what do I do now?" Put current/next shift, check-in status, open-slot or coverage attention, room/access state, and the next recommended action there. Keep the schedule route as the detailed record. Replace dead-end states with one clear recovery action such as `Configure a server`, `Retry`, `Select a channel`, or `Open TiaraDocs`.

Suggested command: `$impeccable onboard`

## What belongs in and out

| Keep in the dashboard | Move out of primary dashboard navigation |
|---|---|
| Home/Today with current and next personal shift | Preferences, into the account menu |
| Current server and channel context | Developer OAuth clients, into a separate Developer/Admin area |
| Open-slot, coverage, and check-in attention | Sheet Map, into selected-server management |
| Schedule calendar and daily views | Raw documentation, out of the operational shell, but linked contextually |
| Permission-gated server operations | A standalone `GUILDS` peer tab. Keep the server switcher, but make it a workspace control |

The current three-tab arrangement should not remain as-is. `GUILDS` contains the useful structure. `MY SHIFTS` needs to become a real home or disappear.

## Persona red flags

### Alex, power user

- The schedule path requires several route changes before any shift data appears.
- `/dashboard` and the global `DASHBOARD` link return to the placeholder rather than the last useful server context.
- No recent server, recent channel, current-shift shortcut, or keyboard accelerator is visible.
- Alex has to hover over guild icons to identify servers.

### Sam, accessibility-dependent user

- The guild rail has no visible selected treatment.
- Calendar previous/next controls are icon-only, and day links expose only numeric days.
- The calendar's visual markers are not explained in text.
- Small, heavily tracked uppercase labels and low-opacity secondary text may be difficult at zoom or low vision.
- There are good foundations in the mobile drawer, including Escape handling, focus trapping, and an inert background.

### Jordan, first-timer

- `Guilds`, `Sheet Map`, `Active Server`, and `Configuration Console` assume prior product knowledge.
- `SELECT A GUILD FROM THE SIDEBAR` gives no explanation of what a guild is or what happens next.
- Calendar markers have no legend.
- Landing on "COMING SOON" reads as a broken product, not a first step.

## Minor observations

- The dashboard heading always says `YOUR SCHEDULE`, including Guilds and Preferences.
- Chevrons on sibling tabs imply drill-down rather than peer navigation.
- `NO GUILDS` and `NO CHANNELS AVAILABLE` offer no setup or recovery action.
- The global Docs link is useful, but contextual help would be more effective at the point of failure.
- The daily view creates a second scroll context, which is easy to lose during a live shift.

## Questions to consider

- If a filler lands on `/dashboard`, should the first viewport answer "What do I do now?" or "Which server do I open?" The current shell answers neither.
- Can `PREFERENCES` leave the three-button operational nav and return as an account action?
- Is `GUILDS` deliberate user-facing language, or should the UI say `SERVERS` while keeping "guild" in code and documentation?
- What must a calendar cell communicate before users can trust it: scheduled, open, filled, check-in, or a count?
