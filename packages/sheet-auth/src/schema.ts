import { pgTable, text, timestamp, boolean, json, uniqueIndex } from "drizzle-orm/pg-core";

// Better Auth schema tables
// These are managed by Better Auth's Drizzle adapter

/**
 * User table - contains user authentication data
 *
 * Note: Discord OAuth tokens and Discord user ID are stored in the `account` table
 * by Better Auth's Discord provider. The account table acts as a junction table
 * to link internal users with external OAuth providers.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Account table - stores OAuth provider data
 *
 * Better Auth automatically stores Discord OAuth data here:
 * - accountId: The Discord user ID (used for lookups)
 * - providerId: "discord"
 * - accessToken: Discord API access token
 * - refreshToken: For refreshing expired tokens
 * - accessTokenExpiresAt: Token expiration time
 *
 * This table acts as a junction table to find the internal user ID from
 * a Discord user ID (for K8s M2M auth) or vice versa.
 */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("account_provider_id_account_id_unique").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// OAuth 2.1 Provider tables
// Schema based on @better-auth/oauth-provider requirements

export const oauthClient = pgTable("oauth_client", {
  id: text("id").primaryKey(),
  /**
   * The OAuth client ID - used to identify the client in OAuth flows
   * This is different from the internal id field
   */
  clientId: text("client_id").notNull().unique(),
  /**
   * The OAuth client secret - used for confidential clients
   */
  clientSecret: text("client_secret"),
  /**
   * Client name
   */
  name: text("name"),
  /**
   * Client URI (website)
   */
  uri: text("uri"),
  /**
   * Client icon URL
   */
  icon: text("icon"),
  /**
   * Contact emails for the client
   */
  contacts: text("contacts").array(),
  /**
   * Terms of Service URL
   */
  tos: text("tos"),
  /**
   * Privacy Policy URL
   */
  policy: text("policy"),
  /**
   * Software ID (for dynamic client registration)
   */
  softwareId: text("software_id"),
  /**
   * Software Version
   */
  softwareVersion: text("software_version"),
  /**
   * Software Statement
   */
  softwareStatement: text("software_statement"),
  /**
   * Whether the client is disabled
   */
  disabled: boolean("disabled").default(false),
  /**
   * Whether to skip consent screen for this client (trusted clients)
   */
  skipConsent: boolean("skip_consent"),
  /**
   * Whether to enable end-session endpoint for this client (OIDC)
   */
  enableEndSession: boolean("enable_end_session"),
  /**
   * Registered redirect URIs
   */
  redirectUris: text("redirect_uris").array().notNull(),
  /**
   * Post-logout redirect URIs
   */
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  /**
   * Token endpoint authentication method
   * e.g., "client_secret_basic", "client_secret_post", "none"
   */
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  /**
   * Allowed grant types
   */
  grantTypes: text("grant_types").array(),
  /**
   * Allowed response types
   */
  responseTypes: text("response_types").array(),
  /**
   * Whether this is a public client (cannot keep secrets)
   */
  public: boolean("public"),
  /**
   * Whether this client requires PKCE for authorization code flow.
   */
  requirePKCE: boolean("require_pkce"),
  /**
   * Subject identifier type: "public" or "pairwise".
   */
  subjectType: text("subject_type"),
  /**
   * Type of OAuth client
   * Supports: 'web', 'native', 'user-agent-based'
   */
  type: text("type"),
  /**
   * Allowed scopes
   */
  scopes: text("scopes").array(),
  /**
   * User ID that owns this client
   */
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  /**
   * Reference ID for organization/team ownership
   */
  referenceId: text("reference_id"),
  /**
   * Additional metadata
   */
  metadata: json("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const oauthRefreshToken = pgTable("oauth_refresh_token", {
  id: text("id").primaryKey(),
  /**
   * The opaque token value (unique)
   */
  token: text("token").notNull().unique(),
  /**
   * Client ID reference (references oauthClient.clientId)
   */
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  /**
   * User ID associated with this token
   */
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /**
   * Session ID associated with this token
   */
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  /**
   * Reference ID for organization/team
   */
  referenceId: text("reference_id"),
  /**
   * Scopes granted
   */
  scopes: text("scopes").array().notNull(),
  /**
   * Expiration time
   */
  expiresAt: timestamp("expires_at").notNull(),
  /**
   * When the token was revoked (null if active)
   */
  revoked: timestamp("revoked"),
  /**
   * Time when the end user authenticated.
   */
  authTime: timestamp("auth_time"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  /**
   * The opaque token value (unique)
   */
  token: text("token").notNull().unique(),
  /**
   * Client ID reference (references oauthClient.clientId)
   */
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  /**
   * User ID associated with this token (nullable for client_credentials)
   */
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  /**
   * Session ID associated with this token
   */
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  /**
   * Reference ID for organization/team
   */
  referenceId: text("reference_id"),
  /**
   * Refresh token ID that created this access token (for tracking)
   */
  refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "set null" }),
  /**
   * Scopes granted
   */
  scopes: text("scopes").array().notNull(),
  /**
   * Expiration time
   */
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  /**
   * Client ID (references oauthClient.clientId)
   */
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  /**
   * User ID who consented
   */
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  /**
   * Reference ID for organization/team
   */
  referenceId: text("reference_id"),
  /**
   * Scopes that were consented to
   */
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// JWKS table for JWT plugin
export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});
