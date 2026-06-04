import { DiscordApplication } from "dfx-discord-utils/discord";
import { MessageFlags } from "discord-api-types/v10";
import { Effect } from "effect";

interface ReplyableCommand {
  reply: (payload: {
    readonly content: string;
    readonly flags?: MessageFlags;
  }) => Effect.Effect<unknown, unknown>;
}

const isOwner = (userId: string) =>
  DiscordApplication.useSync((application) => {
    if (application.team) {
      return (
        application.team.owner_user_id === userId ||
        application.team.members.some(
          (member) =>
            member.user.id === userId && member.membership_state === 2 && member.role === "admin",
        )
      );
    }

    return application.owner.id === userId;
  });

export const requireOwner = (userId: string, command: ReplyableCommand) =>
  isOwner(userId).pipe(
    Effect.flatMap((owner) => {
      if (owner) {
        return Effect.succeed(true);
      }

      return command
        .reply({
          content: "You are not the owner.",
          flags: MessageFlags.Ephemeral,
        })
        .pipe(Effect.as(false));
    }),
  );
