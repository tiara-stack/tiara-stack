# TiaraStack Monorepo

A comprehensive monorepo containing tools for Google Sheets integration, Discord bot automation, HTTP ingress/proxying, and real-time collaborative applications.

## Overview

TiaraStack is a collection of interconnected services designed to provide seamless integration between Google Sheets, Discord, and web applications. The architecture follows a service-oriented design with shared API contracts, an ingress layer, backend services, and clear package boundaries.

## Architecture

```mermaid
flowchart TB
    subgraph Clients["Client Applications"]
        Web["sheet-web<br/>TanStack Start Dashboard"]
        SheetBot["sheet-bot<br/>Discord Bot"]
        VibeCord["vibecord<br/>Workspace Bot"]
        Formulas["sheet-formulas<br/>Apps Script"]
    end

    subgraph Ingress_Layer["Ingress Layer"]
        IngressAPI["sheet-ingress-api<br/>Shared HttpApi Contracts"]
        IngressServer["sheet-ingress-server<br/>HTTP Ingress & Proxy"]
    end

    subgraph API_Layer["API Layer"]
        SheetAPIs["sheet-apis<br/>Sheet HTTP API Server"]
        Auth["sheet-auth<br/>Auth Service"]
    end

    subgraph Data_Layer["Data & Sync Layer"]
        DBServer["sheet-db-server<br/>Zero Sync Server"]
        Schema["sheet-db-schema<br/>Drizzle ORM Schema"]
    end

    subgraph Infrastructure["Infrastructure"]
        Core["typhoon-core<br/>Shared Utilities"]
        Zero["typhoon-zero<br/>Zero Integration"]
        DFX["dfx-discord-utils<br/>Discord Utils"]
        Atom["start-atom<br/>SSR State Management"]
        GAS["effect-platform-apps-script<br/>GAS HTTP Client"]
    end

    subgraph External["External Services"]
        GoogleSheets["Google Sheets API"]
        Discord["Discord API"]
        Postgres[("PostgreSQL")]
        SQLite[("SQLite")]
    end

    Web -.->|"Typed contracts"| IngressAPI
    Web -->|"Auth"| Auth
    Web -->|"HTTP API Calls"| IngressServer
    Web -.->|"SSR State"| Atom

    SheetBot -.->|"Typed contracts"| IngressAPI
    SheetBot -->|"HTTP API Calls"| IngressServer
    SheetBot -->|"Gateway"| Discord
    SheetBot -.->|"Discord Utils"| DFX

    Formulas -.->|"Typed contracts"| IngressAPI
    Formulas -->|"Apps Script"| GoogleSheets
    Formulas -.->|"HTTP Client"| GAS
    Formulas -->|"HTTP API Calls"| IngressServer

    IngressServer -->|"Authorize / Resolve Users"| Auth
    IngressServer -->|"Forward Sheet Routes"| SheetAPIs
    IngressServer -->|"Forward Discord Cache Routes"| SheetBot
    IngressServer -.->|"Contracts"| IngressAPI

    SheetAPIs -->|"Zero Protocol"| DBServer
    SheetAPIs -->|"Google API"| GoogleSheets
    SheetAPIs -.->|"Uses"| Core
    SheetAPIs -.->|"Uses"| Zero

    Auth -->|"Discord OAuth"| Discord
    Auth -->|"Auth Tables"| Postgres

    DBServer -->|"Queries"| Postgres
    DBServer -->|"Schema"| Schema
    DBServer -.->|"Uses"| Core
    DBServer -.->|"Uses"| Zero

    Schema -.->|"Uses"| Core
    Schema -.->|"Uses"| Zero

    VibeCord -->|"SQLite"| SQLite
    VibeCord -->|"Gateway"| Discord
    VibeCord -.->|"Discord Utils"| DFX
```

## Package Structure

### Core Infrastructure

| Package                       | Description                              | Tech Stack      |
| ----------------------------- | ---------------------------------------- | --------------- |
| `typhoon-core`                | Shared utilities, schema helpers, errors | Effect.ts       |
| `typhoon-zero`                | Shared Rocicorp Zero integration helpers | Rocicorp Zero   |
| `bob`                         | Type-safe configuration builder          | Standard Schema |
| `dfx-discord-utils`           | Discord Effect utilities                 | dfx, unstorage  |
| `effect-platform-apps-script` | Effect HTTP client for Apps Script       | Effect Platform |
| `start-atom`                  | TanStack Start + Effect Atom integration | Effect Atom     |

### Application Services

| Package                | Description                                   | Tech Stack                                       |
| ---------------------- | --------------------------------------------- | ------------------------------------------------ |
| `sheet-apis`           | Main HTTP API server for sheet operations     | Effect.ts, HttpApiBuilder, Playwright            |
| `sheet-ingress-server` | HTTP ingress/proxy for sheet and Discord APIs | Effect.ts, HttpApiBuilder                        |
| `sheet-db-server`      | Real-time sync database server                | Rocicorp Zero, Drizzle ORM                       |
| `sheet-auth`           | Authentication service with Discord OAuth     | Better Auth, Hono, Drizzle ORM                   |
| `sheet-web`            | Web dashboard for guild management            | TanStack Start, React, shadcn/ui                 |
| `sheet-bot`            | Discord bot for sheet workflows               | dfx, Effect.ts, Handlebars                       |
| `vibecord`             | Workspace/session management bot              | dfx, discord-api-types, SQLite, @opencode-ai/sdk |

### Data, Contracts & Integration

| Package             | Description                                        | Tech Stack                    |
| ------------------- | -------------------------------------------------- | ----------------------------- |
| `sheet-db-schema`   | PostgreSQL schema with Zero integration            | Drizzle ORM, drizzle-zero     |
| `sheet-ingress-api` | Shared HttpApi contracts, schemas, middleware tags | Effect HttpApi, Effect Schema |
| `sheet-formulas`    | Google Apps Script formulas library                | Effect.ts, Google Apps Script |

## Service Interactions

### Request Flow

```mermaid
sequenceDiagram
    participant Web as sheet-web
    participant Bot as sheet-bot
    participant Ingress as sheet-ingress-server
    participant APIs as sheet-apis
    participant Auth as sheet-auth
    participant DB as sheet-db-server
    participant Google as Google Sheets
    participant Discord as Discord API
    participant Postgres as PostgreSQL

    Note over Web,Bot: Both use sheet-ingress-api as a compile-time contract library

    Web->>Auth: Discord OAuth Login
    Auth->>Discord: OAuth Flow
    Auth-->>Web: Session / Token

    Web->>Ingress: API Request + Credentials
    Ingress->>Auth: Resolve / authorize user
    Auth-->>Ingress: User and permission context
    Ingress->>APIs: Forward authorized sheet request

    APIs->>DB: Query/Mutate (Zero Protocol)
    DB->>Postgres: SQL Operations
    DB-->>APIs: Real-time Data

    APIs->>Google: Sheets API Operations
    Google-->>APIs: Sheet Data

    APIs-->>Ingress: Response Data
    Ingress-->>Web: Response

    Bot->>Ingress: Sheet API Request + Service Credentials
    Ingress->>APIs: Forward authorized bot sheet request
    APIs-->>Ingress: Bot response data
    Ingress-->>Bot: Bot response
    Bot->>Discord: Gateway Events
    Ingress->>Bot: Forward Discord cache/application route
    Bot-->>Ingress: Discord cache/application response
    Bot->>Discord: Send Messages
```

### Data Flow

1. **Web Application** (`sheet-web`)

- Authenticates via `sheet-auth` using Discord OAuth
- Uses shared `sheet-ingress-api` contracts for typed backend calls
- Calls backend routes through the ingress/API path for sheet operations
- Uses `start-atom` for SSR-compatible state management

2. **Ingress API Contracts** (`sheet-ingress-api`)

- Defines shared Effect HttpApi groups, schemas, middleware tags, and RPC helpers
- Exposes sheet API groups plus Discord application/cache API groups
- Provides `SheetApisApi` and `SheetApisRpcs` for clients and servers
- Exports `.`, `./api`, `./api-groups`, middleware tag paths, `./sheet-apis`, `./sheet-apis-rpc`, and `./schemas/*`

3. **Ingress Server** (`sheet-ingress-server`)

- Serves the ingress HttpApi surface
- Applies CORS, telemetry, authorization, auth resolution, and message lookup
- Forwards authorized sheet routes to `sheet-apis`
- Forwards sheet bot/Discord application and cache routes to bot-facing services

4. **Discord Bot** (`sheet-bot`)

- Receives commands via Discord Gateway
- Uses `sheet-ingress-api` contracts for shared route and schema definitions
- Calls `sheet-ingress-server` with service credentials for sheet API operations
- Uses `dfx-discord-utils` for caching and command building
- Manages guild configurations and check-ins

5. **API Server** (`sheet-apis`)

- Handles sheet business operations behind the ingress layer
- Integrates with Google Sheets via @googleapis/sheets and Playwright
- Queries PostgreSQL via `sheet-db-server` using Zero protocol
- Provides OpenTelemetry metrics and tracing

6. **Database Server** (`sheet-db-server`)

- Provides real-time sync using Rocicorp Zero
- Manages PostgreSQL schema via Drizzle ORM
- Handles query and mutation requests

7. **Apps Script** (`sheet-formulas`)

- Runs within Google Sheets environment
- Uses `sheet-ingress-api` contracts and `effect-platform-apps-script` for HTTP calls
- Calls backend routes through the ingress/API path

8. **VibeCord Bot** (`vibecord`)

- Standalone Discord bot with SQLite database
- Manages workspaces and sessions
- Integrates with OpenCode Agent Client Protocol
- Independent from sheet services

## Key Technologies

- **Effect.ts** (catalog v4.0.0-beta.56): Primary framework for type-safe, composable code
- **Rocicorp Zero**: Real-time sync protocol for database
- **TanStack Start**: Full-stack React framework with SSR
- **Drizzle ORM**: Type-safe SQL-like ORM for PostgreSQL and SQLite
- **Better Auth**: Authentication framework with Discord OAuth
- **dfx**: Discord Effect library for bot development
- **vite-plus (`vp`)** (catalog v0.1.15): Monorepo build, lint, format, and test tooling

## Development

### Prerequisites

- Node.js (LTS)
- pnpm
- PostgreSQL (for sheet services)
- Google Cloud project (for Sheets API)

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run format checks across the monorepo
pnpm format

# Run lint plus type-aware type checks across the monorepo
pnpm lint

# Run tests across the monorepo
pnpm test

# Run workspace checks
pnpm checks

# Apply formatting
pnpm format:apply
```

### Package Scripts

Packages with source code generally support these scripts:

```bash
# From a package directory
pnpm build
pnpm format
pnpm format:apply
pnpm lint
pnpm test        # Only in packages that define tests
pnpm test:watch  # Only in packages that define tests

# Package-specific scripts (run from package directory)
pnpm db:generate    # Generate package-specific database migrations
pnpm db:migrate     # Run migrations
pnpm db:push        # Push schema changes
pnpm db:studio      # Open Drizzle Studio (vibecord only)
```

`sheet-db-schema` uses `effect-sql-kit` for database scripts. `sheet-auth` and `vibecord`
continue to use Drizzle-based database scripts.

Workspace scripts are defined in the repo root:

```bash
pnpm format        # vp run -r format
pnpm lint          # vp run -r lint
pnpm test          # vp run -r test
pnpm build         # vp run -r build
pnpm checks        # pnpm format && pnpm lint && pnpm test
pnpm format:apply  # vp run -r format:apply
```

In this repo, `pnpm lint` also performs type-aware TypeScript checking for the Vite+ packages because each package `vite.config.ts` enables `lint.options.typeAware` and `lint.options.typeCheck`.

## Project Structure

```
.
├── packages/
│   ├── typhoon-core/                 # Shared utilities, schema helpers, errors
│   │   ├── src/schema/               # Schema utilities
│   │   ├── src/utils/                # Utility functions
│   │   ├── src/error/                # Error handling
│   │   └── src/services/             # Core services
│   ├── typhoon-zero/                 # Shared Zero integration helpers
│   ├── bob/                          # Config builder utility
│   ├── dfx-discord-utils/            # Discord utilities
│   │   ├── src/discord/              # Discord-specific utils
│   │   ├── src/cache/                # Caching utilities
│   │   └── src/utils/                # Command builders & helpers
│   ├── effect-platform-apps-script/  # GAS HTTP client
│   ├── start-atom/                   # TanStack Start + Effect Atom
│   ├── sheet-apis/                   # Sheet HTTP API server
│   │   ├── src/config/               # Configuration
│   │   ├── src/handlers/             # API handlers
│   │   ├── src/services/             # Business logic
│   │   ├── src/middlewares/          # Auth middleware
│   │   └── src/test-utils/           # Test helpers
│   ├── sheet-ingress-api/            # Shared ingress contracts and schemas
│   │   ├── src/api.ts                # Composed ingress HttpApi
│   │   ├── src/api-groups.ts         # Sheet API group exports
│   │   ├── src/handlers/             # Route contract groups
│   │   ├── src/middlewares/          # Middleware tags
│   │   ├── src/schemas/              # Shared request/response schemas
│   │   ├── src/sheet-apis.ts         # Sheet APIs contract surface
│   │   └── src/sheet-apis-rpc.ts     # Sheet APIs RPC helpers
│   ├── sheet-ingress-server/         # Ingress/proxy server
│   │   ├── src/config/               # Configuration
│   │   ├── src/middlewares/          # Proxy authorization middleware
│   │   ├── src/services/             # Auth, lookup, and forwarding services
│   │   ├── src/telemetry.ts          # Telemetry layer
│   │   └── src/index.ts              # Server entrypoint
│   ├── sheet-db-server/              # Zero sync server
│   │   ├── src/handlers/zero/        # Zero handlers
│   │   ├── src/services/             # DB service
│   │   └── src/config/               # Configuration
│   ├── sheet-db-schema/              # Database schemas
│   │   ├── src/schema.ts             # Drizzle tables
│   │   └── src/zero/                 # Zero schema & mutators
│   │       ├── mutators/             # Zero mutations
│   │       └── queries/              # Zero queries
│   ├── sheet-auth/                   # Authentication service
│   │   ├── src/plugins/              # Auth plugins
│   │   ├── src/auth-config.ts        # BetterAuth config
│   │   └── src/schema.ts             # Auth tables
│   ├── sheet-web/                    # Web dashboard
│   │   ├── src/routes/               # TanStack routes
│   │   ├── src/components/           # React components
│   │   ├── src/lib/                  # Utilities & state
│   │   └── src/hooks/                # Custom hooks
│   ├── sheet-bot/                    # Discord bot
│   │   ├── src/commands/             # Slash commands
│   │   ├── src/config/               # Configuration
│   │   ├── src/discord/              # Discord API and gateway support
│   │   ├── src/middlewares/          # Authorization middleware
│   │   ├── src/services/             # Business logic
│   │   ├── src/messageComponents/    # Message components
│   │   └── src/tasks/                # Background tasks
│   ├── sheet-formulas/               # Apps Script formulas
│   │   └── src/formulas.ts           # Formula implementations
│   └── vibecord/                     # VibeCord bot
│       ├── src/bot/                  # Bot implementation
│       ├── src/commands/             # Slash commands
│       ├── src/services/             # Business logic
│       ├── src/db/                   # SQLite schema
│       └── src/sdk/                  # ACP integration
├── AGENTS.md                         # AI agent documentation
├── README.md                         # This file
└── package.json                      # Workspace root
```

## Dependencies Overview

### Direct Workspace Dependencies

```mermaid
graph TD
    %% sheet-web runtime HTTP calls go through sheet-ingress-server;
    %% sheet-apis remains a direct workspace dependency for shared API types.
    Web[sheet-web] -.->|workspace/type dependency| APIs[sheet-apis]
    Web -->|uses| Auth[sheet-auth]
    Web -->|uses| IngressAPI[sheet-ingress-api]
    Web -->|uses| Atom[start-atom]
    Web -->|uses| Core[typhoon-core]
    Web -->|uses| Zero[typhoon-zero]

    APIs -->|uses| Auth
    APIs -->|uses| Schema[sheet-db-schema]
    APIs -->|uses| IngressAPI
    APIs -->|uses| DFX[dfx-discord-utils]
    APIs -->|uses| Core
    APIs -->|uses| Zero

    Bot[sheet-bot] -->|uses| Auth
    Bot -->|uses| Schema
    Bot -->|uses| IngressAPI
    Bot -->|uses| DFX
    Bot -->|uses| Core

    Auth -->|uses| Core

    Formulas[sheet-formulas] -->|uses| IngressAPI
    Formulas -->|uses| GAS[effect-platform-apps-script]
    Formulas -->|uses| Core

    IngressServer[sheet-ingress-server] -->|uses| Auth
    IngressServer -->|uses| IngressAPI
    IngressServer -->|uses| DFX
    IngressServer -->|uses| Core

    IngressAPI -->|uses| DFX
    IngressAPI -->|uses| Core
    IngressAPI -->|uses| Zero

    DB[sheet-db-server] -->|uses| Schema
    DB -->|uses| Core
    DB -->|uses| Zero

    Schema -->|uses| Core
    Schema -->|uses| Zero

    VibeCord[vibecord] -->|uses| DFX

    DFX -->|uses| Core
    Zero -->|uses| Core
```
