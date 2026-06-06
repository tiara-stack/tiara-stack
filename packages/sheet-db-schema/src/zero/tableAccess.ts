type ModelWithVariants = {
  readonly insert?: unknown;
  readonly update?: unknown;
  readonly json?: unknown;
  readonly jsonCreate?: unknown;
  readonly jsonUpdate?: unknown;
};

export const zeroComparisonOperatorList = [
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "LIKE",
  "NOT LIKE",
  "ILIKE",
  "NOT ILIKE",
  "IN",
  "NOT IN",
  "IS",
  "IS NOT",
] as const;

export type ZeroComparisonOperator = (typeof zeroComparisonOperatorList)[number];

const zeroComparisonOperators = new Set<string>(zeroComparisonOperatorList);

type Whereable<Self> = {
  readonly where: (field: string, operator: ZeroComparisonOperator, value: unknown) => Self;
};

type Oneable<Result> = {
  readonly one: () => Result;
};

type TimestampOptions = {
  readonly createdAt: string;
  readonly updatedAt: string;
};

type DefineZeroTableAccessOptions = {
  readonly primaryKey: readonly string[];
  readonly softDelete?: string;
  readonly timestamps?: TimestampOptions;
};

type ExistingCreatedAt<CreatedAt extends string> = Partial<Record<CreatedAt, number | undefined>>;
type OneResult<Query> = Query extends Oneable<infer Result> ? Result : never;
type PrimaryKeyValue<Options extends DefineZeroTableAccessOptions> = Record<
  Options["primaryKey"][number],
  string | number
>;
type WithTimestamps<
  Value,
  Options extends DefineZeroTableAccessOptions,
> = Options["timestamps"] extends TimestampOptions
  ? Value & Record<Options["timestamps"]["createdAt"] | Options["timestamps"]["updatedAt"], number>
  : Value;
type WithUpdatedAt<
  Value,
  Options extends DefineZeroTableAccessOptions,
> = Options["timestamps"] extends TimestampOptions
  ? Value & Record<Options["timestamps"]["updatedAt"], number>
  : Value;
type WithSoftDelete<
  Value,
  Options extends DefineZeroTableAccessOptions,
> = Options["softDelete"] extends string ? Value & Record<Options["softDelete"], number> : Value;

const normalizeTimestamp = (value: number): number => Math.trunc(value);

export const defineZeroTableAccess = <
  const Model extends ModelWithVariants,
  const Table,
  const Options extends DefineZeroTableAccessOptions,
>(
  model: Model,
  table: Table,
  options: Options,
) => {
  const wherePrimaryKey = <
    Query extends Whereable<Query>,
    const Value extends PrimaryKeyValue<Options>,
  >(
    query: Query,
    primaryKey: Value,
  ): Query =>
    options.primaryKey.reduce<Query>(
      (current, field) =>
        current.where(field, "=", primaryKey[field as Options["primaryKey"][number]]),
      query,
    );

  const getByPrimaryKey = <
    Query extends Whereable<Query> & Oneable<unknown>,
    const Value extends PrimaryKeyValue<Options>,
  >(
    query: Query,
    primaryKey: Value,
  ): OneResult<Query> => wherePrimaryKey(query, primaryKey).one() as OneResult<Query>;

  const listActiveWhere = <Query extends Whereable<Query>>(query: Query): Query =>
    options.softDelete ? query.where(options.softDelete, "IS", null) : query;

  const getActiveByPrimaryKey = <
    Query extends Whereable<Query> & Oneable<unknown>,
    const Value extends PrimaryKeyValue<Options>,
  >(
    query: Query,
    primaryKey: Value,
  ): OneResult<Query> =>
    listActiveWhere(wherePrimaryKey(query, primaryKey)).one() as OneResult<Query>;

  const listWhere = <Query extends Whereable<Query>>(
    query: Query,
    field: string,
    operator: ZeroComparisonOperator,
    value: unknown,
  ): Query => {
    if (!zeroComparisonOperators.has(operator)) {
      throw new TypeError(`Unsupported Zero comparison operator: ${operator}`);
    }
    return query.where(field, operator, value);
  };

  const upsertWithTimestamps = <
    const Value extends Record<string, unknown>,
    const CreatedAt extends Options["timestamps"] extends TimestampOptions
      ? Options["timestamps"]["createdAt"]
      : never,
  >(
    value: Value,
    existing?: ExistingCreatedAt<CreatedAt>,
  ): WithTimestamps<Value, Options> => {
    if (!options.timestamps) {
      return value as WithTimestamps<Value, Options>;
    }

    const now = Date.now();
    const createdAt = options.timestamps.createdAt;
    const updatedAt = options.timestamps.updatedAt;

    return {
      ...value,
      [createdAt]: normalizeTimestamp(
        (value[createdAt] ?? existing?.[createdAt as CreatedAt] ?? now) as number,
      ),
      [updatedAt]: now,
    } as WithTimestamps<Value, Options>;
  };

  const updateWithTimestamp = <const Value extends Record<string, unknown>>(
    value: Value,
  ): WithUpdatedAt<Value, Options> => {
    if (!options.timestamps) {
      return value as WithUpdatedAt<Value, Options>;
    }

    return {
      ...value,
      [options.timestamps.updatedAt]: Date.now(),
    } as WithUpdatedAt<Value, Options>;
  };

  const softDeleteByPrimaryKey = <const Value extends PrimaryKeyValue<Options>>(
    primaryKey: Value,
  ): WithUpdatedAt<WithSoftDelete<Value, Options>, Options> => {
    if (!options.softDelete) {
      return primaryKey as WithUpdatedAt<WithSoftDelete<Value, Options>, Options>;
    }

    const now = Date.now();
    return {
      ...primaryKey,
      [options.softDelete]: now,
      ...(options.timestamps ? { [options.timestamps.updatedAt]: now } : {}),
    } as WithUpdatedAt<WithSoftDelete<Value, Options>, Options>;
  };

  return {
    model,
    table,
    options,
    schemas: {
      insert: model.insert,
      update: model.update,
      json: model.json,
      jsonCreate: model.jsonCreate,
      jsonUpdate: model.jsonUpdate,
    },
    getActiveByPrimaryKey,
    getByPrimaryKey,
    listActiveWhere,
    listWhere,
    softDeleteByPrimaryKey,
    upsertWithTimestamps,
    updateWithTimestamp,
    wherePrimaryKey,
  };
};
