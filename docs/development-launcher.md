# Development launcher

The root `pnpm dev` command is the single entrypoint for local development
mode selection. The core launcher validates input, reads only mode-approved
configuration, checks prerequisites, and prints a process plan. This slice does
not start Fast, Compose, or Kubernetes workloads.

## Commands

```text
pnpm dev
pnpm dev fast
pnpm dev fast up
pnpm dev compose <up|build|down|seed|reset>
pnpm dev kubernetes <validate|preview>
pnpm dev doctor
pnpm dev setup <fast|compose|kubernetes>
```

The bare command and a mode without an action print help and do no deployment,
process start, or destructive work. Compose reset requires
`--confirm`. Kubernetes preview requires `--tag <image-tag>` and
`--confirm-development`.

Every command accepts `--json` for the stable machine-readable result. Commands
that read a file accept `--env-file <path>`. A mode can restrict its process
plan with `--service <package-name>` in Fast or Compose mode. Kubernetes
preview always applies the complete development release.

Use `pnpm dev <mode> help` for mode-specific help. `--help` is reserved for
Effect CLI's generated root help.

## Mode matrix

| Mode | Runtime processes | Allowed origins | State boundary |
| --- | --- | --- | --- |
| Fast | `sheet-web` on the host | local app plus the development auth, Zero, and workflow endpoints | shared Fast development sandbox |
| Compose | packaged runtime containers and local dependencies | loopback URLs only | the selected local Checkout State |
| Kubernetes | fixed development preview release | `*.dev.theerapakg.moe` endpoints | shared Kubernetes Development Sandbox |

Fast passes only these values to the planned `sheet-web` process:

```text
APP_BASE_URL
AUTH_BASE_URL
SHEET_ZERO_BASE_URL
SHEET_WORKFLOWS_BASE_URL
```

Database URLs, Redis URLs, service tokens, Google credentials, Discord tokens,
and Compose credentials are not valid Fast configuration. The launcher rejects
production origins and mixed-mode environment keys before any process boundary
can run.

Compose uses `deploy/compose/.env` by default. Generate it with
`pnpm compose:generate-secrets`. The existing commands remain available:

```text
pnpm compose:generate-secrets
pnpm compose:migrate-sheet-db
```

Kubernetes validation renders the existing chart with the development values.
Preview is fixed to release `tiara-stack-dev` in namespace `tiara-stack-dev`
and the development registry. Set `KUBE_CONTEXT=tiara-stack-dev` and pass
`--confirm-development` before preview. It cannot target production values
through the launcher configuration.

`setup <mode>` is reserved for the mode-specific setup implementations. The
core command reports it as unavailable until those implementations land.

## Ports and output

The launcher uses deterministic assignments. The initial assignments include
port 3001 for `sheet-web`, 3002 for `sheet-auth`, 3003 for
`sheet-workflows`, 4848 for Zero Cache, and 9464 for Prometheus. An occupied
port is an error. The launcher never selects a random replacement.

Fast accepts `DEV_SHEET_WEB_PORT` as an explicit override. Its loopback
`APP_BASE_URL` must use the same port.

Human and JSON output report the selected mode, action, services, planned
processes, URLs, readiness, warnings, and errors. Error records include a
stable category, the relevant mode and dependency, and a remediation. Secret
values never appear in output or process plans.

## Doctor

`pnpm dev doctor` runs short, read-only checks for Node, pnpm, vite-plus, Docker
Compose, Helm, kubectl, deterministic loopback ports, the development HTTP
dependencies, and the optional local observability sink. Required failures
block readiness. An observability failure is a warning and does not block the
doctor result. Every external command goes through the launcher process
executor with a bounded timeout.

The process executor is the replacement seam for tests and later mode
implementations. Core mode commands produce plans and leave execution to those
future adapters.
