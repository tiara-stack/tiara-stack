import { describe, expect, it } from "@effect/vitest";
import type { ServicesStatusResponse } from "sheet-ingress-api/sheet-apis-rpc";
import { normalizeServicesStatusResponse } from "./statusResponse";

describe("normalizeServicesStatusResponse", () => {
  const makeResponse = (services: ReadonlyArray<unknown>) =>
    ({
      overallStatus: "ok",
      checkedAt: new Date(),
      services,
    }) as unknown as ServicesStatusResponse;

  const makeService = (
    service: Partial<ServicesStatusResponse["services"][number]> & {
      readonly name: string;
      readonly error?: string | null | undefined;
    },
  ) => ({
    url: `http://${service.name}-service:3000/ready`,
    status: "ok" as const,
    httpStatus: 200,
    latencyMs: 3,
    checkedAt: new Date(),
    ...service,
  });

  it("normalizes omitted service errors to null before ingress response encoding", () => {
    const response = makeResponse([makeService({ name: "sheet-apis" })]);

    expect(normalizeServicesStatusResponse(response).services[0]!.error).toBe(null);
  });

  it("preserves null service errors", () => {
    const response = makeResponse([makeService({ name: "sheet-apis", error: null })]);

    expect(normalizeServicesStatusResponse(response).services[0]!.error).toBe(null);
  });

  it("preserves string service errors", () => {
    const response = makeResponse([makeService({ name: "sheet-apis", error: "some error" })]);

    expect(normalizeServicesStatusResponse(response).services[0]!.error).toBe("some error");
  });

  it("normalizes mixed service errors independently", () => {
    const response = makeResponse([
      makeService({ name: "sheet-apis" }),
      makeService({ name: "sheet-auth", error: "some error" }),
      makeService({ name: "sheet-bot", error: null }),
    ]);

    const normalized = normalizeServicesStatusResponse(response);

    expect(normalized.services[0]!.error).toBe(null);
    expect(normalized.services[1]!.error).toBe("some error");
    expect(normalized.services[2]!.error).toBe(null);
  });
});
