#!/usr/bin/env node

import { Cause, Duration, Effect } from "effect";
import { createSign } from "node:crypto";
import { checkHttpAccess } from "../../../packages/developer-launcher/src/access";
import { spawnProcess } from "../../../packages/developer-launcher/src/executor";

const endpoints = [
  "https://schedule.dev.theerapakg.moe/ready",
  "https://auth.dev.theerapakg.moe/ready",
  "https://zero.dev.theerapakg.moe/ready",
  "https://workflows.dev.theerapakg.moe/ready",
] as const;

// fallow-ignore-next-line complexity
const argumentAfter = (name: string): { readonly value?: string; readonly error?: string } => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (index >= 0 && (value === undefined || value.startsWith("-"))) {
    return { error: `${name} requires a value.` };
  }
  return { value };
};
const gateArgument = argumentAfter("--gate");
const developmentOnly = process.argv.includes("--development-only");
const gate = gateArgument.value;
const developmentChannelId = "1466752705900056749";
const runCommand = (command: string, args: readonly string[], timeoutMs = 30_000) =>
  Effect.tryPromise(() =>
    spawnProcess({
      command,
      args,
      cwd: process.cwd(),
      env: {},
      timeoutMs,
      kind: "dependency-check",
      readOnly: true,
      output: "capture",
    }),
  );
const kubectlRead = (resources: string) =>
  runCommand("kubectl", [
    "--context",
    process.env.KUBE_CONTEXT ?? "tiara-stack-dev",
    "--namespace",
    process.env.KUBE_NAMESPACE ?? "tiara-stack-dev",
    "get",
    resources,
    "-o",
    "json",
  ]);
const readSecret = (name: string, key: string) =>
  runCommand("kubectl", [
    "--context",
    process.env.KUBE_CONTEXT ?? "tiara-stack-dev",
    "--namespace",
    process.env.KUBE_NAMESPACE ?? "tiara-stack-dev",
    "get",
    `secret/${name}`,
    "-o",
    `jsonpath={.data.${key.replaceAll(".", "\\.")}}`,
  ]).pipe(
    Effect.map((result) => {
      requireSuccessful(result, `Could not read development secret ${name}/${key}.`);
      return Buffer.from(result.stdout?.trim() ?? "", "base64").toString("utf8");
    }),
  );
const jsonRequest = (url: string, init: RequestInit = {}) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
      return text.length === 0 ? undefined : (JSON.parse(text) as Record<string, unknown>);
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
const discordRequest = (token: string, path: string, init: RequestInit = {}) =>
  jsonRequest(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...init.headers },
  });
const assertObjectString = (value: Record<string, unknown> | undefined, key: string) => {
  const result = value?.[key];
  if (typeof result !== "string" || result.length === 0) throw new Error(`Response is missing ${key}.`);
  return result;
};
const discordSmoke = (token: string) =>
  Effect.gen(function* () {
    const channel = yield* discordRequest(token, `/channels/${developmentChannelId}`);
    const guildId = assertObjectString(channel, "guild_id");
    const marker = `TiaraStack Kubernetes parity ${Date.now()}`;
    const created = yield* discordRequest(token, `/channels/${developmentChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: marker, allowed_mentions: { parse: [] } }),
    });
    const messageId = assertObjectString(created, "id");
    yield* Effect.gen(function* () {
      const observed = yield* discordRequest(token, `/channels/${developmentChannelId}/messages/${messageId}`);
      if (observed?.content !== marker || observed.channel_id !== developmentChannelId) {
        yield* Effect.fail("Discord parity message did not round-trip in the development channel.");
      }
    }).pipe(
      Effect.ensuring(
        discordRequest(token, `/channels/${developmentChannelId}/messages/${messageId}`, {
          method: "DELETE",
        }).pipe(Effect.asVoid),
      ),
    );
    return guildId;
  });
// fallow-ignore-next-line complexity
const googleSheetsSmoke = () =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const credentialsText = yield* readSecret("sheet-workflows-secret-path", "google-service-account.json");
    const credentials = JSON.parse(credentialsText) as { readonly client_email?: string; readonly private_key?: string };
    if (credentials.client_email === undefined || credentials.private_key === undefined) {
      yield* Effect.fail("Development Google service-account credentials are incomplete.");
    }
    const encoded = (value: string) => Buffer.from(value).toString("base64url");
    const header = encoded(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const issuedAt = Math.floor(Date.now() / 1000);
    const claim = encoded(JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: issuedAt + 600,
    }));
    const unsigned = `${header}.${claim}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(credentials.private_key ?? "", "base64url")}`;
    const token = yield* jsonRequest("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const accessToken = assertObjectString(token, "access_token");
    const files = yield* jsonRequest("https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27%20and%20trashed%3Dfalse&fields=files(id,name)&pageSize=10", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const spreadsheets = Array.isArray(files?.files) ? files.files : [];
    if (spreadsheets.length === 0) {
      yield* Effect.fail("No development spreadsheet is visible to the development service account.");
    }
    if (spreadsheets.length > 1) {
      yield* Effect.fail("Multiple development spreadsheets are visible; configure one associated spreadsheet.");
    }
    const spreadsheetId = assertObjectString(spreadsheets[0] as Record<string, unknown>, "id");
    yield* jsonRequest(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,sheets.properties`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    yield* jsonRequest(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/A1:C3`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });
// fallow-ignore-next-line complexity
const workflowSmoke = (guildId: string, channelId: string) =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const clientId = yield* readSecret("sheet-bot-secret", "sheetBotServiceClientId");
    const clientSecret = yield* readSecret("sheet-bot-secret", "sheetBotServiceClientSecret");
    const tokenResponse = yield* jsonRequest("https://auth.dev.theerapakg.moe/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "service workflow.enqueue workflow.observe",
        resource: "sheet-workflows-http",
      }),
    });
    const token = assertObjectString(tokenResponse, "access_token");
    const invocationId = globalThis.crypto.randomUUID();
    const enqueue = yield* jsonRequest(
      "https://workflows.dev.theerapakg.moe/workflows/workspaces.deliverWelcome/v/1/enqueue",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          invocationId,
          input: {
            workspaceId: guildId,
            workspaceName: "TiaraStack development parity",
            joinedAt: new Date().toISOString(),
            systemConversationId: channelId,
          },
        }),
      },
    );
    if (enqueue === undefined) yield* Effect.fail("Workflow enqueue returned no run reference.");
    let events = "";
    let latestEvent = "{}";
    let messageId: string | undefined;
    const cleanup = Effect.suspend(() =>
      messageId === undefined
        ? Effect.void
        : readSecret("sheet-bot-secret", "discordToken").pipe(
            Effect.flatMap((botToken) =>
              discordRequest(botToken, `/channels/${channelId}/messages/${messageId}`, {
                method: "DELETE",
              }),
            ),
            Effect.asVoid,
          ),
    );
    // fallow-ignore-next-line complexity
    const poll = Effect.gen(function* () {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      events = yield* Effect.tryPromise(() =>
        fetch(`https://workflows.dev.theerapakg.moe/workflows/workspaces.deliverWelcome/v/1/runs/${encodeURIComponent(invocationId)}/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        }).then(async (response) => {
          const body = await response.text();
          if (!response.ok) throw new Error(`Workflow observation failed with ${response.status}.`);
          return body;
        }),
      );
      const eventRecords = events
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => {
          try {
            return JSON.parse(line.slice("data: ".length)) as unknown;
          } catch {
            return undefined;
          }
        })
        .filter((event): event is unknown => event !== undefined);
      latestEvent = JSON.stringify(eventRecords.at(-1) ?? {});
      messageId = /"messageId":"([^"]+)"/.exec(events)?.[1] ?? messageId;
      if (
        latestEvent.includes('"status":"succeeded"') ||
        latestEvent.includes('"status":"success"') ||
        latestEvent.includes('"_tag":"Success"')
      )
        break;
      if (
        latestEvent.includes('"status":"failed"') ||
        latestEvent.includes('"status":"cancelled"') ||
        latestEvent.includes('"_tag":"Failure"')
      ) {
        yield* Effect.fail(`Workflow reached a failed terminal state: ${events.slice(-600)}`);
      }
      yield* Effect.sleep(Duration.seconds(2));
    }
    if (
      !latestEvent.includes('"status":"succeeded"') &&
      !latestEvent.includes('"status":"success"') &&
      !latestEvent.includes('"_tag":"Success"')
    ) {
      yield* Effect.fail(`Workflow did not reach terminal success: ${events.slice(-600)}`);
    }
    }).pipe(Effect.ensuring(cleanup));
    yield* poll;
  });
const requireSuccessful = (result: { readonly exitCode: number; readonly timedOut?: boolean }, message: string) => {
  if (result.exitCode !== 0 || result.timedOut) throw new Error(message);
};
// fallow-ignore-next-line complexity
const requireReadyWorkloads = (stdout: string | undefined) => {
  const document = JSON.parse(stdout ?? "{}");
  const items = Array.isArray(document.items) ? document.items : document.kind ? [document] : [];
  if (items.length === 0) throw new Error("no Kubernetes workloads were found");
  for (const item of items) {
    if (item.kind === "Pod") {
      const ready =
        item.status?.phase === "Succeeded" ||
        (item.status?.phase === "Running" &&
          item.status?.conditions?.some(
            (condition: { readonly type?: string; readonly status?: string }) =>
              condition.type === "Ready" && condition.status === "True",
          ));
      if (!ready) throw new Error(`pod ${item.metadata?.name ?? "unknown"} is not ready`);
    }
    if (["Deployment", "StatefulSet"].includes(item.kind) &&
        (item.status?.availableReplicas ?? 0) < (item.spec?.replicas ?? 0)) {
      throw new Error(`workload ${item.metadata?.name ?? "unknown"} is not available`);
    }
    if (item.kind === "Job" && (item.status?.succeeded ?? 0) < (item.spec?.completions ?? 1)) {
      throw new Error(`job ${item.metadata?.name ?? "unknown"} has not completed`);
    }
  }
};

// fallow-ignore-next-line complexity
const run = Effect.gen(function* () {
  const argumentError = gateArgument.error;
  if (argumentError !== undefined) yield* Effect.fail(argumentError);
  if (gate === undefined || !developmentOnly) {
    yield* Effect.fail("A parity gate and --development-only are required.");
  }
  if (gate === "api-evidence" || gate === "api-smoke") {
    const results = yield* Effect.all(
      endpoints.map((origin) =>
        Effect.tryPromise(() =>
          checkHttpAccess({
            mode: "kubernetes",
            dependency: gate,
            origin,
            timeoutMs: 10_000,
            optional: false,
          }),
        ),
      ),
      { concurrency: "unbounded" },
    );
    if (results.some(({ reachable }) => !reachable)) {
      yield* Effect.fail(`${gate} found an unavailable development endpoint.`);
    }
    if (gate === "api-smoke") {
      const botToken = yield* readSecret("sheet-bot-secret", "discordToken");
      const channel = yield* discordRequest(botToken, `/channels/${developmentChannelId}`);
      yield* workflowSmoke(assertObjectString(channel, "guild_id"), developmentChannelId);
    }
    console.log(`${gate}: development endpoints reachable`);
    return;
  }
  if (gate === "workload-readiness") {
    const namespace = process.env.KUBE_NAMESPACE ?? "tiara-stack-dev";
    const result = yield* kubectlRead("deployments,statefulsets,pods,jobs");
    try {
      requireSuccessful(result, "Kubernetes workloads are not readable.");
      requireReadyWorkloads(result.stdout);
    } catch (error) {
      yield* Effect.fail(error instanceof Error ? error.message : "Kubernetes workloads are not ready.");
    }
    console.log(`${gate}: workloads readable in ${namespace}`);
    return;
  }
  if (gate === "compose-evidence") {
    const result = yield* runCommand("docker", ["compose", "config", "--quiet"]);
    requireSuccessful(result, "Compose configuration is invalid.");
  } else if (gate === "ordinary-runner-smoke" || gate === "workflow-contract-smoke") {
    const result = yield* kubectlRead("deployment/sheet-workflows-runner");
    try {
      requireSuccessful(result, `${gate} could not inspect Kubernetes workloads.`);
      requireReadyWorkloads(result.stdout);
    } catch (error) {
      yield* Effect.fail(error instanceof Error ? error.message : `${gate} workload check failed.`);
    }
    const botToken = yield* readSecret("sheet-bot-secret", "discordToken");
    const channel = yield* discordRequest(botToken, `/channels/${developmentChannelId}`);
    yield* workflowSmoke(assertObjectString(channel, "guild_id"), developmentChannelId);
  } else if (gate === "browser-runner-smoke") {
    const result = yield* kubectlRead("deployment/sheet-workflows-browser-runner");
    requireSuccessful(result, "Browser-runner resources are unavailable.");
    requireReadyWorkloads(result.stdout);
    const browser = yield* runCommand("kubectl", [
      "--context",
      process.env.KUBE_CONTEXT ?? "tiara-stack-dev",
      "--namespace",
      process.env.KUBE_NAMESPACE ?? "tiara-stack-dev",
      "exec",
      "deploy/sheet-workflows-browser-runner",
      "--",
      "sh",
      "-c",
      "chrome=$(find /ms-playwright -maxdepth 4 -type f -name chrome -print -quit); test -n \"$chrome\"; \"$chrome\" --headless --no-sandbox --disable-gpu --dump-dom about:blank",
    ],
    120_000,
  );
    requireSuccessful(browser, "Browser-runner Chromium is unavailable.");
    if ((browser.stdout?.trim() ?? "").length === 0) {
      yield* Effect.fail("Browser-runner Chromium is unavailable.");
    }
  } else if (gate === "kubernetes-invariants") {
    const ingressResult = yield* kubectlRead("ingress");
    const policyResult = yield* kubectlRead("networkpolicy");
    const statefulSetResult = yield* kubectlRead("statefulsets");
    requireSuccessful(ingressResult, "Kubernetes ingress resources are unavailable.");
    requireSuccessful(policyResult, "Kubernetes NetworkPolicy resources are unavailable.");
    requireSuccessful(statefulSetResult, "Kubernetes persistent resources are unavailable.");
    const ingress = JSON.parse(ingressResult.stdout ?? "{}");
    const policies = JSON.parse(policyResult.stdout ?? "{}");
    const statefulSets = JSON.parse(statefulSetResult.stdout ?? "{}");
    const policyNames = new Set((policies.items ?? []).map((item: { readonly metadata?: { readonly name?: string } }) => item.metadata?.name));
    for (const required of [
      "zero-cache-to-sheet-db-server",
      "sheet-workflows-runner-runner-rpc",
      "sheet-workflows-browser-runner-runner-rpc",
    ]) {
      if (!policyNames.has(required)) yield* Effect.fail(`Kubernetes NetworkPolicy ${required} is missing.`);
    }
    const statefulSetNames = new Set((statefulSets.items ?? []).map((item: { readonly metadata?: { readonly name?: string } }) => item.metadata?.name));
    for (const required of ["zero-cache", "tiara-stack-dev-meilisearch"]) {
      if (!statefulSetNames.has(required)) yield* Effect.fail(`Persistent workload ${required} is missing.`);
    }
    const ingressItems = Array.isArray(ingress.items) ? ingress.items : [];
    if (ingressItems.length === 0) yield* Effect.fail("Kubernetes ingress is missing.");
    if (ingressItems.some((item: { readonly kind?: string; readonly spec?: { readonly tls?: unknown[] } }) => item.kind === "Ingress" && (item.spec?.tls?.length ?? 0) === 0)) {
      yield* Effect.fail("Kubernetes ingress is missing TLS configuration.");
    }
  } else if (gate === "discord-development-check" || gate === "google-sheets-development-check") {
    if (gate === "discord-development-check") {
      const token = yield* readSecret("sheet-bot-secret", "discordToken");
      yield* discordSmoke(token);
    } else {
      yield* googleSheetsSmoke();
    }
  } else {
    yield* Effect.fail(`Unsupported parity gate ${gate}.`);
  }
  console.log(`${gate}: development-only evidence passed`);
});

Effect.runPromiseExit(run).then((exit) => {
  if (exit._tag === "Success") return;
  console.error(Cause.pretty(exit.cause));
  process.exitCode = 2;
});
