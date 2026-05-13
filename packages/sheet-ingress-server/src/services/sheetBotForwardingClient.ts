import { Context, Effect, Layer } from "effect";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetBotRpcClient } from "./sheetBotRpcClient";

export class SheetBotForwardingClient extends Context.Service<SheetBotForwardingClient>()(
  "SheetBotForwardingClient",
  {
    make: Effect.gen(function* () {
      const rpcClient = yield* SheetBotRpcClient;

      type RpcPayload<Tag extends keyof typeof rpcClient> = Parameters<(typeof rpcClient)[Tag]>[0];

      return {
        application: {
          getApplication: () => rpcClient["application.getApplication"](undefined),
        },
        bot: {
          createInteractionResponse: (args: RpcPayload<"bot.createInteractionResponse">) =>
            rpcClient["bot.createInteractionResponse"](args),
          sendMessage: (args: RpcPayload<"bot.sendMessage">) => rpcClient["bot.sendMessage"](args),
          updateMessage: (args: RpcPayload<"bot.updateMessage">) =>
            rpcClient["bot.updateMessage"](args),
          updateOriginalInteractionResponse: (
            args: RpcPayload<"bot.updateOriginalInteractionResponse">,
          ) => rpcClient["bot.updateOriginalInteractionResponse"](args),
          createPin: (args: RpcPayload<"bot.createPin">) => rpcClient["bot.createPin"](args),
          deleteMessage: (args: RpcPayload<"bot.deleteMessage">) =>
            rpcClient["bot.deleteMessage"](args),
          addGuildMemberRole: (args: RpcPayload<"bot.addGuildMemberRole">) =>
            rpcClient["bot.addGuildMemberRole"](args),
          removeGuildMemberRole: (args: RpcPayload<"bot.removeGuildMemberRole">) =>
            rpcClient["bot.removeGuildMemberRole"](args),
        },
        cache: {
          getGuild: (args: RpcPayload<"cache.getGuild">) => rpcClient["cache.getGuild"](args),
          getGuildSize: () => rpcClient["cache.getGuildSize"](undefined),
          getChannel: (args: RpcPayload<"cache.getChannel">) => rpcClient["cache.getChannel"](args),
          getRole: (args: RpcPayload<"cache.getRole">) => rpcClient["cache.getRole"](args),
          getMember: (args: RpcPayload<"cache.getMember">) => rpcClient["cache.getMember"](args),
          getChannelsForParent: (args: RpcPayload<"cache.getChannelsForParent">) =>
            rpcClient["cache.getChannelsForParent"](args),
          getRolesForParent: (args: RpcPayload<"cache.getRolesForParent">) =>
            rpcClient["cache.getRolesForParent"](args),
          getMembersForParent: (args: RpcPayload<"cache.getMembersForParent">) =>
            rpcClient["cache.getMembersForParent"](args),
          getChannelsForResource: (args: RpcPayload<"cache.getChannelsForResource">) =>
            rpcClient["cache.getChannelsForResource"](args),
          getRolesForResource: (args: RpcPayload<"cache.getRolesForResource">) =>
            rpcClient["cache.getRolesForResource"](args),
          getMembersForResource: (args: RpcPayload<"cache.getMembersForResource">) =>
            rpcClient["cache.getMembersForResource"](args),
          getChannelsSize: () => rpcClient["cache.getChannelsSize"](undefined),
          getRolesSize: () => rpcClient["cache.getRolesSize"](undefined),
          getMembersSize: () => rpcClient["cache.getMembersSize"](undefined),
          getChannelsSizeForParent: (args: RpcPayload<"cache.getChannelsSizeForParent">) =>
            rpcClient["cache.getChannelsSizeForParent"](args),
          getRolesSizeForParent: (args: RpcPayload<"cache.getRolesSizeForParent">) =>
            rpcClient["cache.getRolesSizeForParent"](args),
          getMembersSizeForParent: (args: RpcPayload<"cache.getMembersSizeForParent">) =>
            rpcClient["cache.getMembersSizeForParent"](args),
          getChannelsSizeForResource: (args: RpcPayload<"cache.getChannelsSizeForResource">) =>
            rpcClient["cache.getChannelsSizeForResource"](args),
          getRolesSizeForResource: (args: RpcPayload<"cache.getRolesSizeForResource">) =>
            rpcClient["cache.getRolesSizeForResource"](args),
          getMembersSizeForResource: (args: RpcPayload<"cache.getMembersSizeForResource">) =>
            rpcClient["cache.getMembersSizeForResource"](args),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetBotForwardingClient, this.make).pipe(
    Layer.provide(SheetBotRpcClient.layer),
    Layer.provide(SheetApisRpcTokens.layer),
  );
}
