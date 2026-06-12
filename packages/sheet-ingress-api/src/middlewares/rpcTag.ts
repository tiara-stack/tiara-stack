import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { Rpc } from "effect/unstable/rpc";

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

const resolveRpcTag = (rpc: RpcTagInput): RpcTagResult | undefined => {
  if (isString(rpc)) {
    return { tag: rpc, source: "string" };
  }

  const candidates = rpc as {
    readonly _tag?: unknown;
    readonly tag?: unknown;
    readonly name?: unknown;
    readonly rpcTag?: unknown;
  };

  if (isString(candidates._tag)) {
    return { tag: candidates._tag, source: "_tag" };
  }
  if (isString(candidates.tag)) {
    return { tag: candidates.tag, source: "tag" };
  }
  if (isString(candidates.name)) {
    return { tag: candidates.name, source: "name" };
  }
  if (isString(candidates.rpcTag)) {
    return { tag: candidates.rpcTag, source: "rpcTag" };
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
  Rpc.isRpc(rpc)
    ? { tag: rpc._tag, source: "_tag" }
    : Option.getOrUndefined(Schema.decodeUnknownOption(RpcTagSchema)(rpc));
