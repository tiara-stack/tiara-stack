import { DateTime, Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { ServicesStatusResponse } from "./schema";

describe("ServicesStatusResponse", () => {
  it("decodes omitted service errors as null", () => {
    const decoded = Schema.decodeUnknownSync(ServicesStatusResponse)({
      overallStatus: "ok",
      checkedAt: Date.now(),
      services: [
        {
          name: "sheet-apis",
          url: "http://sheet-apis-service:3000/ready",
          status: "ok",
          httpStatus: 200,
          latencyMs: 3,
          checkedAt: Date.now(),
        },
      ],
    });

    expect(decoded.services).toHaveLength(1);
    expect(decoded.services[0]!.error).toBe(null);
  });

  it("encodes undefined service errors without failing", () => {
    const checkedAt = Effect.runSync(DateTime.now);
    const response: typeof ServicesStatusResponse.Type = {
      overallStatus: "ok",
      checkedAt,
      services: [
        {
          name: "sheet-apis",
          url: "http://sheet-apis-service:3000/ready",
          status: "ok",
          httpStatus: 200,
          latencyMs: 3,
          checkedAt,
          error: undefined,
        },
      ],
    };

    const encoded = Schema.encodeUnknownSync(ServicesStatusResponse)(response);

    expect(encoded.services).toHaveLength(1);
    expect(encoded.services[0]!.error).toBeUndefined();
  });
});
