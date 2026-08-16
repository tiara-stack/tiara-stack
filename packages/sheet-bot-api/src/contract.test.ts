import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  BotAdmissionPolicies,
  BotCacheEndpoints,
  BotCollectionCursor,
  BotCollectionPageRequest,
  BotConversationPage,
  BotDeliveryEndpoints,
  BotOutboundFile,
  BotOutboundMessage,
  BotPermissionOverwrite,
  ClientRef,
  DeliveryKey,
  DeliveryReceipt,
  ReplaceConversationPermissionOverwritesReceipt,
  ResponseReference,
  RespondReceipt,
  SemanticFileIdentity,
  SendMessageReceipt,
  SetMemberRoleReceipt,
  SheetBotHttpClientMetadata,
  getBotAdmissionPolicy,
  messageRefFrom,
  type RespondInput,
  type SendMessageInput,
  type SheetBotHttpClient,
  maximumBotCollectionPageSize,
  maximumBotFileEvidenceByteLength,
  maximumBotFileEvidenceTextLength,
  maximumBotOutboundFileCount,
} from "./index";

const client = { platform: "discord", clientId: "bot-1" } as const;
const message = messageRefFrom(client, "workspace-1", "conversation-1", "message-1");
const deliveryKey = Schema.decodeUnknownSync(DeliveryKey)("workflow/action/message-1");
const responseReference = Schema.decodeUnknownSync(ResponseReference)("opaque-response-handle");

describe("sheet-bot operation contracts", () => {
  it("keeps Response References and Delivery Keys opaque and non-empty", () => {
    expect(Schema.encodeSync(ResponseReference)(responseReference)).toBe("opaque-response-handle");
    expect(Schema.encodeSync(DeliveryKey)(deliveryKey)).toBe("workflow/action/message-1");
    expect(() => Schema.decodeUnknownSync(ResponseReference)(" ")).toThrow(
      /Expected a string with no leading or trailing whitespace/,
    );
    expect(() => Schema.decodeUnknownSync(DeliveryKey)("")).toThrow(
      /Expected a value with a length of at least 1/,
    );
    expect(() =>
      Schema.decodeUnknownSync(ClientRef)({ platform: " discord", clientId: "bot-1" }),
    ).toThrow(/Expected a string with no leading or trailing whitespace/);
    expect(() =>
      Schema.decodeUnknownSync(ClientRef)({ platform: "discord", clientId: "" }),
    ).toThrow(/Expected a value with a length of at least 1/);
  });

  it("round-trips stable Delivery Receipts", () => {
    const responseEncoded = {
      deliveryKey,
      operation: "respond",
      target: { _tag: "Response", responseReference, message },
    } as const;
    const messageEncoded = {
      deliveryKey,
      operation: "sendMessage",
      target: { _tag: "Message", message },
    } as const;
    const memberRoleEncoded = {
      deliveryKey,
      operation: "setMemberRole",
      target: {
        _tag: "MemberRole",
        workspace: message.conversation.workspace,
        userId: "user-1",
        roleId: "role-1",
      },
    } as const;
    const conversationEncoded = {
      deliveryKey,
      operation: "replaceConversationPermissionOverwrites",
      target: { _tag: "Conversation", conversation: message.conversation },
    } as const;

    const responseReceipt = Schema.decodeUnknownSync(DeliveryReceipt)(responseEncoded);
    const messageReceipt = Schema.decodeUnknownSync(DeliveryReceipt)(messageEncoded);
    const memberRoleReceipt = Schema.decodeUnknownSync(DeliveryReceipt)(memberRoleEncoded);
    const conversationReceipt = Schema.decodeUnknownSync(DeliveryReceipt)(conversationEncoded);

    expect(Schema.encodeSync(DeliveryReceipt)(responseReceipt)).toEqual(responseEncoded);
    expect(Schema.decodeUnknownSync(RespondReceipt)(responseEncoded)).toEqual(responseReceipt);
    expect(Schema.encodeSync(DeliveryReceipt)(messageReceipt)).toEqual(messageEncoded);
    expect(Schema.decodeUnknownSync(SendMessageReceipt)(messageEncoded)).toEqual(messageReceipt);
    expect(Schema.encodeSync(DeliveryReceipt)(memberRoleReceipt)).toEqual(memberRoleEncoded);
    expect(Schema.decodeUnknownSync(SetMemberRoleReceipt)(memberRoleEncoded)).toEqual(
      memberRoleReceipt,
    );
    expect(Schema.encodeSync(DeliveryReceipt)(conversationReceipt)).toEqual(conversationEncoded);
    expect(
      Schema.decodeUnknownSync(ReplaceConversationPermissionOverwritesReceipt)(conversationEncoded),
    ).toEqual(conversationReceipt);

    expect(() =>
      Schema.decodeUnknownSync(SendMessageReceipt)({
        ...messageEncoded,
        operation: "editMessage",
      }),
    ).toThrow(/Expected "sendMessage", got "editMessage"/);
    expect(() =>
      Schema.decodeUnknownSync(RespondReceipt)({
        ...responseEncoded,
        target: messageEncoded.target,
      }),
    ).toThrow(/Expected "Response", got "Message"/);
    expect(() =>
      Schema.decodeUnknownSync(SendMessageReceipt)({
        ...messageEncoded,
        target: memberRoleEncoded.target,
      }),
    ).toThrow(/Expected "Message", got "MemberRole"/);
    expect(() =>
      Schema.decodeUnknownSync(SetMemberRoleReceipt)({
        ...memberRoleEncoded,
        target: conversationEncoded.target,
      }),
    ).toThrow(/Expected "MemberRole", got "Conversation"/);
    expect(() =>
      Schema.decodeUnknownSync(ReplaceConversationPermissionOverwritesReceipt)({
        ...conversationEncoded,
        target: memberRoleEncoded.target,
      }),
    ).toThrow(/Expected "Conversation", got "MemberRole"/);
  });

  it("serializes outbound files without exposing provider credentials", () => {
    const decoded = Schema.decodeUnknownSync(BotOutboundMessage)({
      content: [{ type: "text", text: "hello" }],
      files: [{ name: "evidence.bin", contentType: "application/octet-stream", content: "AQID" }],
      interactionToken: "must-not-cross-the-contract",
    });

    expect(decoded.files?.[0]?.content).toEqual(new Uint8Array([1, 2, 3]));
    expect(Schema.encodeSync(BotOutboundMessage)(decoded)).toEqual({
      content: [{ type: "text", text: "hello" }],
      files: [{ name: "evidence.bin", contentType: "application/octet-stream", content: "AQID" }],
    });
    expect(decoded).not.toHaveProperty("interactionToken");
  });

  it("rejects outbound files that cannot be represented in delivery evidence", () => {
    const outboundFileType = Schema.toType(BotOutboundFile);
    const outboundMessageType = Schema.toType(BotOutboundMessage);

    expect(() =>
      Schema.decodeUnknownSync(outboundFileType)({
        name: "x".repeat(maximumBotFileEvidenceTextLength + 1),
        contentType: "application/octet-stream",
        content: new Uint8Array(),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(outboundFileType)({
        name: "evidence.bin",
        contentType: "x".repeat(maximumBotFileEvidenceTextLength + 1),
        content: new Uint8Array(),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(outboundFileType)({
        name: "evidence.bin",
        contentType: "application/octet-stream",
        content: new Uint8Array(maximumBotFileEvidenceByteLength + 1),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(outboundMessageType)({
        files: Array.from({ length: maximumBotOutboundFileCount + 1 }, () => ({
          name: "evidence.bin",
          contentType: "application/octet-stream",
          content: new Uint8Array(),
        })),
      }),
    ).toThrow();
  }, 15_000);

  it("publishes opt-in semantic file binding and bounded receipt evidence", () => {
    const semanticIdentity = Schema.decodeUnknownSync(SemanticFileIdentity)(
      "screenshots.captureAndDeliver:invocation-1:capture-and-deliver-screenshot",
    );
    const decoded = Schema.decodeUnknownSync(BotOutboundMessage)({
      files: [
        {
          name: "screenshot.png",
          contentType: "image/png",
          content: "AQID",
          deliveryBinding: {
            semanticIdentity,
            logicalRequest: '["workspace-1","alpha",2]',
          },
        },
      ],
    });
    const receipt = Schema.decodeUnknownSync(RespondReceipt)({
      deliveryKey,
      operation: "respond",
      target: { _tag: "Response", responseReference },
      files: [
        {
          name: "screenshot.png",
          contentType: "image/png",
          byteLength: 3,
          deliveryBinding: decoded.files?.[0]?.deliveryBinding,
        },
      ],
    });

    expect(receipt.files).toEqual([
      {
        name: "screenshot.png",
        contentType: "image/png",
        byteLength: 3,
        deliveryBinding: {
          semanticIdentity,
          logicalRequest: '["workspace-1","alpha",2]',
        },
      },
    ]);
    expect(() =>
      Schema.decodeUnknownSync(RespondReceipt)({
        ...receipt,
        files: [{ ...receipt.files?.[0], byteLength: 25 * 1024 * 1024 + 1 }],
      }),
    ).toThrow();
  });

  it("requires numeric permission bitfields", () => {
    expect(
      Schema.decodeUnknownSync(BotPermissionOverwrite)({
        targetId: "role-1",
        targetKind: "role",
        allow: "1024",
        deny: "0",
      }),
    ).toMatchObject({ allow: "1024", deny: "0" });
    expect(() =>
      Schema.decodeUnknownSync(BotPermissionOverwrite)({
        targetId: "role-1",
        targetKind: "role",
        allow: "read",
        deny: "0",
      }),
    ).toThrow(/Expected a string matching the RegExp/);
  });

  it("bounds collection page requests and exposes explicit continuation", () => {
    const cursor = Schema.decodeUnknownSync(BotCollectionCursor)("opaque-page-cursor");

    expect(Schema.decodeUnknownSync(BotCollectionPageRequest)({ limit: 1 })).toEqual({ limit: 1 });
    expect(
      Schema.decodeUnknownSync(BotCollectionPageRequest)({
        limit: maximumBotCollectionPageSize,
        cursor,
      }),
    ).toEqual({ limit: maximumBotCollectionPageSize, cursor });
    expect(() => Schema.decodeUnknownSync(BotCollectionPageRequest)({ limit: 0 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BotCollectionPageRequest)({
        limit: maximumBotCollectionPageSize + 1,
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(BotCollectionCursor)(" ")).toThrow();

    expect(
      Schema.decodeUnknownSync(BotConversationPage)({
        items: [{ id: "conversation-1", type: 0 }],
        nextCursor: cursor,
      }),
    ).toEqual({ items: [{ id: "conversation-1", type: 0 }], nextCursor: cursor });
  });

  it("annotates every endpoint with its service admission policy", () => {
    for (const endpoint of Object.values(BotCacheEndpoints)) {
      expect(getBotAdmissionPolicy(endpoint)).toEqual(BotAdmissionPolicies.cacheRead);
    }
    for (const endpoint of Object.values(BotDeliveryEndpoints)) {
      expect(getBotAdmissionPolicy(endpoint)).toEqual(BotAdmissionPolicies.deliveryWrite);
    }
  });

  it("publishes immutable generated-client metadata", () => {
    expect(SheetBotHttpClientMetadata).toEqual({
      apiId: "sheet-bot",
      audience: "sheet-bot",
      groups: {
        cache: {
          requiredScope: "bot.cache.read",
          operations: Object.keys(BotCacheEndpoints),
        },
        delivery: {
          requiredScope: "bot.delivery.write",
          operations: Object.keys(BotDeliveryEndpoints),
        },
      },
    });
    expect(Object.isFrozen(SheetBotHttpClientMetadata)).toBe(true);
    expect(Object.isFrozen(SheetBotHttpClientMetadata.groups.cache.operations)).toBe(true);

    expectTypeOf<SheetBotHttpClient["cache"]["getWorkspace"]>().toBeFunction();
    expectTypeOf<SheetBotHttpClient["cache"]["listConversations"]>().toBeFunction();
    expectTypeOf<SheetBotHttpClient["delivery"]["respond"]>().toBeFunction();
    expectTypeOf<Parameters<SheetBotHttpClient["cache"]["getWorkspace"]>[0]["params"]>().toExtend<{
      readonly platform: string;
      readonly clientId: string;
      readonly workspaceId: string;
    }>();
    expectTypeOf<
      Parameters<SheetBotHttpClient["cache"]["listConversations"]>[0]["query"]
    >().toEqualTypeOf<{
      readonly limit: number;
      readonly cursor?: BotCollectionCursor | undefined;
    }>();
    expectTypeOf<
      Parameters<SheetBotHttpClient["cache"]["listMembers"]>[0]["query"]
    >().toEqualTypeOf<{
      readonly limit: number;
      readonly cursor?: BotCollectionCursor | undefined;
    }>();
    expectTypeOf<
      Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0]["payload"]
    >().toEqualTypeOf<SendMessageInput>();
    expectTypeOf<RespondInput>().toExtend<{
      readonly responseReference: ResponseReference;
      readonly deliveryKey: DeliveryKey;
    }>();
  });
});
