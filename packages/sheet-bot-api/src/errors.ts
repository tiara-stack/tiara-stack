import { Schema } from "effect";

const ResourceFields = {
  resource: Schema.String,
  message: Schema.String,
};

export class BotUnauthenticated extends Schema.TaggedErrorClass<BotUnauthenticated>()(
  "BotUnauthenticated",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class BotAdmissionDenied extends Schema.TaggedErrorClass<BotAdmissionDenied>()(
  "BotAdmissionDenied",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class BotResourceNotFound extends Schema.TaggedErrorClass<BotResourceNotFound>()(
  "BotResourceNotFound",
  ResourceFields,
  { httpApiStatus: 404 },
) {}

export class BotResponseExpired extends Schema.TaggedErrorClass<BotResponseExpired>()(
  "BotResponseExpired",
  { message: Schema.String },
  { httpApiStatus: 410 },
) {}

export class BotRequestRejected extends Schema.TaggedErrorClass<BotRequestRejected>()(
  "BotRequestRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export class BotRateLimited extends Schema.TaggedErrorClass<BotRateLimited>()(
  "BotRateLimited",
  {
    message: Schema.String,
    retryAfterMs: Schema.optional(
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    ),
  },
  { httpApiStatus: 429 },
) {}

export class BotDependencyUnavailable extends Schema.TaggedErrorClass<BotDependencyUnavailable>()(
  "BotDependencyUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const BotCacheReadErrors = [
  BotUnauthenticated,
  BotAdmissionDenied,
  BotResourceNotFound,
  BotRequestRejected,
  BotDependencyUnavailable,
] as const;

export const BotDeliveryErrors = [
  BotUnauthenticated,
  BotAdmissionDenied,
  BotResourceNotFound,
  BotResponseExpired,
  BotRequestRejected,
  BotRateLimited,
  BotDependencyUnavailable,
] as const;
