import * as AST from "effect/SchemaAST";
import type { ZeroValueType } from "../types";

export type InferTypeResult = {
  readonly type: ZeroValueType;
  readonly customType: string;
  readonly optional: boolean;
  readonly enumValues?: readonly string[];
};

const zeroCustomTypes = {
  boolean: "boolean",
  number: "number",
  json: "ReadonlyJSONValue",
  string: "string",
} satisfies Record<ZeroValueType, string>;

export const zeroCustomType = (type: ZeroValueType): string => zeroCustomTypes[type];

const emptyReadonlyArray = new Set(["ReadonlyArray", "Array"]);

const getEncodedAst = (ast: AST.AST): AST.AST => {
  const encoding = ast.encoding;
  return encoding?.[encoding.length - 1]?.to ?? ast;
};

const isOptionalAst = (ast: AST.AST): boolean =>
  Boolean(ast.context?.isOptional || (ast.context && "defaultValue" in ast.context));

const inferPrimitiveAst = (ast: AST.AST, optional: boolean): InferTypeResult | undefined => {
  if (AST.isString(ast)) {
    return { type: "string", customType: "string", optional };
  }
  if (AST.isNumber(ast)) {
    return { type: "number", customType: "number", optional };
  }
  if (AST.isBoolean(ast)) {
    return { type: "boolean", customType: "boolean", optional };
  }
  return undefined;
};

const inferJsonAst = (ast: AST.AST, optional: boolean): InferTypeResult | undefined =>
  AST.isAny(ast) || AST.isUnknown(ast) || AST.isObjectKeyword(ast) || AST.isObjects(ast)
    ? { type: "json", customType: "ReadonlyJSONValue", optional }
    : undefined;

const inferArrayAst = (ast: AST.AST, optional: boolean): InferTypeResult | undefined => {
  if (!AST.isArrays(ast)) {
    return undefined;
  }
  const rest = ast.rest[0];
  const item = rest ? inferAst(rest) : undefined;
  return {
    type: "json",
    customType: item ? `ReadonlyArray<${item.customType}>` : "ReadonlyJSONValue",
    optional,
  };
};

const inferDeclarationAst = (ast: AST.AST, optional: boolean): InferTypeResult | undefined => {
  if (!AST.isDeclaration(ast)) {
    return undefined;
  }
  const identifier = ast.annotations?.identifier ?? ast.annotations?.id ?? ast.annotations?.title;
  return typeof identifier === "string" && emptyReadonlyArray.has(identifier)
    ? { type: "json", customType: "ReadonlyJSONValue", optional }
    : undefined;
};

const inferLiteralAst = (ast: AST.AST, optional: boolean): InferTypeResult | undefined => {
  if (!AST.isLiteral(ast)) {
    return undefined;
  }
  const literal = ast.literal;
  if (typeof literal === "string") {
    return {
      type: "string",
      customType: "string",
      optional,
      enumValues: [literal],
    };
  }
  if (typeof literal === "number") {
    return { type: "number", customType: "number", optional };
  }
  if (typeof literal === "boolean") {
    return { type: "boolean", customType: "boolean", optional };
  }
  return undefined;
};

const inferEnumAst = (ast: AST.AST, optional: boolean): InferTypeResult | undefined => {
  if (!AST.isEnum(ast)) {
    return undefined;
  }
  const values = ast.enums.map(([, value]) => value);
  if (values.every((value): value is string => typeof value === "string")) {
    return {
      type: "string",
      customType: "string",
      optional,
      enumValues: [...new Set(values)],
    };
  }
  return values.every((value) => typeof value === "number")
    ? { type: "number", customType: "number", optional }
    : undefined;
};

const mergeUnionVariants = (
  variants: ReadonlyArray<InferTypeResult>,
  optional: boolean,
): InferTypeResult => {
  const [first] = variants;
  if (!variants.every((variant) => variant.type === first!.type)) {
    return { type: "json", customType: "ReadonlyJSONValue", optional };
  }

  const enumValues = variants.flatMap((variant) => variant.enumValues ?? []);
  const hasFiniteStringVariants = variants.every((variant) => variant.enumValues !== undefined);
  if (enumValues.length > 0 && first!.type === "string" && hasFiniteStringVariants) {
    return {
      type: "string",
      customType: "string",
      optional,
      enumValues: [...new Set(enumValues)],
    };
  }

  const customTypes = [...new Set(variants.map((variant) => variant.customType))];
  return {
    type: first!.type,
    customType: customTypes.length === 1 ? customTypes[0]! : zeroCustomType(first!.type),
    optional,
  };
};

const inferUnionAst = (ast: AST.AST, optionalFromContext: boolean): InferTypeResult | undefined => {
  if (!AST.isUnion(ast)) {
    return undefined;
  }

  let optional = optionalFromContext;
  const variants: InferTypeResult[] = [];
  for (const type of ast.types) {
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

  return variants.length === 0 ? undefined : mergeUnionVariants(variants, optional);
};

export const inferAst = (ast: AST.AST): InferTypeResult | undefined => {
  const encodedAst = getEncodedAst(ast);
  const optional = isOptionalAst(encodedAst);

  return (
    inferPrimitiveAst(encodedAst, optional) ??
    inferJsonAst(encodedAst, optional) ??
    inferArrayAst(encodedAst, optional) ??
    inferDeclarationAst(encodedAst, optional) ??
    inferLiteralAst(encodedAst, optional) ??
    inferEnumAst(encodedAst, optional) ??
    inferUnionAst(encodedAst, optional)
  );
};
