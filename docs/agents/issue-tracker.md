# Issue tracker: Linear

Issues and PRDs for this repository live in Linear under the `tiara-stack` team. Use the configured Linear integration for all operations and always scope searches and new issues to that team.

If a Linear integration is unavailable, ask the user to enable or provide access to one. Do not silently fall back to GitHub Issues.

## Workflow

- **Backlog**: New work starts here.
- **Todo**: Approved work that is ready to be picked up.
- **In Progress**: Work currently being implemented.
- **Done**: Completed work.

Triage labels and workflow statuses are separate. Labels describe the issue's triage role; statuses describe its progress through the workflow.

## Conventions

- **Create an issue**: Create it in the `tiara-stack` team with status `Backlog`.
- **Read an issue**: Fetch its description, status, labels, comments, assignee, parent or children, and blocking relationships.
- **Search for issues**: Search within the `tiara-stack` team by identifier, title, status, or label.
- **Comment on an issue**: Add the update to the issue's activity thread.
- **Apply or remove labels**: Use the mappings in `triage-labels.md`.
- **Approve work**: Move the issue from `Backlog` to `Todo`.
- **Start work**: Move the issue to `In Progress`.
- **Complete work**: Add a concise completion note and move the issue to `Done`.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the `tiara-stack` team with status `Backlog`.

## When a skill says "fetch the relevant ticket"

Resolve the supplied Linear identifier or URL and fetch the complete issue, including comments, labels, and relationships.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a parent Linear issue with child issues as tickets.

- **Map**: A Linear issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog sections.
- **Child ticket**: A sub-issue of the map carrying a `wayfinder:<type>` label (`research`, `prototype`, `grilling`, or `task`).
- **Blocking**: Use Linear's native blocking relationships. A ticket is unblocked when every issue blocking it is in `Done`.
- **Frontier query**: Find the map's child issues that are not `Done`, have no open blocker, and have no assignee. Follow their order under the parent.
- **Claim**: Assign the issue to the current developer and move it to `In Progress`.
- **Resolve**: Add the answer or completion note, move the issue to `Done`, and add a context pointer to the map's Decisions-so-far.
