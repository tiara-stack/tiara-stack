import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTcpServer } from "node:net";
import Database from "@rocicorp/zero-sqlite3";
import { Zero } from "@rocicorp/zero";
import { SQLiteStore, type SQLiteDatabase } from "@rocicorp/zero/sqlite";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import postgres from "postgres";
import {
  effectivePrincipalFromVerifiedOAuthClaims,
  ownerKeyForEffectivePrincipal,
} from "sheet-auth/identity/server";
import type { EffectivePrincipal as EffectivePrincipalType } from "sheet-auth/identity";
import type { VerifiedOAuthResourceToken } from "sheet-auth/oauth-resource-authorization";
import {
  AuthorizationLoadWorkspaceCapabilities,
  CheckinMessagesLoad,
  CheckinMessagesSave,
} from "sheet-workflow-contracts";
import {
  makeAuthorizationLoadWorkspaceCapabilitiesZeroObserver,
  makeCheckinMessagesLoadZeroObserver,
  makeCheckinMessagesSaveZeroObserver,
  schema,
  type Schema as SheetZeroSchema,
} from "sheet-zero-api";
import { workflowObservationMutators, workflowObservationQueries } from "sheet-zero-api/server";
import {
  makeSheetWorkflowHttpClients,
  sheetWorkflowHttpRouteManifest,
  workflowInvocationIdFromString,
} from "sheet-workflow-http-client";
import { ZeroDispatchUnauthorizedError, ZeroHttpApi, makeZeroHttpLive } from "typhoon-zero/server";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import { terminalRunFromSubscription } from "../utils/workflowObservation";

const integrationEnabled = process.env.TIA_211_ZERO_INTEGRATION === "1";
const postgresImage = "postgres:16-alpine";
const postgresPassword = "tia211-local-only";
const userId = "tia211-auth-user";
const discordUserId = "123456789012345679";
const otherUserId = "tia211-other-auth-user";
const userToken = "tia211-user-token";
const otherUserToken = "tia211-other-user-token";
const serviceToken = "tia211-service-token";
const serviceClientId = "sheet-bot.integration";
const serviceId = "sheet-bot.gateway";
const gatewayIdentity = { serviceId, oauthClientId: serviceClientId } as const;

const workflowName = (identity: string, wireVersion: string) =>
  JSON.stringify([identity, wireVersion]);
const checkinMessagesLoadWorkflowName = workflowName(
  CheckinMessagesLoad.identity,
  CheckinMessagesLoad.wireVersion,
);
const checkinMessagesSaveWorkflowName = workflowName(
  CheckinMessagesSave.identity,
  CheckinMessagesSave.wireVersion,
);
const checkinMessagesLoadEnqueuePath = sheetWorkflowHttpRouteManifest.find(
  ({ path }) => path.includes("checkinMessages.load") && path.endsWith("/enqueue"),
)?.path;
if (checkinMessagesLoadEnqueuePath === undefined) {
  throw new Error("Check-in message load enqueue route is not configured");
}

const userAuthToken: VerifiedOAuthResourceToken = {
  accountId: discordUserId,
  actorClientId: undefined,
  actorSub: undefined,
  clientId: "sheet-bot.integration",
  exp: undefined,
  scopes: new Set(["workflow.observe"]),
  sub: userId,
};

const otherAuthToken: VerifiedOAuthResourceToken = {
  ...userAuthToken,
  accountId: "123456789012345670",
  sub: otherUserId,
};

const serviceAuthToken: VerifiedOAuthResourceToken = {
  accountId: undefined,
  actorClientId: undefined,
  actorSub: undefined,
  clientId: serviceClientId,
  exp: undefined,
  scopes: new Set(["service", "workflow.observe"]),
  sub: undefined,
};

const userOwnerKey = ownerKeyForEffectivePrincipal(
  effectivePrincipalFromVerifiedOAuthClaims(userAuthToken),
);

const authTokens = new Map([
  [userToken, userAuthToken],
  [otherUserToken, otherAuthToken],
  [serviceToken, serviceAuthToken],
]);

const bearerToken = (authorization: string | undefined) =>
  authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;

const observationContextFromToken = (
  procedureNames: readonly string[],
  token: VerifiedOAuthResourceToken,
) =>
  Effect.try({
    try: () =>
      Match.type<EffectivePrincipalType>().pipe(
        Match.discriminatorsExhaustive("kind")({
          service: (principal) => {
            if (!token.scopes.has("service")) {
              throw new Error("TIA-211 integration service scope is missing");
            }
            return {
              principalId: principal.serviceId,
              visibilityKey: `service:${principal.serviceId}`,
              ownerKey: ownerKeyForEffectivePrincipal(principal),
            };
          },
          user: (principal) => {
            const accountId = principal.discordAccount?.accountId;
            if (accountId === undefined) {
              throw new Error("TIA-211 integration user account is missing");
            }
            return {
              principalId: accountId,
              visibilityKey: `account:${accountId}`,
              ownerKey: ownerKeyForEffectivePrincipal(principal),
            };
          },
        }),
      )(effectivePrincipalFromVerifiedOAuthClaims(token, gatewayIdentity)),
    catch: () =>
      new ZeroDispatchUnauthorizedError({
        procedure: procedureNames.join(", ") || "unknown",
        message: "TIA-211 integration identity is invalid",
      }),
  });

const exec = (file: string, args: readonly string[]) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolveOutput, reject) => {
        execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`),
            );
            return;
          }
          resolveOutput(stdout.trim());
        });
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const waitForCommand = (file: string, args: readonly string[]) =>
  exec(file, args).pipe(
    Effect.retry((adapt) =>
      adapt(Schedule.addDelay(Schedule.recurs(120), () => Effect.succeed(Duration.millis(250)))),
    ),
    Effect.timeout("45 seconds"),
    Effect.flatMap((output) =>
      output.length > 0
        ? Effect.succeed(output)
        : Effect.fail(new Error("Command returned no output")),
    ),
  );

const waitForHttp = (url: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.retry((adapt) =>
      adapt(Schedule.addDelay(Schedule.recurs(180), () => Effect.succeed(Duration.millis(250)))),
    ),
    Effect.timeout("60 seconds"),
  );

const reservePort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolvePort, reject) => {
      const server = createTcpServer();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("Could not determine the reserved TCP port"));
          return;
        }
        server.close((error) => (error ? reject(error) : resolvePort(address.port)));
      });
    }),
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
});

const stopContainer = (name: string) => exec("docker", ["rm", "--force", name]).pipe(Effect.ignore);

const createWorkflowSchema = (sql: ReturnType<typeof postgres>) =>
  Effect.tryPromise({
    try: async () => {
      await sql.unsafe(`
        create table sheet_db_workflow_run (
          run_id text not null primary key,
          workflow_name text not null,
          contract_identity text,
          contract_wire_version text,
          canonical_input_hash text,
          definition_version text not null,
          execution_id text not null,
          idempotency_key text not null,
          visibility_key text not null,
          principal jsonb,
          actor_provenance jsonb,
          input jsonb not null,
          status text not null,
          result jsonb,
          error jsonb,
          max_attempts integer not null,
          run_after timestamptz not null,
          started_at timestamptz,
          completed_at timestamptz,
          created_at timestamptz not null,
          updated_at timestamptz not null
        )
      `);
      await sql.unsafe(`
        create unique index sheet_db_workflow_run_workflow_idempotency_idx
          on sheet_db_workflow_run (workflow_name, idempotency_key)
      `);
      await sql.unsafe(`
        create publication zero_data for table sheet_db_workflow_run (
          completed_at,
          created_at,
          definition_version,
          error,
          result,
          run_after,
          run_id,
          status,
          updated_at,
          visibility_key,
          workflow_name
        )
      `);
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const startPostgres = Effect.gen(function* () {
  const containerName = `tia211-pg-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  yield* exec("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--env",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "--env",
    "POSTGRES_DB=tia211",
    "--publish",
    "127.0.0.1::5432",
    postgresImage,
    "-c",
    "wal_level=logical",
    "-c",
    "max_replication_slots=10",
    "-c",
    "max_wal_senders=10",
  ]);
  yield* Effect.addFinalizer(() => stopContainer(containerName));

  const portText = yield* waitForCommand("docker", ["port", containerName, "5432/tcp"]);
  const port = Number(portText.match(/:(\d+)\s*$/m)?.[1]);
  if (!Number.isInteger(port) || port < 1) {
    return yield* Effect.fail(new Error(`Could not parse PostgreSQL port from ${portText}`));
  }

  yield* waitForCommand("docker", [
    "exec",
    containerName,
    "pg_isready",
    "--username",
    "postgres",
    "--dbname",
    "tia211",
  ]);

  const databaseUrl = `postgres://postgres:${encodeURIComponent(postgresPassword)}@127.0.0.1:${port}/tia211`;
  const sql = postgres(databaseUrl, { max: 6 });
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => sql.end({ timeout: 5_000 })).pipe(Effect.ignore),
  );
  yield* createWorkflowSchema(sql);
  return { containerName, databaseUrl, sql };
});

const startZeroCache = (databaseUrl: string, queryUrl: string, replicaDirectory: string) =>
  Effect.gen(function* () {
    const port = yield* reservePort;
    const appId = `tia211_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const repository = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
    const executable = join(repository, "node_modules/.bin/zero-cache");
    const inheritedEnvironment = Object.fromEntries(
      ["HOME", "PATH", "TMPDIR", "USERPROFILE"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    );
    const child = spawn(executable, [], {
      cwd: repository,
      env: {
        ...inheritedEnvironment,
        NODE_ENV: "test",
        ZERO_APP_ID: appId,
        ZERO_APP_PUBLICATIONS: "zero_data",
        ZERO_CHANGE_DB: databaseUrl,
        ZERO_CVR_DB: databaseUrl,
        ZERO_NUM_SYNC_WORKERS: "1",
        ZERO_PORT: String(port),
        ZERO_QUERY_ALLOWED_CLIENT_HEADERS: "authorization",
        ZERO_QUERY_URL: queryUrl,
        ZERO_REPLICA_FILE: join(replicaDirectory, "zero-replica.db"),
        ZERO_UPSTREAM_DB: databaseUrl,
        ZERO_UPSTREAM_MAX_CONNS: "6",
        ZERO_CVR_MAX_CONNS: "6",
        ZERO_CHANGE_MAX_CONNS: "6",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    const appendLogs = (chunk: Buffer) => {
      logs = `${logs}${chunk.toString()}`.slice(-8_000);
    };
    child.stdout?.on("data", appendLogs);
    child.stderr?.on("data", appendLogs);
    yield* Effect.addFinalizer(() => stopChild(child));
    yield* waitForHttp(`http://127.0.0.1:${port}/keepalive`).pipe(
      Effect.mapError(
        (error) => new Error(`Zero Cache did not become ready: ${error.message}\n${logs}`),
      ),
    );
    return { child, url: `http://127.0.0.1:${port}` };
  });

const stopChild = (child: ChildProcess) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolveStop) => {
        if (child.exitCode !== null) {
          resolveStop();
          return;
        }
        const finish = () => {
          clearTimeout(timeout);
          resolveStop();
        };
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          finish();
        }, 5_000);
        child.once("exit", finish);
        child.kill("SIGTERM");
      }),
    catch: () => undefined,
  }).pipe(Effect.ignore);

const workflowSuccess = Schema.decodeUnknownSync(CheckinMessagesLoad.success)({
  workspaceId: "123456789012345680",
  conversationId: "123456789012345681",
  conversationName: "g1",
  binding: { eventStartEpochMs: 1_750_000_000_000, messageSetGeneration: 1 },
  messages: [],
});
const workflowSaveSuccess = Schema.decodeUnknownSync(CheckinMessagesSave.success)({
  workspaceId: "123456789012345680",
  conversationId: "123456789012345681",
  binding: { eventStartEpochMs: 1_750_000_000_000, messageSetGeneration: 1 },
  message: { hour: 49, template: "saved through Zero", version: 2 },
});
const workflowAuthorizationSuccess = Schema.decodeUnknownSync(
  AuthorizationLoadWorkspaceCapabilities.success,
)({
  workspaceId: "123456789012345680",
  capabilities: ["manage"],
});

const insertTerminalWorkflowRun = (
  sql: ReturnType<typeof postgres>,
  options: {
    readonly invocationId: ReturnType<typeof workflowInvocationIdFromString>;
    readonly workflowName: string;
    readonly visibilityKey: string;
    readonly result: unknown;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const now = new Date();
      await sql`
        insert into sheet_db_workflow_run (
          run_id,
          workflow_name,
          definition_version,
          execution_id,
          idempotency_key,
          visibility_key,
          input,
          status,
          result,
          error,
          max_attempts,
          run_after,
          started_at,
          completed_at,
          created_at,
          updated_at
        ) values (
          ${options.invocationId},
          ${options.workflowName},
          'tia213-test-definition',
          ${`execution:${options.invocationId}`},
          ${options.invocationId},
          ${options.visibilityKey},
          '{}'::jsonb,
          'succeeded',
          ${JSON.stringify(options.result)}::jsonb,
          null,
          10,
          ${now},
          ${now},
          ${now},
          ${now},
          ${now}
        )
      `;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const makeHttpLayer = (
  sql: ReturnType<typeof postgres>,
  queryProcedureBatches: Array<readonly string[]>,
  enqueueRequests: Array<unknown>,
) => {
  const enqueueRequest = Schema.Struct({
    invocationId: Schema.String,
    input: CheckinMessagesLoad.input,
  });
  const workflowEnqueueLayer = HttpRouter.add(
    "POST",
    checkinMessagesLoadEnqueuePath as HttpRouter.PathInput,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (bearerToken(request.headers.authorization) !== userToken) {
        return HttpServerResponse.empty({ status: 401 });
      }
      const body = yield* request.json;
      const decoded = yield* Schema.decodeUnknownEffect(enqueueRequest)(body);
      const invocationId = yield* Effect.try({
        try: () => workflowInvocationIdFromString(decoded.invocationId),
        catch: () => new Error("TIA-211 integration invocation ID is invalid"),
      });
      const now = new Date();
      yield* Effect.tryPromise({
        try: () =>
          sql`
            insert into sheet_db_workflow_run (
              run_id,
              workflow_name,
              definition_version,
              execution_id,
              idempotency_key,
              visibility_key,
              input,
              status,
              result,
              error,
              max_attempts,
              run_after,
              started_at,
              completed_at,
              created_at,
              updated_at
            ) values (
              ${invocationId},
              ${checkinMessagesLoadWorkflowName},
              'tia211-test-definition',
              ${`execution:${invocationId}`},
              ${invocationId},
              ${userOwnerKey},
              ${JSON.stringify(decoded.input)}::jsonb,
              'pending',
              null,
              null,
              10,
              ${now},
              null,
              null,
              ${now},
              ${now}
            )
          `,
        catch: () => new Error("TIA-211 integration enqueue failed"),
      });
      const reference = {
        invocationId,
        contractIdentity: CheckinMessagesLoad.identity,
        wireVersion: CheckinMessagesLoad.wireVersion,
      };
      enqueueRequests.push(reference);
      return yield* HttpServerResponse.json(reference, { status: 202 });
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
  );

  class IntegrationApi extends HttpApi.make("tia211").add(ZeroHttpApi) {}

  const zeroHttpLayer = makeZeroHttpLive(IntegrationApi, {
    schema,
    mutators: workflowObservationMutators,
    queries: workflowObservationQueries,
    context: (procedureNames) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = authTokens.get(bearerToken(request.headers.authorization) ?? "");
        queryProcedureBatches.push(procedureNames);
        return token === undefined
          ? yield* Effect.fail(
              new ZeroDispatchUnauthorizedError({
                procedure: procedureNames.join(", ") || "unknown",
                message: "TIA-211 integration token is unknown",
              }),
            )
          : yield* observationContextFromToken(procedureNames, token);
      }),
    userID: (context) => context.principalId,
    zql: Effect.succeed({} as import("@rocicorp/zero/server").Database<unknown>),
  });
  const routesLayer = Layer.provide(HttpApiBuilder.layer(IntegrationApi), [zeroHttpLayer]).pipe(
    Layer.merge(workflowEnqueueLayer),
    Layer.provideMerge(HttpRouter.layer),
  );
  return HttpRouter.serve(routesLayer).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
};

const makeSQLiteDatabase = (filename: string): SQLiteDatabase => {
  const database = new Database(filename);
  return {
    close: () => database.close(),
    destroy: () => database.close(),
    execSync: (source) => {
      database.exec(source);
    },
    prepare: (source) => {
      const statement = database.prepare(source);
      return {
        firstValue: async (params) => statement.pluck().get(...params),
        exec: async (params) => {
          statement.run(...params);
        },
      };
    },
  };
};

const makeClientStorage = (directory: string) => ({
  create: (name: string) =>
    new SQLiteStore(name, (filename) => makeSQLiteDatabase(join(directory, filename))),
  drop: async () => undefined,
});

const makeZero = (cacheURL: string, directory: string, auth: string, userID: string) =>
  (() => {
    const token = authTokens.get(auth);
    if (token === undefined) {
      throw new Error("TIA-211 integration token is unknown");
    }
    return new Zero<SheetZeroSchema, undefined, { readonly ownerKey: string }>({
      cacheURL,
      userID,
      storageKey: `tia211:${userID}`,
      schema,
      auth,
      context: {
        ownerKey: ownerKeyForEffectivePrincipal(
          effectivePrincipalFromVerifiedOAuthClaims(token, gatewayIdentity),
        ),
      },
      kvStore: makeClientStorage(directory),
      logLevel: "error",
      onUpdateNeeded: () => undefined,
    });
  })();

describe.skipIf(!integrationEnabled)("TIA-211 local Zero integration proof", () => {
  it.live(
    "loads a saved message through authenticated HTTP enqueue and actual Zero sync",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* startPostgres;
          const clientDirectory = yield* Effect.tryPromise({
            try: () => mkdtemp(join(tmpdir(), "tia211-zero-client-")),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => rm(clientDirectory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
          );

          const queryProcedureBatches: Array<readonly string[]> = [];
          const enqueueRequests: Array<unknown> = [];
          const httpLayer = makeHttpLayer(database.sql, queryProcedureBatches, enqueueRequests);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const httpServer = yield* HttpServer.HttpServer;
              const baseURL = HttpServer.formatAddress(httpServer.address);
              const zeroCache = yield* startZeroCache(
                database.databaseUrl,
                `${baseURL}/zero/query`,
                clientDirectory,
              );

              const httpClient = yield* HttpClient.HttpClient;
              const authenticatedHttpClient = HttpClient.mapRequest(
                httpClient,
                HttpClientRequest.setHeader("authorization", `Bearer ${userToken}`),
              );
              const workflowClient = makeSheetWorkflowHttpClients(authenticatedHttpClient, {
                baseUrl: "",
              });
              const invocationId = workflowInvocationIdFromString(
                "123e4567-e89b-42d3-a456-426614174000",
              );
              const input = Schema.decodeUnknownSync(CheckinMessagesLoad.input)({
                workspaceId: "123456789012345680",
                conversationName: "g1",
              });
              const reference = yield* workflowClient.checkinMessages.load.enqueue(input, {
                invocationId,
              });

              expect(enqueueRequests).toHaveLength(1);
              expect(reference).toMatchObject({
                invocationId,
                contractIdentity: CheckinMessagesLoad.identity,
                wireVersion: CheckinMessagesLoad.wireVersion,
              });

              const [row] = yield* Effect.tryPromise({
                try: () =>
                  database.sql<
                    {
                      readonly visibility_key: string;
                      readonly workflow_name: string;
                    }[]
                  >`
                    select visibility_key, workflow_name
                    from sheet_db_workflow_run
                    where run_id = ${invocationId}
                  `,
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              expect(row).toEqual({
                visibility_key: userOwnerKey,
                workflow_name: checkinMessagesLoadWorkflowName,
              });

              const missingReference = {
                invocationId: workflowInvocationIdFromString(
                  "123e4567-e89b-42d3-a456-426614174001",
                ),
                contractIdentity: CheckinMessagesLoad.identity,
                wireVersion: CheckinMessagesLoad.wireVersion,
              };
              const userZero = makeZero(zeroCache.url, clientDirectory, userToken, userId);
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => userZero.close()).pipe(Effect.ignore),
              );
              const userExecutor = yield* BaseZeroClient.ZeroClient<
                SheetZeroSchema,
                undefined,
                { readonly ownerKey: string }
              >().make(userZero);
              const userObserver = yield* makeCheckinMessagesLoadZeroObserver(userExecutor);
              const initialMissing = yield* userObserver.get(missingReference).pipe(
                Stream.take(1),
                Stream.runHead,
                Effect.flatMap((value) =>
                  Option.isSome(value)
                    ? Effect.succeed(value.value)
                    : Effect.fail(new Error("Missing initial Zero snapshot")),
                ),
                Effect.timeout(Duration.seconds(20)),
              );
              expect(Option.isNone(initialMissing)).toBe(true);

              const observations: Array<string> = [];
              const pendingSeen = yield* Deferred.make<void>();
              const runningSeen = yield* Deferred.make<void>();
              const terminalFiber = yield* terminalRunFromSubscription(
                () =>
                  userObserver.get(reference).pipe(
                    Stream.tap((value) =>
                      Effect.gen(function* () {
                        if (Option.isNone(value)) {
                          observations.push("none");
                          return;
                        }
                        const result = value.value.result;
                        const observation = Predicate.isTagged("Pending")(result)
                          ? `${result._tag}:${result.phase}`
                          : `${result._tag}:terminal`;
                        observations.push(observation);
                        if (Predicate.isTagged("Pending")(result)) {
                          yield* result.phase === "Queued"
                            ? Deferred.succeed(pendingSeen, undefined)
                            : Deferred.succeed(runningSeen, undefined);
                        }
                      }),
                    ),
                  ),
                Duration.seconds(20),
              ).pipe(Effect.forkScoped);

              yield* Deferred.await(pendingSeen).pipe(Effect.timeout(Duration.seconds(20)));
              const concurrentTerminalFiber = yield* terminalRunFromSubscription(
                () => userObserver.get(reference),
                Duration.seconds(20),
              ).pipe(Effect.forkScoped);
              yield* Effect.tryPromise({
                try: async () => {
                  const now = new Date();
                  await database.sql`
                    update sheet_db_workflow_run
                    set status = 'running', started_at = ${now}, updated_at = ${now}
                    where run_id = ${invocationId}
                  `;
                },
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              yield* Deferred.await(runningSeen).pipe(Effect.timeout(Duration.seconds(20)));
              yield* Effect.tryPromise({
                try: async () => {
                  const now = new Date();
                  await database.sql`
                    update sheet_db_workflow_run
                    set status = 'succeeded', result = ${JSON.stringify(workflowSuccess)}::jsonb,
                        completed_at = ${now}, updated_at = ${new Date(now.getTime() + 1)}
                    where run_id = ${invocationId}
                  `;
                },
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              const terminal = yield* Fiber.join(terminalFiber);
              const concurrentTerminal = yield* Fiber.join(concurrentTerminalFiber);

              expect(terminal.result).toMatchObject({
                _tag: "Success",
                value: workflowSuccess,
              });
              expect(concurrentTerminal.result).toMatchObject({
                _tag: "Success",
                value: workflowSuccess,
              });
              expect(enqueueRequests).toHaveLength(1);
              expect(observations).toContain("Pending:Queued");
              expect(observations).toContain("Success:terminal");
              expect(observations.some((value) => value.startsWith("Pending:Running"))).toBe(true);
              expect(observations).not.toContain("Failure:terminal");
              expect(queryProcedureBatches.length).toBeGreaterThan(0);
              expect(
                queryProcedureBatches.every((batch) =>
                  batch.every((name) => name.endsWith(".get")),
                ),
              ).toBe(true);

              const saveInvocationId = workflowInvocationIdFromString(
                "123e4567-e89b-42d3-a456-426614174004",
              );
              const authorizationInvocationId = workflowInvocationIdFromString(
                "123e4567-e89b-42d3-a456-426614174005",
              );
              yield* insertTerminalWorkflowRun(database.sql, {
                invocationId: saveInvocationId,
                workflowName: checkinMessagesSaveWorkflowName,
                visibilityKey: userOwnerKey,
                result: workflowSaveSuccess,
              });
              yield* insertTerminalWorkflowRun(database.sql, {
                invocationId: authorizationInvocationId,
                workflowName: workflowName(
                  AuthorizationLoadWorkspaceCapabilities.identity,
                  AuthorizationLoadWorkspaceCapabilities.wireVersion,
                ),
                visibilityKey: userOwnerKey,
                result: workflowAuthorizationSuccess,
              });
              const saveObserver = yield* makeCheckinMessagesSaveZeroObserver(userExecutor);
              const authorizationObserver =
                yield* makeAuthorizationLoadWorkspaceCapabilitiesZeroObserver(userExecutor);
              const observedSave = yield* terminalRunFromSubscription(
                () =>
                  saveObserver.get({
                    invocationId: saveInvocationId,
                    contractIdentity: CheckinMessagesSave.identity,
                    wireVersion: CheckinMessagesSave.wireVersion,
                  }),
                Duration.seconds(20),
              );
              const observedAuthorization = yield* terminalRunFromSubscription(
                () =>
                  authorizationObserver.get({
                    invocationId: authorizationInvocationId,
                    contractIdentity: AuthorizationLoadWorkspaceCapabilities.identity,
                    wireVersion: AuthorizationLoadWorkspaceCapabilities.wireVersion,
                  }),
                Duration.seconds(20),
              );
              expect(observedSave.result).toMatchObject({
                _tag: "Success",
                value: workflowSaveSuccess,
              });
              expect(observedAuthorization.result).toMatchObject({
                _tag: "Success",
                value: workflowAuthorizationSuccess,
              });

              const wrongContractInvocationId = workflowInvocationIdFromString(
                "123e4567-e89b-42d3-a456-426614174002",
              );
              yield* Effect.tryPromise({
                try: async () => {
                  const now = new Date();
                  await database.sql`
                    insert into sheet_db_workflow_run (
                      run_id,
                      workflow_name,
                      definition_version,
                      execution_id,
                      idempotency_key,
                      visibility_key,
                      input,
                      status,
                      result,
                      error,
                      max_attempts,
                      run_after,
                      started_at,
                      completed_at,
                      created_at,
                      updated_at
                    ) values (
                      ${wrongContractInvocationId},
                      ${checkinMessagesSaveWorkflowName},
                      'tia211-test-definition',
                      ${`execution:${wrongContractInvocationId}`},
                      ${wrongContractInvocationId},
                      ${userOwnerKey},
                      '{}'::jsonb,
                      'succeeded',
                      ${JSON.stringify(workflowSuccess)}::jsonb,
                      null,
                      10,
                      ${now},
                      ${now},
                      ${now},
                      ${now},
                      ${now}
                    )
                  `;
                },
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              const wrongContractObservation = yield* userObserver
                .get({
                  invocationId: wrongContractInvocationId,
                  contractIdentity: CheckinMessagesLoad.identity,
                  wireVersion: CheckinMessagesLoad.wireVersion,
                })
                .pipe(
                  Stream.take(1),
                  Stream.runHead,
                  Effect.flatMap((value) =>
                    Option.isSome(value)
                      ? Effect.succeed(value.value)
                      : Effect.fail(new Error("Missing wrong-contract Zero snapshot")),
                  ),
                  Effect.timeout(Duration.seconds(20)),
                );
              expect(Option.isNone(wrongContractObservation)).toBe(true);

              const serviceInvocationId = workflowInvocationIdFromString(
                "123e4567-e89b-42d3-a456-426614174003",
              );
              const serviceReference = {
                invocationId: serviceInvocationId,
                contractIdentity: CheckinMessagesLoad.identity,
                wireVersion: CheckinMessagesLoad.wireVersion,
              };
              yield* Effect.tryPromise({
                try: async () => {
                  const now = new Date();
                  await database.sql`
                    insert into sheet_db_workflow_run (
                      run_id,
                      workflow_name,
                      definition_version,
                      execution_id,
                      idempotency_key,
                      visibility_key,
                      input,
                      status,
                      result,
                      error,
                      max_attempts,
                      run_after,
                      started_at,
                      completed_at,
                      created_at,
                      updated_at
                    ) values (
                      ${serviceInvocationId},
                      ${checkinMessagesLoadWorkflowName},
                      'tia211-test-definition',
                      ${`execution:${serviceInvocationId}`},
                      ${serviceInvocationId},
                      ${`service:${serviceId}`},
                      '{}'::jsonb,
                      'succeeded',
                      ${JSON.stringify(workflowSuccess)}::jsonb,
                      null,
                      10,
                      ${now},
                      ${now},
                      ${now},
                      ${now},
                      ${now}
                    )
                  `;
                },
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });

              const otherDirectory = yield* Effect.tryPromise({
                try: () => mkdtemp(join(tmpdir(), "tia211-zero-other-")),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => rm(otherDirectory, { recursive: true, force: true })).pipe(
                  Effect.ignore,
                ),
              );
              const otherZero = makeZero(
                zeroCache.url,
                otherDirectory,
                otherUserToken,
                otherUserId,
              );
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => otherZero.close()).pipe(Effect.ignore),
              );
              const otherExecutor = yield* BaseZeroClient.ZeroClient<
                SheetZeroSchema,
                undefined,
                { readonly ownerKey: string }
              >().make(otherZero);
              const otherObserver = yield* makeCheckinMessagesLoadZeroObserver(otherExecutor);
              const otherObservation = yield* otherObserver.get(reference).pipe(
                Stream.take(1),
                Stream.runHead,
                Effect.flatMap((value) =>
                  Option.isSome(value)
                    ? Effect.succeed(value.value)
                    : Effect.fail(new Error("Missing cross-user Zero snapshot")),
                ),
                Effect.timeout(Duration.seconds(20)),
              );
              expect(Option.isNone(otherObservation)).toBe(true);

              const serviceDirectory = yield* Effect.tryPromise({
                try: () => mkdtemp(join(tmpdir(), "tia211-zero-service-")),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => rm(serviceDirectory, { recursive: true, force: true })).pipe(
                  Effect.ignore,
                ),
              );
              const serviceZero = makeZero(
                zeroCache.url,
                serviceDirectory,
                serviceToken,
                serviceId,
              );
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => serviceZero.close()).pipe(Effect.ignore),
              );
              const serviceExecutor = yield* BaseZeroClient.ZeroClient<
                SheetZeroSchema,
                undefined,
                { readonly ownerKey: string }
              >().make(serviceZero);
              const serviceObserver = yield* makeCheckinMessagesLoadZeroObserver(serviceExecutor);
              const serviceObservation = yield* serviceObserver.get(reference).pipe(
                Stream.take(1),
                Stream.runHead,
                Effect.flatMap((value) =>
                  Option.isSome(value)
                    ? Effect.succeed(value.value)
                    : Effect.fail(new Error("Missing service Zero snapshot")),
                ),
                Effect.timeout(Duration.seconds(20)),
              );
              expect(Option.isNone(serviceObservation)).toBe(true);

              const serviceOwnObservation = yield* serviceObserver.get(serviceReference).pipe(
                Stream.take(1),
                Stream.runHead,
                Effect.flatMap((value) =>
                  Option.isSome(value)
                    ? Effect.succeed(value.value)
                    : Effect.fail(new Error("Missing service-owned Zero snapshot")),
                ),
                Effect.timeout(Duration.seconds(20)),
              );
              expect(serviceOwnObservation).toMatchObject({
                result: { _tag: "Success", value: workflowSuccess },
              });

              const userServiceObservation = yield* Effect.exit(
                userObserver
                  .get(serviceReference)
                  .pipe(Stream.take(1), Stream.runHead, Effect.timeout(Duration.seconds(20))),
              );
              expect(Exit.isSuccess(userServiceObservation)).toBe(true);
              if (Exit.isSuccess(userServiceObservation)) {
                expect(Option.isNone(userServiceObservation.value)).toBe(true);
              }
            }).pipe(Effect.provide(httpLayer)),
          );
        }),
      ),
    120_000,
  );
});
