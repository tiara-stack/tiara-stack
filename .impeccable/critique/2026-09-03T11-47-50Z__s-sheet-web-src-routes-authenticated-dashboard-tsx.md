---
target: dashboard navigation as a whole
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
timestamp: 2026-09-03T11-47-50Z
slug: s-sheet-web-src-routes-authenticated-dashboard-tsx
---
# Dashboard navigation critique

Method: dual-agent (A: Noether · B: Kant)

## Design health score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Active server, Schedule tab, permission state, month, scheduled-day marker, and timezone are visible. Freshness and selected-date status are not. |
| 2 | Match system / real world | 3/4 | Server, Schedule, Settings, and timezone fit the Discord scheduling model. “Sheet Map,” raw IDs, and “T7” need insider knowledge. |
| 3 | User control and freedom | 3/4 | Browser navigation, month controls, date links, Escape, and focus return work. The chooser offers no recovery path. |
| 4 | Consistency and standards | 3/4 | Teal active states are coherent. The mobile Dashboard link has no active styling, and the global and local active states can compete. |
| 5 | Error prevention | 2/4 | Permission gating helps. Icon-only server selection, truncation, and ambiguous empty states invite mistakes. |
| 6 | Recognition rather than recall | 2/4 | The selected server is clear after entry, but multiple servers would require remembering icons or using hover labels. |
| 7 | Flexibility and efficiency | 3/4 | Persistent server navigation supports repeat use. There is no Today action, recent-server affordance, or shortcut layer. |
| 8 | Aesthetic and minimalist design | 3/4 | The dark, teal operational language is restrained and product-specific. The chooser has a large amount of empty space for one sentence. |
| 9 | Error recovery | 1/4 | Metadata failures are collapsed into empty results, with no visible retry or explanation. |
| 10 | Help and documentation | 2/4 | Docs are reachable from the header, but the UI does not explain server scope, Sheet Map, permissions, or an empty schedule. |
| **Total** |  | **25/40** | Coherent for an experienced operator, but not yet confidence-building for first-time or failure states. |

## Design-specificity verdict

The interface is moderately product-specific. “Active server,” Discord guild imagery, “Scheduled Days,” timezone, Sheet Map, and the server-scoped layout clearly belong to SheetWeb. The color system also has a point of view.

The interaction model still resembles a generic admin shell. The icon-only server rail, uppercase navigation, raw guild ID, and channel label “T7” could be carried into another dashboard by swapping the nouns.

The deterministic scan found 96 findings across the wider sheet-web/src tree. Most are outside this navigation review: 89 font-size advisories, four color advisories, and landing-page findings for gradient text, Inter, and a grid background. No detector finding was reported in the primary dashboard.tsx route. The four font-size findings touching dashboard schedule/server files are real consistency signals, but they are not the reason this navigation feels difficult.

No user-visible overlay is available. The browser preflight mutation succeeded, but the injected detector script failed to execute from the temporary server, so no overlay findings are claimed.

## Overall impression

The simplification worked. /dashboard now leads to the server chooser, the unfinished “My Shifts” entry is no longer in primary navigation, and Preferences lives with account actions. The first decision is now clear: choose a server.

The remaining problem is confidence. The chooser is so sparse that it can look unloaded. After entry, users must reconstruct scope across global navigation, server navigation, channel navigation, and calendar navigation. When metadata fails, the UI does not explain whether there are no servers or whether loading failed.

## What is working

- The dashboard no longer presents a dead-end “Coming Soon” destination. The legacy /dashboard/shifts path remains compatible but redirects away.
- The selected server is now legible through the teal ring, active Schedule state, server name, permission status, channel, month, and timezone.
- The mobile drawer has solid interaction behavior. It traps focus, closes with Escape, restores focus, locks body scrolling, and fits without horizontal overflow.
- The changes respect the quota constraint. They add no Google Sheets reads and do not invent a new dashboard data model.

## Priority issues

### [P1] The chooser still looks ambiguous

The landing state is a large panel containing only “SELECT A SERVER FROM THE SIDEBAR.” The server rail presents an icon, with the name exposed mainly through its accessible label or hover behavior.

Why it matters: a first-time user cannot tell whether this is the intended starting point, a no-access state, or a failed server load.

Fix: keep this metadata-only and quota-safe. Add a clear “Choose a server” heading and one sentence explaining that schedules and settings are scoped to a Discord server. If the server list stays icon-only, provide a deliberate name reveal or a compact chooser list.

Suggested command: $impeccable clarify

### [P1] Scope is still split across too many local layers

After selection, scope is spread across the server rail, server tabs, channel tabs, and calendar controls. The server header repeats the name and raw guild ID, while the channel can appear only as “T7.” Assessment B also found both global Dashboard and nested Schedule reporting aria-current="page".

Why it matters: repeat users have to rebuild “which server, which channel, which view, which date” from separate rows. First-timers may not understand which navigation layer they are changing.

Fix: make one compact scope line explicit, such as Server / Channel / Schedule, and visually subordinate local navigation to it. De-emphasize the raw guild ID in routine work. Keep only the genuinely useful server actions in this view.

Suggested command: $impeccable shape

### [P1] Empty, loading, and error states feel the same

The guild loader catches failures as empty results, while the UI presents a quiet empty state. There is no visible retry, sync status, or distinction between “no servers,” “no selection,” and “temporary failure.”

Why it matters: this is the point where an operator decides whether to wait, refresh, or assume their setup is wrong. The current design makes that decision impossible.

Fix: distinguish existing metadata/session states and add retry or recovery copy without touching the Sheets API. Keep schedule data out of the initial state until caching and quota behavior are settled.

Suggested command: $impeccable harden

## Cognitive load

- Pass: the initial chooser presents one primary decision.
- Pass: the selected server exposes at most three server-level choices.
- Partial: the calendar grid is spatially familiar, but the schedule dot has no legend.
- Fail: icon-only servers require memory, especially when several servers are available.
- Fail: Sheet Map, T7, raw guild IDs, and permission wording are not self-explanatory.
- Fail: normal empty, loading, and error states are not distinguishable.
- Partial: the mobile drawer simplifies global navigation but removes local server/channel context.

The important remaining decision points are server, server-level view, and channel. Calendar navigation is not the main overload.

## Emotional journey

Arrival feels controlled but slightly broken because the chooser has almost no explanation. Selecting a server creates relief because the teal state, server name, and permission status clarify where the user is. The schedule view is calm and operational, but the tiny dots and missing freshness signal make the ending feel skeletal. On mobile, the drawer is deliberate and accessible, but it hides the work context.

## Persona red flags

Power user:

- No Today shortcut or keyboard shortcut layer.
- Repeated navigation crosses server, channel, and calendar layers.
- Multiple servers depend on recognizing icons.

First-timer:

- The first instruction is an all-caps sentence with no explanation.
- Sheet Map, T7, and raw IDs arrive without context.
- An empty server list has no next step or retry path.

Mobile user:

- The global drawer does not show current server or channel.
- Dashboard is not visibly marked active in the drawer.
- Long server names truncate in the selected-server header.
- Calendar dots remain unexplained at a small viewport.

## Minor observations

- The raw guild ID adds noise during routine schedule work.
- A single channel tab may not justify its own navigation row.
- Scheduled Days needs a legend or clearer visual explanation.
- The account button is exposed as the user’s name, not “Account,” which weakens discoverability.
- The mobile drawer includes both the user identity and account actions as separate entries, while desktop groups them under the account trigger.

## Questions to consider

- If the chooser must stay thin until Sheets caching is solved, what is the minimum copy that makes it feel intentional?
- Should the next dashboard home remain a server picker, or eventually become a cached Zero-backed summary?
- Should Settings and Sheet Map remain inside the schedule navigation, or move into a separate server administration area?
