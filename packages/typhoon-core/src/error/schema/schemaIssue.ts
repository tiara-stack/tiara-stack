import {
  Option,
  Schema,
  SchemaAST,
  SchemaIssue as EffectSchemaIssue,
  Struct,
  SchemaGetter,
  Effect,
  SchemaParser,
} from "effect";

const Annotations = Schema.Record(Schema.String, Schema.Unknown);

const AugmentAnnotationsFields = Schema.Struct({
  expected: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  documentation: Schema.optional(Schema.String),
  readOnly: Schema.optional(Schema.Boolean),
  writeOnly: Schema.optional(Schema.Boolean),
  format: Schema.optional(Schema.String),
  contentEncoding: Schema.optional(Schema.String),
  contentMediaType: Schema.optional(Schema.String),
});

const DocumentationAnnotationsFields = AugmentAnnotationsFields.mapFields(
  Struct.assign({
    default: Schema.optional(Schema.Unknown),
    examples: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
);

const UnknownKeyAnnotationsFields = DocumentationAnnotationsFields.mapFields(
  Struct.assign({
    messageMissingKey: Schema.optional(Schema.String),
  }),
);

const UnknownKeyAnnotations = Schema.StructWithRest(UnknownKeyAnnotationsFields, [Annotations]);

const IssueAnnotationsFields = Schema.Struct({
  message: Schema.optional(Schema.String),
});

const IssueAnnotations = Schema.StructWithRest(IssueAnnotationsFields, [Annotations]);

// These AST fields are transport-only placeholders for now. They preserve
// payload shape across the wire, but decoded values are plain data rather than
// live SchemaAST instances.
const SchemaIssueAst = Schema.Unknown as Schema.Codec<SchemaAST.AST, SchemaAST.AST>;
const SchemaIssueFilterAst = Schema.Unknown as Schema.Codec<
  SchemaAST.Filter<unknown>,
  SchemaAST.Filter<unknown>
>;
const SchemaIssueUnionAst = Schema.Unknown as Schema.Codec<SchemaAST.Union, SchemaAST.Union>;

type FilterStruct = {
  _tag: "Filter";
  actual: unknown;
  filter: SchemaAST.Filter<unknown>;
  issue: SchemaIssueStruct;
};
const FilterStruct = Schema.TaggedStruct("Filter", {
  actual: Schema.Unknown,
  filter: SchemaIssueFilterAst,
  issue: Schema.suspend(
    (): Schema.Codec<SchemaIssueStruct, SchemaIssueStruct> => SchemaIssueStruct,
  ),
});
const FilterDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.Filter);
const Filter: Schema.Codec<EffectSchemaIssue.Filter, FilterStruct> = FilterStruct.pipe(
  Schema.decodeTo(FilterDeclare, {
    decode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ actual, filter, issue }) {
        const decodedIssue = yield* SchemaParser.decodeUnknownEffect(SchemaIssue)(issue);
        return new EffectSchemaIssue.Filter(actual, filter, decodedIssue);
      }),
    ),
    encode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ actual, filter, issue }) {
        const encodedIssue = yield* SchemaParser.encodeUnknownEffect(SchemaIssue)(issue);
        return {
          _tag: "Filter",
          actual,
          filter,
          issue: encodedIssue,
        };
      }),
    ),
  }),
);

type EncodingStruct = {
  _tag: "Encoding";
  ast: SchemaAST.AST;
  actual: Option.Option<unknown>;
  issue: SchemaIssueStruct;
};
const EncodingStruct = Schema.TaggedStruct("Encoding", {
  ast: SchemaIssueAst,
  actual: Schema.Option(Schema.Unknown),
  issue: Schema.suspend(
    (): Schema.Codec<SchemaIssueStruct, SchemaIssueStruct> => SchemaIssueStruct,
  ),
});
const EncodingDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.Encoding);
const Encoding: Schema.Codec<EffectSchemaIssue.Encoding, EncodingStruct> = EncodingStruct.pipe(
  Schema.decodeTo(EncodingDeclare, {
    decode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ ast, actual, issue }) {
        const decodedIssue = yield* SchemaParser.decodeUnknownEffect(SchemaIssue)(issue);
        return new EffectSchemaIssue.Encoding(ast, actual, decodedIssue);
      }),
    ),
    encode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ ast, actual, issue }) {
        const encodedIssue = yield* SchemaParser.encodeUnknownEffect(SchemaIssue)(issue);
        return {
          _tag: "Encoding",
          ast,
          actual,
          issue: encodedIssue,
        };
      }),
    ),
  }),
);

type PointerStruct = {
  _tag: "Pointer";
  path: ReadonlyArray<PropertyKey>;
  issue: SchemaIssueStruct;
};
const PointerStruct = Schema.TaggedStruct("Pointer", {
  path: Schema.Array(Schema.PropertyKey),
  issue: Schema.suspend(
    (): Schema.Codec<SchemaIssueStruct, SchemaIssueStruct> => SchemaIssueStruct,
  ),
});
const PointerDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.Pointer);
const Pointer: Schema.Codec<EffectSchemaIssue.Pointer, PointerStruct> = PointerStruct.pipe(
  Schema.decodeTo(PointerDeclare, {
    decode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ path, issue }) {
        const decodedIssue = yield* SchemaParser.decodeUnknownEffect(SchemaIssue)(issue);
        return new EffectSchemaIssue.Pointer(path, decodedIssue);
      }),
    ),
    encode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ path, issue }) {
        const encodedIssue = yield* SchemaParser.encodeUnknownEffect(SchemaIssue)(issue);
        return {
          _tag: "Pointer",
          path,
          issue: encodedIssue,
        };
      }),
    ),
  }),
);

type MissingKeyStruct = {
  _tag: "MissingKey";
  annotations: Schema.Annotations.Key<unknown> | undefined;
};
const MissingKeyStruct = Schema.TaggedStruct("MissingKey", {
  annotations: Schema.UndefinedOr(UnknownKeyAnnotations),
});
const MissingKeyDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.MissingKey);
const MissingKey = MissingKeyStruct.pipe(
  Schema.decodeTo(MissingKeyDeclare, {
    decode: SchemaGetter.transform(
      ({ annotations }) => new EffectSchemaIssue.MissingKey(annotations),
    ),
    encode: SchemaGetter.transform((missingKey) => missingKey),
  }),
);

type UnexpectedKeyStruct = {
  _tag: "UnexpectedKey";
  ast: SchemaAST.AST;
  actual: unknown;
};
const UnexpectedKeyStruct = Schema.TaggedStruct("UnexpectedKey", {
  ast: SchemaIssueAst,
  actual: Schema.Unknown,
});
const UnexpectedKeyDeclare = Schema.declare(
  (input) => input instanceof EffectSchemaIssue.UnexpectedKey,
);
const UnexpectedKey = UnexpectedKeyStruct.pipe(
  Schema.decodeTo(UnexpectedKeyDeclare, {
    decode: SchemaGetter.transform(
      ({ ast, actual }) => new EffectSchemaIssue.UnexpectedKey(ast, actual),
    ),
    encode: SchemaGetter.transform((unexpectedKey) => unexpectedKey),
  }),
);

type CompositeStruct = {
  _tag: "Composite";
  ast: SchemaAST.AST;
  actual: Option.Option<unknown>;
  issues: readonly [SchemaIssueStruct, ...SchemaIssueStruct[]];
};
const CompositeStruct = Schema.TaggedStruct("Composite", {
  ast: SchemaIssueAst,
  actual: Schema.Option(Schema.Unknown),
  issues: Schema.NonEmptyArray(
    Schema.suspend((): Schema.Codec<SchemaIssueStruct, SchemaIssueStruct> => SchemaIssueStruct),
  ),
});
const CompositeDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.Composite);
const Composite: Schema.Codec<EffectSchemaIssue.Composite, CompositeStruct> = CompositeStruct.pipe(
  Schema.decodeTo(CompositeDeclare, {
    decode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ ast, actual, issues }) {
        const decodedIssues = yield* SchemaParser.decodeUnknownEffect(
          Schema.NonEmptyArray(SchemaIssue),
        )(issues);
        return new EffectSchemaIssue.Composite(ast, actual, decodedIssues);
      }),
    ),
    encode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ ast, actual, issues }) {
        const encodedIssues = yield* SchemaParser.encodeUnknownEffect(
          Schema.NonEmptyArray(SchemaIssue),
        )(issues);
        return {
          _tag: "Composite",
          ast,
          actual,
          issues: encodedIssues,
        };
      }),
    ),
  }),
);

type InvalidTypeStruct = {
  _tag: "InvalidType";
  ast: SchemaAST.AST;
  actual: Option.Option<unknown>;
};
const InvalidTypeStruct = Schema.TaggedStruct("InvalidType", {
  ast: SchemaIssueAst,
  actual: Schema.Option(Schema.Unknown),
});
const InvalidTypeDeclare = Schema.declare(
  (input) => input instanceof EffectSchemaIssue.InvalidType,
);
const InvalidType = InvalidTypeStruct.pipe(
  Schema.decodeTo(InvalidTypeDeclare, {
    decode: SchemaGetter.transform(
      ({ ast, actual }) => new EffectSchemaIssue.InvalidType(ast, actual),
    ),
    encode: SchemaGetter.transform((invalidType) => invalidType),
  }),
);

type InvalidValueStruct = {
  _tag: "InvalidValue";
  actual: Option.Option<unknown>;
  annotations: Schema.Annotations.Issue | undefined;
};
const InvalidValueStruct = Schema.TaggedStruct("InvalidValue", {
  actual: Schema.Option(Schema.Unknown),
  annotations: Schema.UndefinedOr(IssueAnnotations),
});
const InvalidValueDeclare = Schema.declare(
  (input) => input instanceof EffectSchemaIssue.InvalidValue,
);
const InvalidValue = InvalidValueStruct.pipe(
  Schema.decodeTo(InvalidValueDeclare, {
    decode: SchemaGetter.transform(
      ({ actual, annotations }) => new EffectSchemaIssue.InvalidValue(actual, annotations),
    ),
    encode: SchemaGetter.transform((invalidValue) => invalidValue),
  }),
);

type ForbiddenStruct = {
  _tag: "Forbidden";
  actual: Option.Option<unknown>;
  annotations: Schema.Annotations.Issue | undefined;
};
const ForbiddenStruct = Schema.TaggedStruct("Forbidden", {
  actual: Schema.Option(Schema.Unknown),
  annotations: Schema.UndefinedOr(IssueAnnotations),
});
const ForbiddenDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.Forbidden);
const Forbidden = ForbiddenStruct.pipe(
  Schema.decodeTo(ForbiddenDeclare, {
    decode: SchemaGetter.transform(
      ({ actual, annotations }) => new EffectSchemaIssue.Forbidden(actual, annotations),
    ),
    encode: SchemaGetter.transform((forbidden) => forbidden),
  }),
);

type AnyOfStruct = {
  _tag: "AnyOf";
  ast: SchemaAST.Union;
  actual: unknown;
  issues: readonly [SchemaIssueStruct, ...SchemaIssueStruct[]];
};
const AnyOfStruct = Schema.TaggedStruct("AnyOf", {
  ast: SchemaIssueUnionAst,
  actual: Schema.Unknown,
  issues: Schema.NonEmptyArray(
    Schema.suspend((): Schema.Codec<SchemaIssueStruct, SchemaIssueStruct> => SchemaIssueStruct),
  ),
});
const AnyOfDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.AnyOf);
const AnyOf: Schema.Codec<EffectSchemaIssue.AnyOf, AnyOfStruct> = AnyOfStruct.pipe(
  Schema.decodeTo(AnyOfDeclare, {
    decode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ ast, actual, issues }) {
        const decodedIssues = yield* SchemaParser.decodeUnknownEffect(
          Schema.NonEmptyArray(SchemaIssue),
        )(issues);
        return new EffectSchemaIssue.AnyOf(ast, actual, decodedIssues);
      }),
    ),
    encode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* ({ ast, actual, issues }) {
        const encodedIssues = yield* SchemaParser.encodeUnknownEffect(
          Schema.NonEmptyArray(SchemaIssue),
        )(issues);
        return {
          _tag: "AnyOf",
          ast,
          actual,
          issues: encodedIssues,
        };
      }),
    ),
  }),
);

type OneOfStruct = {
  _tag: "OneOf";
  ast: SchemaAST.Union;
  actual: unknown;
  successes: ReadonlyArray<SchemaAST.AST>;
};
const OneOfStruct = Schema.TaggedStruct("OneOf", {
  ast: SchemaIssueUnionAst,
  actual: Schema.Unknown,
  successes: Schema.Array(SchemaIssueAst),
});
const OneOfDeclare = Schema.declare((input) => input instanceof EffectSchemaIssue.OneOf);
const OneOf = OneOfStruct.pipe(
  Schema.decodeTo(OneOfDeclare, {
    decode: SchemaGetter.transform(
      ({ ast, actual, successes }) => new EffectSchemaIssue.OneOf(ast, actual, successes),
    ),
    encode: SchemaGetter.transform((oneOf) => oneOf),
  }),
);

type LeafStruct =
  | InvalidTypeStruct
  | InvalidValueStruct
  | MissingKeyStruct
  | UnexpectedKeyStruct
  | ForbiddenStruct
  | OneOfStruct;

const LeafStruct = Schema.Union([
  InvalidTypeStruct,
  InvalidValueStruct,
  MissingKeyStruct,
  UnexpectedKeyStruct,
  ForbiddenStruct,
  OneOfStruct,
]);

const Leaf = Schema.Union([InvalidType, InvalidValue, MissingKey, UnexpectedKey, Forbidden, OneOf]);

export type SchemaIssueStruct =
  | LeafStruct
  | FilterStruct
  | EncodingStruct
  | PointerStruct
  | CompositeStruct
  | AnyOfStruct;

export const SchemaIssueStruct = Schema.Union([
  LeafStruct,
  FilterStruct,
  EncodingStruct,
  PointerStruct,
  CompositeStruct,
  AnyOfStruct,
]);

export const SchemaIssue = Schema.Union([Leaf, Filter, Encoding, Pointer, Composite, AnyOf]);
