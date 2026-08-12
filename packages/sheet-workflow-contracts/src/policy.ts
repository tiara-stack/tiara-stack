import { Schema } from "effect";
import {
  defineWorkflowContract,
  type WorkflowContract,
  type WorkflowAuthorizationPolicyMetadata,
  type WorkflowContractSchema,
} from "effect-zero-workflow/contract";

export const SheetWorkflowPrincipalKind = Schema.Literals(["user", "service"]);
export type SheetWorkflowPrincipalKind = Schema.Schema.Type<typeof SheetWorkflowPrincipalKind>;

export const SheetWorkflowCapability = Schema.Literals([
  "self",
  "workspace.member",
  "workspace.monitor",
  "workspace.manage",
  "workspace.participant",
  "application.owner",
  "service.allowed",
]);
export type SheetWorkflowCapability = Schema.Schema.Type<typeof SheetWorkflowCapability>;

export const SheetWorkflowAuthorizationResource = Schema.Literals([
  "self",
  "workspace",
  "message",
  "submission",
  "spreadsheet",
  "system",
]);
export type SheetWorkflowAuthorizationResource = Schema.Schema.Type<
  typeof SheetWorkflowAuthorizationResource
>;

export const SheetWorkflowUserRule = Schema.Literal(
  "target-user-or-workspace-monitor-or-application-owner",
);
export type SheetWorkflowUserRule = Schema.Schema.Type<typeof SheetWorkflowUserRule>;

export const SheetWorkflowAuthorizationPolicyMetadata = Schema.Struct({
  policy: Schema.Trimmed.check(Schema.isNonEmpty()),
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  principalKinds: Schema.Array(SheetWorkflowPrincipalKind).check(Schema.isLengthBetween(1, 2)),
  requiredCapabilities: Schema.Array(SheetWorkflowCapability),
  resource: SheetWorkflowAuthorizationResource,
  resourceField: Schema.optionalKey(Schema.Trimmed.check(Schema.isNonEmpty())),
  serviceRule: Schema.optionalKey(Schema.Trimmed.check(Schema.isNonEmpty())),
  targetUserField: Schema.optionalKey(Schema.Trimmed.check(Schema.isNonEmpty())),
  userRule: Schema.optionalKey(SheetWorkflowUserRule),
  revalidateBeforeEffects: Schema.Boolean,
});
export interface SheetWorkflowAuthorizationPolicyMetadata extends WorkflowAuthorizationPolicyMetadata {
  readonly policy: string;
  readonly version: string;
  readonly principalKinds: ReadonlyArray<SheetWorkflowPrincipalKind>;
  readonly requiredCapabilities: ReadonlyArray<SheetWorkflowCapability>;
  readonly resource: SheetWorkflowAuthorizationResource;
  readonly resourceField?: string;
  readonly serviceRule?: string;
  readonly targetUserField?: string;
  readonly userRule?: SheetWorkflowUserRule;
  readonly revalidateBeforeEffects: boolean;
}

type SheetWorkflowAuthorizationPolicyMetadataFields = Pick<
  SheetWorkflowAuthorizationPolicyMetadata,
  | "policy"
  | "version"
  | "principalKinds"
  | "requiredCapabilities"
  | "resource"
  | "resourceField"
  | "serviceRule"
  | "targetUserField"
  | "userRule"
  | "revalidateBeforeEffects"
>;
type SheetWorkflowAuthorizationPolicyMetadataSchema = Schema.Schema.Type<
  typeof SheetWorkflowAuthorizationPolicyMetadata
>;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type HasSameKeys<Left, Right> = [Exclude<keyof Left, keyof Right>] extends [never]
  ? [Exclude<keyof Right, keyof Left>] extends [never]
    ? true
    : false
  : false;
type IsExact<Left, Right> =
  IsAssignable<Left, Right> extends true
    ? IsAssignable<Right, Left> extends true
      ? HasSameKeys<Left, Right>
      : false
    : false;
type AssertTrue<Condition extends true> = Condition;
type AssertFalse<Condition extends false> = Condition;

export type _SheetWorkflowAuthorizationPolicyMetadataDriftGuard = AssertTrue<
  IsExact<
    SheetWorkflowAuthorizationPolicyMetadataFields,
    SheetWorkflowAuthorizationPolicyMetadataSchema
  >
>;

export type _SheetWorkflowAuthorizationPolicyMetadataDriftGuardNegativeTests = [
  AssertFalse<
    IsExact<
      Omit<SheetWorkflowAuthorizationPolicyMetadataFields, "resourceField">,
      SheetWorkflowAuthorizationPolicyMetadataSchema
    >
  >,
  AssertFalse<
    IsExact<
      SheetWorkflowAuthorizationPolicyMetadataFields,
      Omit<SheetWorkflowAuthorizationPolicyMetadataSchema, "resourceField">
    >
  >,
  AssertFalse<
    IsExact<
      Omit<SheetWorkflowAuthorizationPolicyMetadataFields, "serviceRule">,
      SheetWorkflowAuthorizationPolicyMetadataSchema
    >
  >,
  AssertFalse<
    IsExact<
      SheetWorkflowAuthorizationPolicyMetadataFields,
      Omit<SheetWorkflowAuthorizationPolicyMetadataSchema, "serviceRule">
    >
  >,
  AssertFalse<
    IsExact<
      Omit<SheetWorkflowAuthorizationPolicyMetadataFields, "userRule">,
      SheetWorkflowAuthorizationPolicyMetadataSchema
    >
  >,
  AssertFalse<
    IsExact<
      SheetWorkflowAuthorizationPolicyMetadataFields,
      Omit<SheetWorkflowAuthorizationPolicyMetadataSchema, "userRule">
    >
  >,
  AssertFalse<
    IsExact<
      Omit<SheetWorkflowAuthorizationPolicyMetadataFields, "targetUserField">,
      SheetWorkflowAuthorizationPolicyMetadataSchema
    >
  >,
  AssertFalse<
    IsExact<
      SheetWorkflowAuthorizationPolicyMetadataFields,
      Omit<SheetWorkflowAuthorizationPolicyMetadataSchema, "targetUserField">
    >
  >,
];

export const defineSheetWorkflowContract = <
  const Identity extends string,
  const WireVersion extends string,
  Input extends WorkflowContractSchema,
  Success extends WorkflowContractSchema,
  DeclaredFailure extends WorkflowContractSchema,
  const AuthorizationPolicy extends SheetWorkflowAuthorizationPolicyMetadata,
>(options: {
  readonly identity: Identity;
  readonly wireVersion: WireVersion;
  readonly input: Input;
  readonly success: Success;
  readonly declaredFailure: DeclaredFailure;
  readonly authorizationPolicy: AuthorizationPolicy;
}): WorkflowContract<
  Identity,
  WireVersion,
  Input,
  Success,
  DeclaredFailure,
  AuthorizationPolicy
> => {
  Schema.decodeUnknownSync(SheetWorkflowAuthorizationPolicyMetadata)(options.authorizationPolicy);
  return defineWorkflowContract(options);
};
