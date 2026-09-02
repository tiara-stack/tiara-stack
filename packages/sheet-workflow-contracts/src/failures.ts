import { Schema } from "effect";

export const AuthorizationRevoked = Schema.TaggedStruct("AuthorizationRevoked", {
  policy: Schema.String,
});
export type AuthorizationRevoked = Schema.Schema.Type<typeof AuthorizationRevoked>;

export const InvalidRequest = Schema.TaggedStruct("InvalidRequest", {
  code: Schema.String,
  message: Schema.String,
});
export type InvalidRequest = Schema.Schema.Type<typeof InvalidRequest>;

export const ResourceNotFound = Schema.TaggedStruct("ResourceNotFound", {
  resource: Schema.String,
  resourceId: Schema.optional(Schema.String),
});
export type ResourceNotFound = Schema.Schema.Type<typeof ResourceNotFound>;

export const ConfigurationMissing = Schema.TaggedStruct("ConfigurationMissing", {
  configuration: Schema.String,
});
export type ConfigurationMissing = Schema.Schema.Type<typeof ConfigurationMissing>;

export const BusinessRuleRejected = Schema.TaggedStruct("BusinessRuleRejected", {
  code: Schema.String,
  message: Schema.String,
});
export type BusinessRuleRejected = Schema.Schema.Type<typeof BusinessRuleRejected>;

export const ExternalOperationRejected = Schema.TaggedStruct("ExternalOperationRejected", {
  operation: Schema.String,
  code: Schema.String,
  message: Schema.String,
});
export type ExternalOperationRejected = Schema.Schema.Type<typeof ExternalOperationRejected>;

export const DeliveryRejected = Schema.TaggedStruct("DeliveryRejected", {
  operation: Schema.String,
  message: Schema.String,
  committedReference: Schema.optional(Schema.String),
  recoveryRequired: Schema.Boolean,
});
export type DeliveryRejected = Schema.Schema.Type<typeof DeliveryRejected>;

export const DataAcquisitionDeclaredFailure = Schema.Union([
  AuthorizationRevoked,
  ResourceNotFound,
  ConfigurationMissing,
  ExternalOperationRejected,
]);
export type DataAcquisitionDeclaredFailure = Schema.Schema.Type<
  typeof DataAcquisitionDeclaredFailure
>;

export const InteractiveDeclaredFailure = Schema.Union([
  AuthorizationRevoked,
  InvalidRequest,
  ResourceNotFound,
  ConfigurationMissing,
  BusinessRuleRejected,
  ExternalOperationRejected,
  DeliveryRejected,
]);
export type InteractiveDeclaredFailure = Schema.Schema.Type<typeof InteractiveDeclaredFailure>;

export const AutonomousDeclaredFailure = Schema.Union([
  AuthorizationRevoked,
  InvalidRequest,
  ResourceNotFound,
  ConfigurationMissing,
  BusinessRuleRejected,
  ExternalOperationRejected,
  DeliveryRejected,
]);
export type AutonomousDeclaredFailure = Schema.Schema.Type<typeof AutonomousDeclaredFailure>;

export const CalculationDeclaredFailure = Schema.Union([
  AuthorizationRevoked,
  InvalidRequest,
  ConfigurationMissing,
  BusinessRuleRejected,
  ExternalOperationRejected,
]);
export type CalculationDeclaredFailure = Schema.Schema.Type<typeof CalculationDeclaredFailure>;

export const SheetSnapshotDeclaredFailure = Schema.Union([
  AuthorizationRevoked,
  ResourceNotFound,
  ConfigurationMissing,
  InvalidRequest,
  ExternalOperationRejected,
]);
export type SheetSnapshotDeclaredFailure = Schema.Schema.Type<typeof SheetSnapshotDeclaredFailure>;
