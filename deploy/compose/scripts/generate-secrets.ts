#!/usr/bin/env -S pnpm exec tsx
/// <reference types="node" />

import { Schema } from "effect";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type WriteGeneratedFileOptions = {
  readonly mode?: number;
};

type SignJwtOptions = {
  readonly privateKeyPem: string;
  readonly kid: string;
  readonly subject: string;
  readonly audience: string;
};

const JwksSchema = Schema.Struct({
  keys: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kid: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const composeDir = resolve(scriptDir, "..");
const secretsDir = join(composeDir, "secrets");
const envPath = join(composeDir, ".env");
const noOverwrite = process.argv.includes("--no-overwrite");

const writeGeneratedFile = (
  path: string,
  contents: string,
  { mode }: WriteGeneratedFileOptions = {},
) => {
  if (noOverwrite && existsSync(path)) {
    return;
  }
  writeFileSync(path, contents, mode === undefined ? undefined : { mode });
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
};

const base64url = (input: string) => Buffer.from(input).toString("base64url");

const makePassword = () => randomBytes(24).toString("base64url");

const signJwt = ({ privateKeyPem, kid, subject, audience }: SignJwtOptions) => {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    kid,
    typ: "JWT",
  };
  const payload = {
    iss: "tiara-compose",
    sub: subject,
    aud: audience,
    iat: now,
    nbf: now - 5,
    exp: now + 30 * 24 * 60 * 60,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${signature.toString("base64url")}`;
};

mkdirSync(secretsDir, { recursive: true });

const jwtPrivateKeyPath = join(secretsDir, "jwt-private.pem");
const jwksPath = join(secretsDir, "jwks.json");
const hasExistingPrivateKey = existsSync(jwtPrivateKeyPath);
const hasExistingJwks = existsSync(jwksPath);

let privateKeyPem: string;
let kid: string;

if (noOverwrite && (hasExistingPrivateKey || hasExistingJwks)) {
  if (!hasExistingPrivateKey || !hasExistingJwks) {
    throw new Error(
      "--no-overwrite requires jwt-private.pem and jwks.json to both exist or both be absent",
    );
  }

  privateKeyPem = createPrivateKey(readFileSync(jwtPrivateKeyPath, "utf-8"))
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const jwks = Schema.decodeUnknownSync(JwksSchema)(JSON.parse(readFileSync(jwksPath, "utf-8")));
  kid = jwks.keys?.[0]?.kid ?? "";
  if (!kid) {
    throw new Error("jwks.json must contain a first key with a kid when using --no-overwrite");
  }
  const publicJwk = createPublicKey(privateKeyPem).export({ format: "jwk" });
  // This field order is part of the generated kid format; keep it in sync below.
  const expectedKid = createHash("sha256")
    .update(JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n }))
    .digest("base64url");
  if (kid !== expectedKid) {
    throw new Error("jwt-private.pem and jwks.json do not match");
  }
} else {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicJwk = publicKey.export({ format: "jwk" });
  // This field order is part of the generated kid format; keep it in sync above.
  kid = createHash("sha256")
    .update(JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n }))
    .digest("base64url");

  writeGeneratedFile(jwtPrivateKeyPath, privateKeyPem, { mode: 0o600 });
  writeGeneratedFile(
    jwksPath,
    `${JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }, null, 2)}\n`,
    { mode: 0o644 },
  );
}

const postgresPasswordPath = join(secretsDir, "postgres-password");
const redisPasswordPath = join(secretsDir, "redis-password");
const readSecretFile = (path: string) => readFileSync(path, "utf-8").trim();
const assertMatchingEnvAndSecret = (
  envName: "POSTGRES_PASSWORD" | "REDIS_PASSWORD",
  path: string,
) => {
  const envValue = process.env[envName]?.trim();
  const hasSecretFile = existsSync(path);
  if (!noOverwrite || envValue === undefined) return;
  if (!hasSecretFile) {
    throw new Error(`--no-overwrite found ${envName} but ${path} does not exist`);
  }
  const fileValue = readSecretFile(path);
  if (envValue !== fileValue) {
    throw new Error(`--no-overwrite found ${envName} but it does not match ${path}`);
  }
};
assertMatchingEnvAndSecret("POSTGRES_PASSWORD", postgresPasswordPath);
assertMatchingEnvAndSecret("REDIS_PASSWORD", redisPasswordPath);
const postgresPassword =
  noOverwrite && existsSync(postgresPasswordPath)
    ? readSecretFile(postgresPasswordPath)
    : makePassword();
const redisPassword =
  noOverwrite && existsSync(redisPasswordPath) ? readSecretFile(redisPasswordPath) : makePassword();

writeGeneratedFile(postgresPasswordPath, `${postgresPassword}\n`, { mode: 0o600 });
writeGeneratedFile(redisPasswordPath, `${redisPassword}\n`, { mode: 0o600 });

const googleServiceAccountPath = join(secretsDir, "google-service-account.json");
const googlePlaceholder = {
  type: "service_account",
  project_id: "replace-me",
  private_key_id: "replace-me",
  private_key: "-----BEGIN PRIVATE KEY-----\\nreplace-me\\n-----END PRIVATE KEY-----\\n",
  client_email: "replace-me@example.iam.gserviceaccount.com",
  client_id: "replace-me",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "replace-me",
  universe_domain: "googleapis.com",
};
writeGeneratedFile(
  join(secretsDir, "google-service-account.json.placeholder"),
  `${JSON.stringify(googlePlaceholder, null, 2)}\n`,
);
if (!existsSync(googleServiceAccountPath)) {
  writeFileSync(googleServiceAccountPath, `${JSON.stringify(googlePlaceholder, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(googleServiceAccountPath, 0o600);
}

const tokenSpecs = [
  {
    file: "sheet-apis-sheet-auth-token",
    serviceAccount: "sheet-apis",
    audience: "sheet-auth",
  },
  {
    file: "sheet-bot-sheet-auth-token",
    serviceAccount: "sheet-bot",
    audience: "sheet-auth",
  },
  {
    file: "sheet-workflows-sheet-auth-token",
    serviceAccount: "sheet-workflows",
    audience: "sheet-auth",
  },
  {
    file: "sheet-ingress-sheet-auth-token",
    serviceAccount: "sheet-ingress-server",
    audience: "sheet-auth",
  },
  {
    file: "sheet-ingress-sheet-apis-token",
    serviceAccount: "sheet-ingress-server",
    audience: "sheet-apis",
  },
  {
    file: "sheet-ingress-sheet-bot-token",
    serviceAccount: "sheet-ingress-server",
    audience: "sheet-bot",
  },
  {
    file: "sheet-ingress-sheet-workflows-token",
    serviceAccount: "sheet-ingress-server",
    audience: "sheet-workflows",
  },
  {
    file: "sheet-apis-zero-cache-token",
    serviceAccount: "sheet-apis",
    audience: "zero-cache",
  },
];

// Service-account JWTs are intentionally re-minted on every run. They must
// match the active private key and have a fresh 30-day expiry, so this bypasses
// writeGeneratedFile's --no-overwrite behavior.
for (const spec of tokenSpecs) {
  const tokenPath = join(secretsDir, spec.file);
  writeFileSync(
    tokenPath,
    `${signJwt({
      privateKeyPem,
      kid,
      subject: `system:serviceaccount:tiara-local:${spec.serviceAccount}`,
      audience: spec.audience,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(tokenPath, 0o600);
}

const readExistingEnvValue = (key: string) => {
  if (!existsSync(envPath)) return undefined;
  const prefix = `${key}=`;
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      const rawValue = line.slice(prefix.length).trim();
      if (!rawValue) return undefined;
      return /^(['"]).*\1$/.test(rawValue) ? rawValue.replace(/^(['"])(.*)\1$/, "$2") : rawValue;
    }
  }
  return undefined;
};
const preserveEnvValue = (key: string, fallback = "") => readExistingEnvValue(key) ?? fallback;
const zeroAdminPassword = readExistingEnvValue("ZERO_ADMIN_PASSWORD") ?? makePassword();

const envContents = `POSTGRES_PASSWORD=${postgresPassword}
POSTGRES_PORT=5432
REDIS_PASSWORD=${redisPassword}
ZERO_ADMIN_PASSWORD=${zeroAdminPassword}

DISCORD_CLIENT_ID=${preserveEnvValue("DISCORD_CLIENT_ID")}
DISCORD_CLIENT_SECRET=${preserveEnvValue("DISCORD_CLIENT_SECRET")}
DISCORD_TOKEN=${preserveEnvValue("DISCORD_TOKEN")}

SHEET_AUTH_PUBLIC_BASE_URL=${preserveEnvValue("SHEET_AUTH_PUBLIC_BASE_URL", "http://localhost:3002")}
SHEET_WEB_PUBLIC_BASE_URL=${preserveEnvValue("SHEET_WEB_PUBLIC_BASE_URL", "http://localhost:3001")}
SHEET_INGRESS_PUBLIC_BASE_URL=${preserveEnvValue("SHEET_INGRESS_PUBLIC_BASE_URL", "http://localhost:3000")}
TRUSTED_ORIGINS=${preserveEnvValue("TRUSTED_ORIGINS", "http://localhost:3001,http://localhost:3000,http://localhost:3002")}
COOKIE_DOMAIN=${preserveEnvValue("COOKIE_DOMAIN")}
OTEL_EXPORTER_OTLP_ENDPOINT=${preserveEnvValue("OTEL_EXPORTER_OTLP_ENDPOINT")}
`;
writeFileSync(envPath, envContents, { mode: 0o600 });
chmodSync(envPath, 0o600);

console.log(`Generated Compose secrets in ${secretsDir}`);
console.log(`Generated Compose environment file at ${envPath}`);
