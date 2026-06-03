import type * as Schema from "effect/Schema";
import type { ColumnOptions, EffectZeroTable, ZeroValueType } from "./types";
import { inferAst, zeroCustomType } from "./internal/inferAst";
import { typedEntries } from "./util";

export type InferredColumn = {
  readonly name: string;
  readonly serverName?: string;
  readonly type: ZeroValueType;
  readonly customType: string;
  readonly optional: boolean;
  readonly enumValues?: readonly string[];
};

export type InferredTable = {
  readonly name: string;
  readonly serverName?: string;
  readonly columns: Record<string, InferredColumn>;
  readonly primaryKey: readonly string[];
};

const resolveColumnOptions = (
  fieldName: string,
  config: boolean | ColumnOptions | undefined,
): ColumnOptions | undefined => {
  if (config === false) {
    return;
  }
  if (config === true || config === undefined) {
    return {};
  }
  if (typeof config === "object" && config !== null) {
    return config;
  }
  throw new Error(`effect-zero: invalid column config for ${fieldName}`);
};

export const inferTable = (
  table: EffectZeroTable,
  options?: { readonly debug?: boolean },
): InferredTable => {
  const primaryKeys = new Set(table.key);
  const columns: Record<string, InferredColumn> = {};

  for (const [fieldName, field] of typedEntries(table.model.fields)) {
    const rawColumnConfig = table.columns?.[fieldName];
    if (rawColumnConfig === false && !primaryKeys.has(fieldName)) {
      continue;
    }

    const columnOptions = resolveColumnOptions(fieldName, rawColumnConfig);
    if (!columnOptions && !primaryKeys.has(fieldName)) {
      continue;
    }

    const inferred = inferAst((field as Schema.Top).ast);
    const type = columnOptions?.type ?? inferred?.type;

    if (!type) {
      const message = `effect-zero: Unsupported field type for ${table.name}.${fieldName}; provide columns.${fieldName}.type to include it`;
      if (options?.debug) {
        console.warn(message);
      }
      continue;
    }

    const customType =
      columnOptions?.type !== undefined && columnOptions.type !== inferred?.type
        ? zeroCustomType(type)
        : (inferred?.customType ?? zeroCustomType(type));

    const name = columnOptions?.name ?? fieldName;
    const serverName =
      columnOptions?.serverName ??
      (columnOptions?.name && columnOptions.name !== fieldName ? columnOptions.name : undefined);

    columns[fieldName] = {
      name,
      serverName,
      type,
      customType,
      optional: primaryKeys.has(fieldName)
        ? false
        : (columnOptions?.optional ?? inferred?.optional ?? false),
      enumValues: inferred?.enumValues,
    };
  }

  for (const key of primaryKeys) {
    if (!columns[key]) {
      throw new Error(`effect-zero: primary key ${table.name}.${key} was not generated`);
    }
  }

  return {
    name: table.name,
    serverName: table.serverName,
    columns,
    primaryKey: table.key,
  };
};
