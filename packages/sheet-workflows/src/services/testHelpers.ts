import { Effect } from "effect";
import { ClientDeliveryClient } from "./clientDeliveryClient";

export const text = (value: string) => [{ type: "text" as const, text: value }];

type TestTextPart = {
  readonly type: string;
  readonly text?: string;
  readonly userId?: string;
  readonly roleId?: string;
  readonly conversation?: { readonly conversationId: string };
  readonly message?: { readonly messageId: string };
  readonly parts?: ReadonlyArray<unknown>;
  readonly label?: string;
  readonly url?: string;
  readonly term?: string;
  readonly casing?: string;
};

const clientTerms: Record<string, string> = {
  runDestination: "run destination",
  checkinDestination: "check-in destination",
  monitorRole: "monitor role",
  testRun: "test run",
};

const sentenceCase = (value: string): string => `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

const renderClientTerm = (part: TestTextPart): string => {
  const rendered = clientTerms[part.term ?? ""] ?? part.term ?? "";
  return part.casing === "sentence" ? sentenceCase(rendered) : rendered;
};

const nestedParts = (part: TestTextPart): string => renderTextForTest(part.parts ?? []) ?? "";

const renderers: Record<string, (part: TestTextPart) => string> = {
  text: (part) => part.text ?? "",
  inlineCode: (part) => part.text ?? "",
  userMention: (part) => `@${part.userId ?? ""}`,
  conversationMention: (part) => `#${part.conversation?.conversationId ?? ""}`,
  roleMention: (part) => `@role:${part.roleId ?? ""}`,
  messageLink: (part) =>
    part.label ?? (part.message?.messageId ? `message ${part.message.messageId}` : "message"),
  strong: nestedParts,
  subtle: nestedParts,
  strikethrough: nestedParts,
  externalLink: (part) => part.label ?? part.url ?? "",
  clientTerm: renderClientTerm,
};

const renderPartForTest = (part: unknown): string => {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return String(part);
  }

  const typedPart = part as TestTextPart;
  return renderers[typedPart.type]?.(typedPart) ?? "";
};

export const renderTextForTest = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined || typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  }

  return value.map(renderPartForTest).join("");
};

const textFieldKeys = new Set(["content", "title", "description", "name", "value", "text"]);

export const normalizePayloadText = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizePayloadText);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (textFieldKeys.has(key) && Array.isArray(item)) {
        return [key, renderTextForTest(item)];
      }
      return [key, normalizePayloadText(item)];
    }),
  );
};

const unexpected = (prefix: string, name: string) => () => Effect.die(`${prefix}: ${name}`);

type ClientDeliveryService = typeof ClientDeliveryClient.Service;
type BoundClientDeliveryService = ReturnType<ClientDeliveryService["forClient"]>;

const makeBoundClientDeliveryMock = (
  overrides: Partial<BoundClientDeliveryService> = {},
): BoundClientDeliveryService => {
  const unexpectedCall = (operation: string) => Effect.die(`Unexpected ${operation} call`);
  return {
    sendMessage: () => unexpectedCall("sendMessage"),
    sendDirectMessage: () => unexpectedCall("sendDirectMessage"),
    listClients: () => unexpectedCall("listClients"),
    updateMessage: () => unexpectedCall("updateMessage"),
    updateOriginalInteractionResponse: () => unexpectedCall("updateOriginalInteractionResponse"),
    updateOriginalInteractionResponseWithFiles: () =>
      unexpectedCall("updateOriginalInteractionResponseWithFiles"),
    createPin: () => unexpectedCall("createPin"),
    deleteMessage: () => unexpectedCall("deleteMessage"),
    addMessageReaction: () => unexpectedCall("addMessageReaction"),
    removeMessageReaction: () => unexpectedCall("removeMessageReaction"),
    addWorkspaceMemberRole: () => unexpectedCall("addWorkspaceMemberRole"),
    removeWorkspaceMemberRole: () => unexpectedCall("removeWorkspaceMemberRole"),
    getWorkspace: () => unexpectedCall("getWorkspace"),
    getMembersForParent: () => unexpectedCall("getMembersForParent"),
    getConversationsForParent: () => unexpectedCall("getConversationsForParent"),
    ...overrides,
  };
};

export const makeClientDeliveryMock = (
  overrides: Partial<ClientDeliveryService> = {},
): ClientDeliveryService => {
  const { forClient, ...boundOverrides } = overrides;
  const bound = makeBoundClientDeliveryMock(boundOverrides);
  return {
    ...bound,
    forClient:
      forClient ??
      function (this: ClientDeliveryService) {
        return this;
      },
  };
};

export const makeSheetApisClient = (
  services: Record<string, unknown>,
  prefix = "Unexpected call",
) =>
  ({
    get: () =>
      new Proxy(services, {
        get(target, group: string) {
          if (group in target) {
            return target[group];
          }

          return new Proxy(
            {},
            {
              get: (_service, method: string) => unexpected(prefix, `${group}.${method}`),
            },
          );
        },
      }),
  }) as never;
