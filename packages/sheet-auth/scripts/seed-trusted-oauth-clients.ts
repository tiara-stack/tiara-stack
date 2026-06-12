import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { oauthClient } from "../src/schema";

type TrustedClientSpec = {
  clientId: string;
  clientSecret?: string | undefined;
  name: string;
  kind: string;
  scopes: string[];
  redirectUris?: string[] | undefined;
  tokenEndpointAuthMethod?: string | undefined;
  grantTypes?: string[] | undefined;
  responseTypes?: string[] | undefined;
  public?: boolean | undefined;
  type?: string | undefined;
  requirePKCE?: boolean | undefined;
};

const defaultTrustedClients = [
  {
    envPrefix: "SHEET_INGRESS",
    name: "sheet-ingress-server",
    kind: "sheet-ingress-server",
    scopes: ["ingress.forward"],
  },
  {
    envPrefix: "SHEET_BOT",
    name: "sheet-bot",
    kind: "sheet-bot",
    scopes: ["service", "bot.impersonate", "token.exchange", "workflow.dispatch"],
  },
  {
    envPrefix: "SHEET_APIS",
    name: "sheet-apis",
    kind: "sheet-apis",
    scopes: ["service"],
  },
  {
    envPrefix: "SHEET_WORKFLOWS",
    name: "sheet-workflows",
    kind: "sheet-workflows",
    scopes: ["service"],
  },
] as const;

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const optionalEnv = (name: string) => {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
};

const hashClientSecret = (secret: string) =>
  createHash("sha256").update(new TextEncoder().encode(secret)).digest("base64url");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireStringField = (entry: Record<string, unknown>, field: string) => {
  const value = entry[field];
  if (typeof value !== "string") {
    throw new Error(`TRUSTED_OAUTH_CLIENTS_JSON client spec ${field} must be a string`);
  }
  return value;
};

const optionalStringField = (entry: Record<string, unknown>, field: string) => {
  const value = entry[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`TRUSTED_OAUTH_CLIENTS_JSON client spec ${field} must be a string`);
  }
  return value;
};

const optionalBooleanField = (entry: Record<string, unknown>, field: string) => {
  const value = entry[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`TRUSTED_OAUTH_CLIENTS_JSON client spec ${field} must be a boolean`);
  }
  return value;
};

const requireScopes = (entry: Record<string, unknown>) => {
  const scopes = entry.scopes;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
    throw new Error("TRUSTED_OAUTH_CLIENTS_JSON client spec scopes must be a string array");
  }
  return scopes;
};

const optionalStringArrayField = (entry: Record<string, unknown>, field: string) => {
  const values = entry[field];
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    throw new Error(`TRUSTED_OAUTH_CLIENTS_JSON client spec ${field} must be a string array`);
  }
  return values;
};

const parseTrustedClientSpec = (entry: unknown): TrustedClientSpec => {
  if (!isRecord(entry)) {
    throw new Error("TRUSTED_OAUTH_CLIENTS_JSON contains an invalid client spec");
  }

  return {
    clientId: requireStringField(entry, "clientId"),
    clientSecret: optionalStringField(entry, "clientSecret"),
    name: requireStringField(entry, "name"),
    kind: requireStringField(entry, "kind"),
    scopes: requireScopes(entry),
    redirectUris: optionalStringArrayField(entry, "redirectUris"),
    tokenEndpointAuthMethod: optionalStringField(entry, "tokenEndpointAuthMethod"),
    grantTypes: optionalStringArrayField(entry, "grantTypes"),
    responseTypes: optionalStringArrayField(entry, "responseTypes"),
    public: optionalBooleanField(entry, "public"),
    type: optionalStringField(entry, "type"),
    requirePKCE: optionalBooleanField(entry, "requirePKCE"),
  };
};

const readJsonSpecs = (): TrustedClientSpec[] => {
  const json = optionalEnv("TRUSTED_OAUTH_CLIENTS_JSON");
  if (!json) {
    return [];
  }

  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("TRUSTED_OAUTH_CLIENTS_JSON must be an array");
  }

  return parsed.map(parseTrustedClientSpec);
};

const defaultSheetWebOAuthScopes = [
  "openid",
  "profile",
  "email",
  "sheet.read",
  "sheet.write",
  "sheet.manage",
  "workflow.dispatch",
  "offline_access",
];

const readSheetWebOAuthScopes = () => {
  const scopes = optionalEnv("SHEET_WEB_OAUTH_SCOPES");
  if (!scopes) {
    return defaultSheetWebOAuthScopes;
  }
  return scopes.split(" ").filter(Boolean);
};

const readSheetWebTrustedClientSpec = (): TrustedClientSpec[] => {
  const sheetWebBaseUrl = optionalEnv("SHEET_WEB_BASE_URL");
  if (!sheetWebBaseUrl) {
    return [];
  }
  const clientId = optionalEnv("SHEET_WEB_OAUTH_CLIENT_ID") ?? "sheet-web";

  return [
    {
      clientId,
      name: "sheet-web",
      kind: "sheet-web",
      scopes: readSheetWebOAuthScopes(),
      redirectUris: [
        new URL(
          optionalEnv("SHEET_WEB_OAUTH_REDIRECT_PATH") ?? "/auth/oauth/callback",
          sheetWebBaseUrl,
        ).href,
      ],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      public: true,
      type: "user-agent-based",
      requirePKCE: true,
    },
  ];
};

const readEnvSpecs = (): TrustedClientSpec[] => [
  ...defaultTrustedClients.flatMap((client) => {
    const clientId = optionalEnv(`${client.envPrefix}_OAUTH_CLIENT_ID`);
    const clientSecret = optionalEnv(`${client.envPrefix}_OAUTH_CLIENT_SECRET`);
    if (!clientId || !clientSecret) {
      return [];
    }

    return [
      {
        clientId,
        clientSecret,
        name: client.name,
        kind: client.kind,
        scopes: [...client.scopes],
      },
    ];
  }),
  ...readSheetWebTrustedClientSpec(),
];

const specs = [...readEnvSpecs(), ...readJsonSpecs()];
if (specs.length === 0) {
  throw new Error(
    "No trusted OAuth clients configured. Set *_OAUTH_CLIENT_ID/SECRET env vars or TRUSTED_OAUTH_CLIENTS_JSON.",
  );
}

const pgClient = postgres(requireEnv("POSTGRES_URL"));
const db = drizzle(pgClient);
const now = new Date();

try {
  for (const spec of specs) {
    const clientSecret =
      spec.clientSecret !== undefined ? hashClientSecret(spec.clientSecret) : undefined;
    const redirectUris = spec.redirectUris ?? [];
    const tokenEndpointAuthMethod = spec.tokenEndpointAuthMethod ?? "client_secret_basic";
    const grantTypes = spec.grantTypes ?? ["client_credentials"];
    const responseTypes = spec.responseTypes ?? [];
    const publicClient = spec.public ?? false;
    const clientType = spec.type ?? "web";
    const requirePKCE = spec.requirePKCE ?? true;

    await db
      .insert(oauthClient)
      .values({
        id: randomUUID(),
        clientId: spec.clientId,
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        name: spec.name,
        redirectUris,
        postLogoutRedirectUris: [],
        tokenEndpointAuthMethod,
        grantTypes,
        responseTypes,
        public: publicClient,
        requirePKCE,
        type: clientType,
        scopes: spec.scopes,
        skipConsent: true,
        disabled: false,
        metadata: {
          trusted: true,
          kind: spec.kind,
        },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthClient.clientId,
        set: {
          ...(clientSecret !== undefined ? { clientSecret } : {}),
          name: spec.name,
          redirectUris,
          postLogoutRedirectUris: [],
          tokenEndpointAuthMethod,
          grantTypes,
          responseTypes,
          public: publicClient,
          requirePKCE,
          type: clientType,
          scopes: spec.scopes,
          skipConsent: true,
          disabled: false,
          metadata: {
            trusted: true,
            kind: spec.kind,
          },
          updatedAt: now,
        },
      });

    console.log(`Seeded trusted OAuth client ${spec.name} (${spec.clientId})`);
  }
} finally {
  await pgClient.end();
}
