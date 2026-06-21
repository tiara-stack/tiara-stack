import { Option } from "effect";

export const uniqueConversationNames = (
  conversations: ReadonlyArray<{ readonly name: Option.Option<string> }>,
) => {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const conversation of conversations) {
    const name = Option.getOrUndefined(conversation.name);
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    names.push(name);
  }

  return names;
};
