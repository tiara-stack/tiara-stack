import { describe, expect, it } from "@effect/vitest";
import { HttpServerRequest } from "effect/unstable/http";
import { isHealthProbeRequest } from "./live";

describe("sheet bot HTTP authorization", () => {
  it("allows Kubernetes health probes without ingress authorization", () => {
    expect(
      isHealthProbeRequest(HttpServerRequest.fromWeb(new Request("http://localhost/live"))),
    ).toBe(true);
    expect(
      isHealthProbeRequest(HttpServerRequest.fromWeb(new Request("http://localhost/ready"))),
    ).toBe(true);
  });

  it("keeps non-health routes protected", () => {
    expect(
      isHealthProbeRequest(HttpServerRequest.fromWeb(new Request("http://localhost/application"))),
    ).toBe(false);
    expect(
      isHealthProbeRequest(
        HttpServerRequest.fromWeb(new Request("http://localhost/live", { method: "POST" })),
      ),
    ).toBe(false);
  });
});
