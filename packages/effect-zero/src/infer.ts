import * as AST from "effect/SchemaAST";
import type * as Schema from "effect/Schema";
import type { ColumnOptions, EffectZeroTable, ZeroValueType } from "./types";
import { typedEntries } from "./util";

export type InferredColumn = {
  readonly name: string;
  readonly serverName?: string;
  readonly type: ZeroValueType;
  readonly optional: boolean;
  readonly enumValues?: readonly string[];
};

export type InferredTable = {
  readonly name: string;
  readonly serverName?: string;
  readonly columns: Record<string, InferredColumn>;
  readonly primaryKey: readonly string[];
};

type InferTypeResult = {
  readonly type: ZeroValueType;
  readonly optional: boolean;
  readonly enumValues?: readonly string[];
};

const emptyReadonlyArray = new Set(["ReadonlyArray", "Array"]);

const getEncodedAst = (ast: AST.AST): AST.AST => {
  const encoding = ast.encoding;
  return encoding?.[encoding.length - 1]?.to ?? ast;
};

const inferAst = (ast: AST.AST): InferTypeResult | undefined => {
  const encodedAst = getEncodedAst(ast);
  const optionalFromContext = Boolean(
    encodedAst.context?.isOptional || (encodedAst.context && "defaultValue" in encodedAst.context),
  );

  if (AST.isString(encodedAst)) {
    return { type: "string", optional: optionalFromContext };
  }

  if (AST.isNumber(encodedAst)) {
    return { type: "number", optional: optionalFromContext };
  }

  if (AST.isBoolean(encodedAst)) {
    return { type: "boolean", optional: optionalFromContext };
  }

  if (
    AST.isAny(encodedAst) ||
    AST.isUnknown(encodedAst) ||
    AST.isObjectKeyword(encodedAst) ||
    AST.isObjects(encodedAst)
  ) {
    return { type: "json", optional: optionalFromContext };
  }

  if (AST.isArrays(encodedAst)) {
    return { type: "json", optional: optionalFromContext };
  }

  if (AST.isDeclaration(encodedAst)) {
    const identifier =
      encodedAst.annotations?.identifier ??
      encodedAst.annotations?.id ??
      encodedAst.annotations?.title;
    if (typeof identifier === "string" && emptyReadonlyArray.has(identifier)) {
      return { type: "json", optional: optionalFromContext };
    }
    return undefined;
  }

  if (AST.isLiteral(encodedAst)) {
    const literal = encodedAst.literal;
    if (typeof literal === "string") {
      return { type: "string", optional: optionalFromContext, enumValues: [literal] };
    }
    if (typeof literal === "number") {
      return { type: "number", optional: optionalFromContext };
    }
    if (typeof literal === "boolean") {
      return { type: "boolean", optional: optionalFromContext };
    }
    return undefined;
  }

  if (AST.isEnum(encodedAst)) {
    const values = encodedAst.enums.map(([, value]) => value);
    if (values.every((value): value is string => typeof value === "string")) {
      return { type: "string", optional: optionalFromContext, enumValues: [...new Set(values)] };
    }
    if (values.every((value) => typeof value === "number")) {
      return { type: "number", optional: optionalFromContext };
    }
    return undefined;
  }

  if (AST.isUnion(encodedAst)) {
    let optional = optionalFromContext;
    const variants: InferTypeResult[] = [];

    for (const type of encodedAst.types) {
      if (AST.isUndefined(type) || AST.isNull(type)) {
        optional = true;
        continue;
      }
      const variant = inferAst(type);
      if (!variant) {
        return undefined;
      }
      optional = optional || variant.optional;
      variants.push(variant);
    }

    if (variants.length === 0) {
      return undefined;
    }

    const [first] = variants;
    if (!variants.every((variant) => variant.type === first.type)) {
      return { type: "json", optional };
    }

    const enumValues = variants.flatMap((variant) => variant.enumValues ?? []);
    return enumValues.length > 0 && first.type === "string"
      ? { type: "string", optional, enumValues: [...new Set(enumValues)] }
      : { type: first.type, optional };
  }

  return undefined;
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

    const name = columnOptions?.name ?? fieldName;
    const serverName =
      columnOptions?.serverName ??
      (columnOptions?.name && columnOptions.name !== fieldName ? columnOptions.name : undefined);

    columns[fieldName] = {
      name,
      serverName,
      type,
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
