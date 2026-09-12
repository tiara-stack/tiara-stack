#!/usr/bin/env -S pnpm exec tsx
/// <reference types="node" />

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvironmentFile } from "../../../packages/developer-launcher/src/config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// fallow-ignore-next-line code-duplication
const envFileIndex = process.argv.indexOf("--env-file");
const envFileArgument = envFileIndex === -1 ? undefined : process.argv[envFileIndex + 1];
if (envFileIndex !== -1 && (envFileArgument === undefined || envFileArgument.startsWith("-"))) {
  throw new Error("--env-file requires a path");
}
const envFile =
  envFileArgument === undefined
    ? resolve(repoRoot, "deploy/compose/.env")
    : resolve(process.cwd(), envFileArgument);

if (!existsSync(envFile)) {
  throw new Error(`Env file not found at ${envFile}. Run pnpm dev setup compose first.`);
}

const parsed = readEnvironmentFile(envFile);
if (parsed.errors.length > 0) {
  throw new Error(parsed.errors.map(({ message }) => message).join("; "));
}
const values = parsed.values;

const password = values.POSTGRES_PASSWORD;
if (!password) throw new Error(`${envFile} must define POSTGRES_PASSWORD`);
const port = values.POSTGRES_PORT || "5432";
if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error(`${envFile} POSTGRES_PORT must be an integer between 1 and 65535`);
}
const inheritedKeys = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "NODE_PATH",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_USER_AGENT",
] as const;
const inheritedEnvironment = Object.fromEntries(
  inheritedKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!] ])),
);
const seedEnvironment = Object.fromEntries(
  [
    ["POSTGRES_URL", `postgres://tiara:${encodeURIComponent(password)}@localhost:${port}/tiara`],
    ...[
      "SHEET_BOT_OAUTH_CLIENT_ID",
      "SHEET_BOT_OAUTH_CLIENT_SECRET",
      "SHEET_WORKFLOWS_OAUTH_CLIENT_ID",
      "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET",
      "TRUSTED_OAUTH_CLIENTS_JSON",
      "SHEET_WEB_BASE_URL",
      "SHEET_WEB_OAUTH_CLIENT_ID",
      "SHEET_WEB_OAUTH_SCOPES",
      "SHEET_WEB_OAUTH_REDIRECT_PATH",
    ].flatMap((key) => (values[key] === undefined ? [] : [[key, values[key]]])),
  ],
);
const child = spawn("pnpm", ["--filter", "sheet-auth", "seed:trusted-oauth-clients"], {
  cwd: repoRoot,
  env: { ...inheritedEnvironment, ...seedEnvironment },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start Development Seed: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
