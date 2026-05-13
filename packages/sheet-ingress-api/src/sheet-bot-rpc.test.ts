import { describe, expect, it } from "vitest";
import { SheetBotRpcAuthorization } from "./middlewares/sheetBotRpcAuthorization/tag";
import { SheetBotRpcs } from "./sheet-bot-rpc";

describe("SheetBotRpcs", () => {
  it("keeps existing Discord RPC tags without dispatch tags", () => {
    expect(SheetBotRpcs.requests.has("application.getApplication")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.createInteractionResponse")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.sendMessage")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.updateMessage")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.updateOriginalInteractionResponse")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.createPin")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.deleteMessage")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.addGuildMemberRole")).toBe(true);
    expect(SheetBotRpcs.requests.has("bot.removeGuildMemberRole")).toBe(true);
    expect(SheetBotRpcs.requests.has("cache.getMember")).toBe(true);
    expect(SheetBotRpcs.requests.has("dispatch.checkin")).toBe(false);
    expect(SheetBotRpcs.requests.has("dispatch.roomOrder")).toBe(false);
  });

  it("requires authorization middleware on clients", () => {
    expect(SheetBotRpcAuthorization.requiredForClient).toBe(true);
  });
});
