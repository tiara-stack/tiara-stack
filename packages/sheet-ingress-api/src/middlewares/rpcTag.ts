import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

export type RpcTagSource = "_tag" | "string" | "tag" | "name" | "rpcTag";

export type RpcTagResult = {
  readonly tag: string;
  readonly source: RpcTagSource;
};

const RpcTagSourceSchema = Schema.Literals(["_tag", "string", "tag", "name", "rpcTag"]);

const RpcTagResultSchema = Schema.Struct({
  tag: Schema.String,
  source: RpcTagSourceSchema,
});

const RpcTagInputSchema = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Unknown),
]);

type RpcTagInput = Schema.Schema.Type<typeof RpcTagInputSchema>;

const isString = Schema.is(Schema.String);
const objectTagSources = ["_tag", "tag", "name", "rpcTag"] as const;

const resolveRpcTag = (rpc: RpcTagInput): RpcTagResult | undefined => {
  if (isString(rpc)) {
    return { tag: rpc, source: "string" };
  }

  for (const source of objectTagSources) {
    const tag = rpc[source];
    if (isString(tag)) {
      return { tag, source };
    }
  }

  return undefined;
};

const missingRpcTagIssue = (input: RpcTagInput) =>
  new SchemaIssue.InvalidValue(Option.some(input), { message: "Missing RPC tag" });

const RpcTagSchema = RpcTagInputSchema.pipe(
  Schema.decodeTo(RpcTagResultSchema, {
    decode: SchemaGetter.transformOrFail((input: RpcTagInput) => {
      const result = resolveRpcTag(input);
      return result ? Effect.succeed(result) : Effect.fail(missingRpcTagIssue(input));
    }),
    encode: SchemaGetter.forbidden(() => "RpcTagSchema cannot be encoded"),
  }),
);

export const getRpcTag = (rpc: unknown): RpcTagResult | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(RpcTagSchema)(rpc));
