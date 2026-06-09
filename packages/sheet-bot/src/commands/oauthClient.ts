import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Effect, FileSystem, Layer, Option, Redacted } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { createKubernetesOAuthSession } from "sheet-auth/client";
import { SheetAuthManagementClient } from "sheet-apis/services/sheetAuthManagementClient";
import { SheetAuthClient } from "../services/sheetAuthClient";
import { getInteractionUser } from "../utils/commandHelpers";

const SERVICE_ACCOUNT_TOKEN_PATH = "/var/run/secrets/tokens/sheet-auth-token";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeCommaList = (value: string | undefined): string[] =>
  value
    ?.split(/[\n,\r]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) ?? [];

const formatResponseBody = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return typeof value === "string" ? value : String(value);
  }
};

const safeText = (value: string, limit = 1_900) =>
  value.length <= limit ? value : `${value.slice(0, limit - 150)}... (truncated)`;

const getActorBearerToken = Effect.gen(function* () {
  const sheetAuthClient = yield* SheetAuthClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const interactionUser = yield* getInteractionUser;

  const rawToken = yield* fileSystem
    .readFileString(SERVICE_ACCOUNT_TOKEN_PATH, "utf-8")
    .pipe(Effect.map((token) => token.trim()))
    .pipe(
      Effect.tapError(() =>
        Effect.fail(new Error(`Missing kubernetes token at ${SERVICE_ACCOUNT_TOKEN_PATH}`)),
      ),
    );

  if (!rawToken) {
    return yield* Effect.fail(new Error("Service account token is empty"));
  }

  const session = yield* createKubernetesOAuthSession(
    sheetAuthClient,
    interactionUser.id,
    rawToken,
  ).pipe(
    Effect.catch(() =>
      Effect.fail(new Error("Failed to create managed OAuth session for interaction user")),
    ),
  );

  if (session.token === undefined) {
    return yield* Effect.fail(new Error("OAuth session token not returned by auth server"));
  }

  return {
    token: Redacted.value(session.token),
    userId: interactionUser.id,
  };
});

const respondWith = (
  response: { status: number; ok: boolean; parsed: unknown },
  fallbackMessage: string,
  includeBody = true,
) => {
  const body = includeBody ? safeText(formatResponseBody(response.parsed)) : "";
  return `${fallbackMessage}
HTTP ${response.status}${body.length > 0 ? `\n\n\`${body}\`` : ""}`;
};

const makeListClientsSubCommand = Effect.gen(function* () {
  return yield* CommandHelper.makeSubCommand(
    (builder) => builder.setName("list").setDescription("List your OAuth clients"),
    Effect.fn("oauthClients.list")(function* (_command) {
      const token = yield* getActorBearerToken;
      const sheetAuthManagementClient = yield* SheetAuthManagementClient;
      const response = yield* sheetAuthManagementClient.getClients(token.token);

      const interactionResponse = yield* InteractionResponse;
      return yield* interactionResponse.editReply({
        payload: {
          content: `OAuth client list (${response.status})\n${safeText(
            formatResponseBody(response.parsed),
          )}`,
        },
      });
    }),
  );
});

const makeCreateClientSubCommand = Effect.gen(function* () {
  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("create")
        .setDescription("Create a new OAuth client")
        .addStringOption((builder) =>
          builder.setName("name").setDescription("OAuth client name").setRequired(true),
        )
        .addBooleanOption((builder) =>
          builder
            .setName("trusted_service_client")
            .setDescription("Mark as trusted service client")
            .setRequired(false),
        )
        .addBooleanOption((builder) =>
          builder.setName("public").setDescription("Create as public client").setRequired(false),
        )
        .addStringOption((builder) =>
          builder
            .setName("allowed_services")
            .setDescription("Comma-separated allowed services")
            .setRequired(false),
        )
        .addStringOption((builder) =>
          builder
            .setName("allowed_scopes")
            .setDescription("Comma-separated scopes")
            .setRequired(false),
        ),
    Effect.fn("oauthClients.create")(function* (command) {
      const interactionResponse = yield* InteractionResponse;
      yield* interactionResponse.deferReply({ flags: MessageFlags.Ephemeral });

      const token = yield* getActorBearerToken;
      const name = Option.getOrUndefined(command.optionValueOptional("name"));
      if (typeof name !== "string" || name.length === 0) {
        return yield* interactionResponse.editReply({
          payload: {
            content: "name is required",
          },
        });
      }

      const trusted = Option.getOrUndefined(command.optionValueOptional("trusted_service_client"));
      const isPublic = Option.getOrUndefined(command.optionValueOptional("public"));
      const allowedServices = normalizeCommaList(
        Option.getOrUndefined(command.optionValueOptional("allowed_services")),
      );
      const allowedScopes = normalizeCommaList(
        Option.getOrUndefined(command.optionValueOptional("allowed_scopes")),
      );

      const sheetAuthManagementClient = yield* SheetAuthManagementClient;
      const response = yield* sheetAuthManagementClient.createClient(token.token, {
        client_name: name,
        grant_types: ["client_credentials"],
        response_types: ["code"],
        redirect_uris: ["https://localhost"],
        scope: allowedScopes.length > 0 ? allowedScopes.join(" ") : "sheet-apis sheet-workflows",
        token_endpoint_auth_method: isPublic === true ? "none" : "client_secret_basic",
        metadata: {
          trusted_service_client: typeof trusted === "boolean" ? trusted : undefined,
          allowed_services: allowedServices,
          allowed_scopes: allowedScopes,
          owner_user_id: token.userId,
        },
        public: isPublic === true,
      });

      const clientData = isRecord(response.parsed) ? response.parsed : {};
      const displayedSecret =
        typeof (clientData as { client_secret?: unknown }).client_secret === "string"
          ? `\n\nclient_secret: ${String((clientData as { client_secret: unknown }).client_secret)}`
          : "";

      return yield* interactionResponse.editReply({
        payload: {
          content: `${respondWith(
            response,
            `OAuth client created (${response.status})`,
            response.status >= 200 && response.status < 300,
          )}${displayedSecret}`,
        },
      });
    }),
  );
});

const makeRevokeClientSubCommand = Effect.gen(function* () {
  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("revoke")
        .setDescription("Revoke an OAuth client")
        .addStringOption((builder) =>
          builder.setName("client_id").setDescription("The client ID").setRequired(true),
        ),
    Effect.fn("oauthClients.revoke")(function* (command) {
      const interactionResponse = yield* InteractionResponse;
      yield* interactionResponse.deferReply({ flags: MessageFlags.Ephemeral });

      const token = yield* getActorBearerToken;
      const clientId = Option.getOrUndefined(command.optionValueOptional("client_id"));
      if (typeof clientId !== "string" || clientId.length === 0) {
        return yield* interactionResponse.editReply({
          payload: {
            content: "client_id is required",
          },
        });
      }

      const sheetAuthManagementClient = yield* SheetAuthManagementClient;
      const response = yield* sheetAuthManagementClient.deleteClient(token.token, clientId);

      return yield* interactionResponse.editReply({
        payload: {
          content: respondWith(response, `Client revoke attempted (${response.status})`),
        },
      });
    }),
  );
});

const makeOauthClientCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListClientsSubCommand;
  const createSubCommand = yield* makeCreateClientSubCommand;
  const revokeSubCommand = yield* makeRevokeClientSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("oauth_client")
        .setDescription("Manage OAuth clients")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listSubCommand.data)
        .addSubcommand(() => createSubCommand.data)
        .addSubcommand(() => revokeSubCommand.data),
    (command) =>
      command.subCommands({
        list: listSubCommand.handler,
        create: createSubCommand.handler,
        revoke: revokeSubCommand.handler,
      }),
  );
});

const makeGlobalOauthClientCommand = Effect.gen(function* () {
  const command = yield* makeOauthClientCommand;

  return CommandHelper.makeGlobalCommand(command.data, command.handler as never);
});

export const oauthClientCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalOauthClientCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(Layer.provide(Layer.mergeAll(SheetAuthClient.layer, SheetAuthManagementClient.layer)));
