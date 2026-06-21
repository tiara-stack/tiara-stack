import { Option } from "effect";

export const getModernMessageWorkspaceId = <
  T extends {
    workspaceId: Option.Option<string>;
    conversationId: Option.Option<string>;
  },
>(
  record: T,
) =>
  Option.match(record.workspaceId, {
    onSome: (workspaceId) =>
      Option.isSome(record.conversationId) ? Option.some(workspaceId) : Option.none(),
    onNone: () => Option.none(),
  });
