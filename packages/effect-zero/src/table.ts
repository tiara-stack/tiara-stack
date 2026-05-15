import { Schema } from "effect";
import type { EffectZeroModel, EffectZeroTable, TableOptions } from "./types";

const identifierFromModel = (model: EffectZeroModel): string | undefined => {
  const ast = (model as { readonly ast?: { readonly annotations?: Record<string, unknown> } }).ast;
  const id = ast?.annotations?.identifier ?? ast?.annotations?.id ?? ast?.annotations?.title;
  return typeof id === "string" ? id : undefined;
};

export const table = <const Model extends EffectZeroModel>(
  model: Model,
  options: TableOptions<Model>,
): EffectZeroTable<Model> => {
  const decodedOptions = Schema.decodeUnknownSync(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      serverName: Schema.optional(Schema.String),
      key: Schema.NonEmptyArray(Schema.String),
      columns: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  )(options);

  const name = decodedOptions.name ?? identifierFromModel(model);
  if (!name) {
    throw new Error(
      "effect-zero: table name is required when it cannot be inferred from the model",
    );
  }

  return {
    model,
    name,
    serverName: decodedOptions.serverName,
    key: decodedOptions.key,
    columns: decodedOptions.columns as TableOptions<Model>["columns"],
  };
};
