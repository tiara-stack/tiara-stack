const discordEmbedCharacterLimit = 6_000;
const discordEmbedFieldCountLimit = 25;
export const discordEmbedFieldNameLimit = 256;
const discordEmbedFieldValueLimit = 1_024;

export interface TeamListField {
  readonly name: string;
  readonly value: string;
}

export const truncateWithEllipsis = (value: string, limit: number): string =>
  limit <= 0 ? "" : value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export const boundTeamListFields = (
  fields: ReadonlyArray<TeamListField>,
  title: string,
): ReadonlyArray<TeamListField> => {
  const boundedFields = fields.map(({ name, value }) => ({
    name: truncateWithEllipsis(name, discordEmbedFieldNameLimit),
    value: truncateWithEllipsis(value, discordEmbedFieldValueLimit),
  }));
  const totalLength = boundedFields.reduce(
    (length, field) => length + field.name.length + field.value.length,
    title.length,
  );
  if (
    boundedFields.length <= discordEmbedFieldCountLimit &&
    totalLength <= discordEmbedCharacterLimit
  ) {
    return boundedFields;
  }

  const visibleFields: Array<TeamListField> = [];
  let visibleLength = title.length;
  for (const field of boundedFields) {
    const remainingCount = boundedFields.length - visibleFields.length;
    const overflowField = {
      name: "More teams",
      value: `${remainingCount} additional ${remainingCount === 1 ? "team was" : "teams were"} omitted.`,
    };
    const nextLength = field.name.length + field.value.length;
    const overflowLength = overflowField.name.length + overflowField.value.length;
    if (
      visibleFields.length >= discordEmbedFieldCountLimit - 1 ||
      visibleLength + nextLength + overflowLength > discordEmbedCharacterLimit
    ) {
      return [...visibleFields, overflowField];
    }
    visibleFields.push(field);
    visibleLength += nextLength;
  }
  return visibleFields;
};
