import { Option } from "effect";

export const uniqueChannelNames = (
  channels: ReadonlyArray<{ readonly name: Option.Option<string> }>,
) => {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const channel of channels) {
    const name = Option.getOrUndefined(channel.name);
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    names.push(name);
  }

  return names;
};
