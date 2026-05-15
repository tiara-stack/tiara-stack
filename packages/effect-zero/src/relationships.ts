import { Schema } from "effect";
import type { EffectSqlTable } from "effect-sql-schema";
import type { EffectZeroTable, RelationshipDefinition, RelationshipStep } from "./types";

type RelationshipTable = EffectZeroTable | EffectSqlTable;

type RelationshipFields = {
  readonly source: readonly string[];
  readonly dest: readonly string[];
};

type ManyToManyStep = {
  readonly dest: RelationshipTable;
  readonly source: readonly string[];
  readonly destField: readonly string[];
};

const tableName = (table: RelationshipTable): string =>
  "sqlName" in table ? table.sqlName : table.name;

const isManyToManySteps = (
  value: RelationshipFields | readonly [ManyToManyStep, ...ManyToManyStep[]],
): value is readonly [ManyToManyStep, ...ManyToManyStep[]] => Array.isArray(value);

const RelationshipStepSchema = Schema.Struct({
  sourceField: Schema.Array(Schema.String),
  destField: Schema.Array(Schema.String),
  destSchema: Schema.String,
  cardinality: Schema.Literal("many"),
});

const RelationshipDefinitionSchema = Schema.NonEmptyArray(RelationshipStepSchema);

export const one = (
  dest: RelationshipTable,
  fields: RelationshipFields,
): RelationshipDefinition => [
  {
    sourceField: fields.source,
    destField: fields.dest,
    destSchema: tableName(dest),
    cardinality: "one",
  },
];

export function many(dest: RelationshipTable, fields: RelationshipFields): RelationshipDefinition;
export function many(
  dest: RelationshipTable,
  steps: readonly [ManyToManyStep, ...ManyToManyStep[]],
): RelationshipDefinition;
export function many(
  dest: RelationshipTable,
  fieldsOrSteps: RelationshipFields | readonly [ManyToManyStep, ...ManyToManyStep[]],
): RelationshipDefinition {
  if (isManyToManySteps(fieldsOrSteps)) {
    const steps = fieldsOrSteps.map(
      (step): RelationshipStep => ({
        sourceField: step.source,
        destField: step.destField,
        destSchema: tableName(step.dest),
        cardinality: "many",
      }),
    );
    return Schema.decodeUnknownSync(RelationshipDefinitionSchema)(steps) as RelationshipDefinition;
  }

  return [
    {
      sourceField: fieldsOrSteps.source,
      destField: fieldsOrSteps.dest,
      destSchema: tableName(dest),
      cardinality: "many",
    },
  ];
}
